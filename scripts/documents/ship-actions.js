/**
 * Все изменения корабля. Функции этого файла выполняются только на клиенте ГМа:
 * игрок попадает сюда через socket.js → runPlayerAction с проверкой прав и членства в экипаже.
 * Запись в журнал идёт в том же обновлении актора, что и само изменение.
 */
import { MODULE_ID, SHIP_TYPE, COMPARTMENT_TYPE, LOG_LIMIT, DISTANCES, CONDITIONS, localize, format, localPack } from "../constants.js";
import {
  checkPlacement, findFreePosition, computeStats, clampGridSize, isDestroyed, planStarterKit, hasCondition,
  needsRecalc, resolveHit, resolveUndoHit
} from "../rules/ship-rules.js";
import { fitsGrid } from "../rules/inventory-rules.js";
import { userHasRight } from "../settings.js";
import { emitHook } from "../socket.js";

/* ---------------- Поиск и проверки ---------------- */

export function isShip(document) {
  return document?.documentName === "Actor" && document.type === SHIP_TYPE;
}

/** Принимает актора или его UUID. */
export function getShip(shipOrUuid) {
  const ship = typeof shipOrUuid === "string" ? fromUuidSync(shipOrUuid) : shipOrUuid;
  return isShip(ship) ? ship : null;
}

export function getCompartment(ship, instanceId) {
  return ship.system.compartments.find((compartment) => compartment.instanceId === instanceId) ?? null;
}

/** Акторы экипажа, которыми владеет пользователь. */
export function ownedCrewActors(user, ship) {
  return ship.system.crew
    .map((member) => fromUuidSync(member.actorUuid))
    .filter((actor) => actor?.testUserPermission?.(user, "OWNER"));
}

/** Право из матрицы действует только на кораблях, где есть персонаж игрока. */
export function canUser(user, ship, right) {
  if (user.isGM) return true;
  return userHasRight(user, right) && ownedCrewActors(user, ship).length > 0;
}

function denied(key = "notify.denied", data = {}) {
  return { ok: false, reason: { key, data } };
}

function requireGM() {
  if (game.user.isGM) return true;
  ui.notifications.warn(localize("notify.gmOnly"));
  return false;
}

/* ---------------- Журнал ---------------- */

export function logEntry(type, text, user = game.user) {
  return { time: Date.now(), userId: user.id, type, text };
}

export function appendLog(ship, update, entries) {
  if (!entries.length) return update;
  const log = ship.getFlag(MODULE_ID, "log") ?? [];
  update[`flags.${MODULE_ID}.log`] = [...log, ...entries].slice(-LOG_LIMIT);
  return update;
}

export function getLog(ship) {
  return ship.getFlag(MODULE_ID, "log") ?? [];
}

/* ---------------- Общие расчёты ---------------- */

/**
 * Характеристики из правил. Текущая прочность не превышает максимум; растёт вместе с ним
 * только при изменении конструкции (growCurrent) — ремонт и эффекты отсеков HP корабля не меняют.
 */
function statsUpdate(ship, compartments, { growCurrent = false } = {}) {
  const stats = computeStats(compartments);
  const { currentHp, maxHp } = ship.system;
  let newCurrentHp = Math.min(currentHp, stats.maxHp);
  if (growCurrent && stats.maxHp > maxHp) newCurrentHp = Math.min(stats.maxHp, currentHp + stats.maxHp - maxHp);
  return {
    "system.maxHp": stats.maxHp,
    "system.currentHp": newCurrentHp,
    "system.maxCrew": stats.maxCrew,
    "system.speed": stats.speed,
    "system.fuelEconomy": stats.fuelEconomy
  };
}

/** Активные эффекты предмета каталога в виде данных отсека корабля. */
function effectCopies(item) {
  return (item.effects ?? []).map((effect) => ({
    name: effect.name,
    img: effect.img ?? "",
    disabled: !!effect.disabled,
    changes: effect.changes.map((change) => ({ key: change.key, mode: change.mode, value: String(change.value), priority: change.priority ?? null }))
  }));
}

export function buildPlacedCompartment(item, x, y) {
  const source = item.system.toObject();
  delete source.description;
  return {
    ...source,
    effects: effectCopies(item),
    instanceId: foundry.utils.randomID(),
    sourceUuid: item.uuid,
    name: item.name,
    description: item.system.description ?? "",
    x,
    y,
    currentHp: source.hp,
    maxHp: source.hp,
    passageUp: false,
    passageDown: false,
    effectActive: true,
    inventory: []
  };
}

/**
 * Одна запись корабля: новые отсеки и/или прочность вместе с журналом. Строки об уроне и лечении прочности,
 * «Выведен из строя», разрушении и восстановлении отсеков добавляются сами; характеристики пересчитываются,
 * если отсек перестал или снова начал работать либо сменились состояния. Хуки — после записи.
 */
async function writeShip(ship, { compartments = null, hull = null, update = {}, entries = [] }, user) {
  const result = { ...update };
  const logEntries = [...entries];
  const oldHull = ship.system.currentHp;
  let newHull = hull == null || !Number.isFinite(Number(hull)) ? null : Math.max(0, Math.round(hull));
  const destroyed = [];
  const restored = [];
  if (compartments) {
    const before = ship.system.compartments;
    result["system.compartments"] = compartments;
    if (needsRecalc(before, compartments)) {
      Object.assign(result, statsUpdate(ship, compartments));
      newHull = Math.min(newHull ?? oldHull, result["system.maxHp"]);
    }
    for (const compartment of compartments) {
      const old = before.find((entry) => entry.instanceId === compartment.instanceId);
      if (!old || isDestroyed(old) === isDestroyed(compartment)) continue;
      const key = isDestroyed(compartment) ? "destroyed" : "restored";
      (key === "destroyed" ? destroyed : restored).push(compartment);
      logEntries.push(logEntry(key, format(`log.compartment.${key}`, { name: compartment.name }), user));
    }
  }
  if (newHull != null) {
    result["system.currentHp"] = newHull;
    if (newHull !== oldHull) {
      const type = newHull < oldHull ? "damage" : "heal";
      logEntries.push(logEntry(type, format(`log.ship.${type}`, { amount: Math.abs(newHull - oldHull), value: newHull }), user));
    }
  }
  const becameDisabled = newHull != null && oldHull > 0 && newHull <= 0;
  if (becameDisabled) logEntries.push(logEntry("disabled", localize("log.ship.disabled"), user));
  await ship.update(appendLog(ship, result, logEntries));
  if (becameDisabled) emitHook("shipDisabled", ship);
  for (const compartment of destroyed) emitHook("compartmentDestroyed", ship, compartment);
  for (const compartment of restored) emitHook("compartmentRestored", ship, compartment);
}

/**
 * Новое HP отсека (и, если нужно, его состояния) одной записью. Без своих строк журнала пишет урон или лечение.
 * Возвращает обновлённый отсек или null.
 */
async function writeCompartmentHp(ship, instanceId, value, user, { entries = [], conditions = {} } = {}) {
  if (!Number.isFinite(Number(value))) return null;
  const compartments = ship.system.toObject().compartments;
  const compartment = compartments.find((entry) => entry.instanceId === instanceId);
  if (!compartment) return null;
  const oldValue = compartment.currentHp;
  compartment.currentHp = Math.max(0, Math.min(compartment.maxHp, Math.round(value)));
  const logEntries = [...entries];
  if (compartment.currentHp !== oldValue && !entries.length) {
    const type = compartment.currentHp < oldValue ? "damage" : "heal";
    logEntries.push(logEntry(type, format(`log.compartment.${type}`, {
      name: compartment.name, amount: Math.abs(compartment.currentHp - oldValue), value: compartment.currentHp, max: compartment.maxHp
    }), user));
  }
  logEntries.push(...toggleConditions(compartment, conditions, user));
  if (compartment.currentHp === oldValue && !logEntries.length) return compartment;
  await writeShip(ship, { compartments, entries: logEntries }, user);
  return compartment;
}

/* ---------------- Действия, доступные игрокам по матрице ---------------- */

const PARAM_FIELDS = {
  name: "name",
  img: "img",
  shipClass: "system.shipClass",
  captainUuid: "system.captainUuid",
  currentHp: "system.currentHp",
  maxHp: "system.maxHp",
  maxCrew: "system.maxCrew",
  speed: "system.speed",
  fuelEconomy: "system.fuelEconomy",
  description: "system.description"
};
const NUMERIC_PARAMS = ["currentHp", "maxHp", "maxCrew", "speed", "fuelEconomy"];

async function updateParams(ship, { changes, recalc = false }, user) {
  changes = changes && typeof changes === "object" ? changes : {};
  if (recalc) {
    await ship.update(statsUpdate(ship, ship.system.compartments));
    return { ok: true };
  }
  const update = {};
  const entries = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!(key in PARAM_FIELDS)) continue;
    if (NUMERIC_PARAMS.includes(key)) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) return denied("notify.invalidNumber");
      update[PARAM_FIELDS[key]] = Math.round(number);
    } else if (key === "description") {
      // HTML от игрока чистится на клиенте ГМа: это граница доверия.
      update[PARAM_FIELDS[key]] = foundry.utils.cleanHTML(String(value ?? ""));
    } else {
      update[PARAM_FIELDS[key]] = String(value ?? "");
    }
  }
  if ("name" in update && !update.name.trim()) delete update.name;
  if ("img" in update && !update.img.trim()) delete update.img;
  if ("img" in update) update["prototypeToken.texture.src"] = update.img;
  if ("system.captainUuid" in update) {
    const captainUuid = update["system.captainUuid"];
    if (captainUuid && !ship.system.crew.some((member) => member.actorUuid === captainUuid)) return denied("notify.captainNotInCrew");
    const captainName = fromUuidSync(captainUuid)?.name ?? localize("crew.noCaptain");
    entries.push(logEntry("crew", format("log.crew.captain", { name: captainName }), user));
  }
  const maxHp = update["system.maxHp"] ?? ship.system.maxHp;
  const currentHp = Math.min(update["system.currentHp"] ?? ship.system.currentHp, maxHp);
  delete update["system.currentHp"];
  if (currentHp !== ship.system.currentHp) {
    await writeShip(ship, { hull: currentHp, update, entries }, user);
    return { ok: true };
  }
  await ship.update(appendLog(ship, update, entries));
  return { ok: true };
}

async function findCatalogItem(sourceUuid) {
  const item = await fromUuid(sourceUuid);
  return item?.type === COMPARTMENT_TYPE ? item : null;
}

async function findCatalogItemById(catalogId) {
  const pack = game.packs.get(localPack("compartments"));
  const worldItem = game.items.find((item) => item.type === COMPARTMENT_TYPE && item.system.catalogId === catalogId);
  if (worldItem) return worldItem;
  const index = await pack?.getIndex({ fields: ["system.catalogId"] });
  const entry = index?.find((indexEntry) => indexEntry.system?.catalogId === catalogId);
  return entry ? pack.getDocument(entry._id) : null;
}

/**
 * Отмена в конструкторе (Ctrl+Z). Стек живёт на клиенте ГМа, который выполняет действия, — по кораблю и пользователю.
 * В стек кладётся обратная операция, а не снимок: урон и ремонт, сделанные между шагами, не откатываются.
 */
const UNDO_LIMIT = 50;
const undoStacks = new Map();
/** Операции, которые приходят только из стека отмены: игрок не может прислать их сам. */
const INTERNAL_OPS = ["restore", "removeMany"];

function undoStack(ship, user) {
  const key = `${ship.uuid}|${user.id}`;
  if (!undoStacks.has(key)) undoStacks.set(key, []);
  return undoStacks.get(key);
}

async function buildAction(ship, payload, user, { fromUndo = false } = {}) {
  if (payload.op === "undo") {
    const inverse = undoStack(ship, user).pop();
    if (!inverse) return denied("notify.nothingToUndo");
    const result = await buildAction(ship, inverse, user, { fromUndo: true });
    if (!result.ok) undoStack(ship, user).push(inverse);
    return result;
  }
  if (INTERNAL_OPS.includes(payload.op) && !fromUndo) return denied("notify.unknownAction");
  const { gridWidth, gridHeight } = ship.system;
  const compartments = foundry.utils.deepClone(ship.system.compartments);
  let entries = [];
  let structureChanged = true;
  let inverse = null;

  switch (payload.op) {
    case "add": {
      const item = await findCatalogItem(payload.sourceUuid);
      if (!item) return denied("notify.notCompartment");
      const placed = buildPlacedCompartment(item, 1, 1);
      const position = payload.x == null
        ? findFreePosition(placed, compartments, gridWidth, gridHeight)
        : { x: payload.x, y: payload.y };
      if (!position) return denied("rules.noSpace", { name: placed.name });
      Object.assign(placed, position);
      const check = checkPlacement(placed, compartments, gridWidth, gridHeight);
      if (!check.ok) return denied(check.reason.key, check.reason.data);
      compartments.push(placed);
      entries.push(logEntry("build", format("log.build.add", { name: placed.name, x: placed.x, y: placed.y }), user));
      inverse = { op: "remove", instanceId: placed.instanceId };
      break;
    }
    case "move": {
      const compartment = compartments.find((entry) => entry.instanceId === payload.instanceId);
      if (!compartment) return denied("notify.notFound");
      const check = checkPlacement({ ...compartment, x: payload.x, y: payload.y }, compartments, gridWidth, gridHeight);
      if (!check.ok) return denied(check.reason.key, check.reason.data);
      if (compartment.x === payload.x && compartment.y === payload.y) return { ok: true };
      inverse = { op: "move", instanceId: compartment.instanceId, x: compartment.x, y: compartment.y };
      compartment.x = payload.x;
      compartment.y = payload.y;
      entries.push(logEntry("build", format("log.build.move", { name: compartment.name, x: payload.x, y: payload.y }), user));
      break;
    }
    case "remove": {
      const index = compartments.findIndex((entry) => entry.instanceId === payload.instanceId);
      if (index < 0) return denied("notify.notFound");
      // Отмена не удаляет отсек с вещами молча: подтверждение есть только у кнопки «Удалить».
      if (fromUndo && compartments[index].inventory?.length) return denied("inventory.undoBlocked", { name: compartments[index].name });
      const [removed] = compartments.splice(index, 1);
      entries.push(logEntry("build", format("log.build.remove", { name: removed.name }), user));
      inverse = { op: "restore", compartment: removed };
      break;
    }
    case "restore": {
      const restored = payload.compartment;
      if (compartments.some((entry) => entry.instanceId === restored.instanceId)) return denied("notify.unknownAction");
      const check = checkPlacement(restored, compartments, gridWidth, gridHeight);
      if (!check.ok) return denied(check.reason.key, check.reason.data);
      compartments.push(restored);
      entries.push(logEntry("build", format("log.build.add", { name: restored.name, x: restored.x, y: restored.y }), user));
      inverse = { op: "remove", instanceId: restored.instanceId };
      break;
    }
    case "removeMany": {
      const removed = compartments.filter((entry) => payload.instanceIds.includes(entry.instanceId));
      if (!removed.length) return denied("notify.notFound");
      const filled = removed.find((entry) => entry.inventory?.length);
      if (filled) return denied("inventory.undoBlocked", { name: filled.name });
      for (const entry of removed) compartments.splice(compartments.indexOf(entry), 1);
      entries.push(logEntry("build", format("log.build.removeMany", { count: removed.length }), user));
      break;
    }
    case "resize": {
      const size = clampGridSize(payload.width, payload.height);
      if (!size) return denied("notify.invalidNumber");
      const outside = compartments.find((entry) => entry.x + entry.width - 1 > size.width || entry.y + entry.height - 1 > size.height);
      if (outside) return denied("rules.resizeBlocked", { name: outside.name });
      if (!fromUndo) pushUndo(ship, user, { op: "resize", width: gridWidth, height: gridHeight });
      await ship.update(appendLog(ship, { "system.gridWidth": size.width, "system.gridHeight": size.height }, [
        logEntry("build", format("log.build.resize", size), user)
      ]));
      return { ok: true };
    }
    case "starterKit": {
      const [stairs, cargo, cabin] = await Promise.all(["stairs_vert", "cargo_hold", "cabin_crew"].map(findCatalogItemById));
      if (!stairs || !cargo || !cabin) return denied("notify.kitMissing");
      const definitions = new Map([[stairs.id, stairs], [cargo.id, cargo], [cabin.id, cabin]]);
      const toDefinition = (item) => ({ ...buildPlacedCompartment(item, 1, 1), itemId: item.id });
      const playerCount = game.users.filter((entry) => !entry.isGM).length;
      const plan = planStarterKit(
        { stairs: toDefinition(stairs), cargo: toDefinition(cargo), cabin: toDefinition(cabin) },
        playerCount, compartments, gridWidth, gridHeight
      );
      const added = plan.placed.map(({ definition, x, y }) => buildPlacedCompartment(definitions.get(definition.itemId), x, y));
      compartments.push(...added);
      entries.push(logEntry("build", format("log.build.kit", { count: plan.placed.length }), user));
      inverse = { op: "removeMany", instanceIds: added.map((entry) => entry.instanceId) };
      if (plan.skipped.length) ui.notifications.warn(format("notify.kitSkipped", { names: plan.skipped.join(", ") }));
      break;
    }
    default:
      structureChanged = false;
  }
  if (!structureChanged) return denied("notify.unknownAction");
  if (fromUndo) entries = entries.map((entry) => ({ ...entry, text: format("log.build.undo", { text: entry.text }) }));
  await ship.update(appendLog(ship, { "system.compartments": compartments, ...statsUpdate(ship, compartments, { growCurrent: true }) }, entries));
  if (inverse && !fromUndo) pushUndo(ship, user, inverse);
  return { ok: true, undone: fromUndo };
}

function pushUndo(ship, user, inverse) {
  const stack = undoStack(ship, user);
  stack.push(inverse);
  if (stack.length > UNDO_LIMIT) stack.shift();
}

async function repairCompartment(ship, { instanceId, itemUuid, amount }, user) {
  const compartment = getCompartment(ship, instanceId);
  if (!compartment) return denied("notify.notFound");
  if (compartment.isNoHp) return denied("notify.noHpCompartment");

  if (!itemUuid) {
    if (!user.isGM) return denied();
    const updated = await writeCompartmentHp(ship, instanceId, compartment.currentHp + Math.abs(Number(amount) || 0), user);
    const restored = updated.currentHp - compartment.currentHp;
    if (restored > 0) emitHook("compartmentRepaired", ship, updated, restored, null);
    return { ok: true, amount: restored, name: compartment.name };
  }

  const item = await fromUuid(itemUuid);
  const owner = item?.parent;
  const baseAmount = Number(item?.getFlag(MODULE_ID, "repair")?.amount ?? 0);
  if (!item || !baseAmount) return denied("notify.notRepairItem");
  // Бонус ремонта от эффектов отсеков (мастерская и т. п.).
  const repairAmount = Math.max(0, baseAmount + (ship.system.bonuses?.repair ?? 0));
  const inCrew = owner && ship.system.crew.some((member) => member.actorUuid === owner.uuid);
  if (!inCrew || !owner.testUserPermission(user, "OWNER")) return denied("notify.notYourItem");
  const quantity = item.system.quantity ?? 1;
  if (quantity < 1) return denied("notify.notRepairItem");
  if (compartment.currentHp >= compartment.maxHp) return denied("notify.alreadyRepaired");

  const newHp = Math.min(compartment.maxHp, compartment.currentHp + repairAmount);
  const restored = newHp - compartment.currentHp;
  const entry = logEntry("repair", format("log.compartment.repair", {
    name: compartment.name, actor: owner.name, item: item.name, amount: restored
  }), user);
  const itemData = item.toObject();
  // Удачный ремонт расходником заодно заделывает пробоину.
  const updated = await writeCompartmentHp(ship, instanceId, newHp, user, { entries: [entry], conditions: { breach: false } });
  if (quantity <= 1) await item.delete();
  else await item.update({ "system.quantity": quantity - 1 });
  emitHook("compartmentRepaired", ship, updated, restored, itemData);
  return { ok: true, amount: restored, name: compartment.name };
}

/** Битвы, где корабль участвует: дистанция общая для пары. */
export function battleOpponents(ship) {
  const opponents = [];
  for (const scene of game.scenes) {
    const layout = scene.getFlag(MODULE_ID, "layout");
    if (layout?.mode !== "battle") continue;
    const uuids = [layout.sides?.left?.actorUuid, layout.sides?.right?.actorUuid];
    if (!uuids.includes(ship.uuid)) continue;
    const opponent = getShip(uuids.find((uuid) => uuid !== ship.uuid));
    if (opponent && !opponents.includes(opponent)) opponents.push(opponent);
  }
  return opponents;
}

async function setPhlogiston(ship, { value }, user) {
  const phlogiston = Math.round(Number(value));
  if (!(phlogiston >= 0 && phlogiston <= 5)) return denied("notify.invalidNumber");
  if (phlogiston === ship.system.phlogiston) return { ok: true };
  const label = phlogiston === 0 ? "!" : String(phlogiston);
  await ship.update(appendLog(ship, { "system.phlogiston": phlogiston }, [
    logEntry("phlogiston", format("log.phlogiston", { value: label }), user)
  ]));
  return { ok: true };
}

async function setDistance(ship, { value }, user) {
  if (!DISTANCES.includes(value)) return denied("notify.invalidNumber");
  const label = localize(`distance.${value}.label`);
  for (const target of [ship, ...battleOpponents(ship)]) {
    if (target.system.combatDistance === value) continue;
    await target.update(appendLog(target, { "system.combatDistance": value }, [
      logEntry("distance", format("log.distance", { value: label }), user)
    ]));
  }
  return { ok: true };
}

/**
 * Попадание по кораблю: урон уходит и в прочность корабля, и в HP выбранного отсека
 * («Без прочности» — только в прочность). Запись в журнал цели идёт вместе с изменением отсека.
 * splash (огнемёт): соседние по стороне отсеки получают половину урона — только в свои HP, не в прочность.
 */
export async function applyHit(ship, instanceId, amount, user, logText, { splash = false, conditions = [] } = {}) {
  amount = Math.max(0, Math.round(Number(amount) || 0));
  // Огнемёт поджигает цель, критическое попадание пробивает её; расчёт — в правилах, здесь одна запись и хуки.
  const hit = resolveHit({ compartments: ship.system.toObject().compartments, hull: ship.system.currentHp }, instanceId, amount, {
    splash, conditions: conditions.filter((condition) => CONDITIONS.includes(condition))
  });
  const find = (id) => hit.compartments.find((compartment) => compartment.instanceId === id);
  const target = find(instanceId);
  const entries = [
    logEntry("attack", logText, user),
    ...hit.lost.conditions.map((condition) => conditionEntry(target, condition, true, user)),
    ...hit.lost.splash.map(({ instanceId: id, amount: taken }) => logEntry("attack", format("log.combat.splash", { name: find(id).name, amount: taken }), user))
  ];
  await writeShip(ship, { compartments: hit.compartments, hull: hit.hull, entries }, user);
  emitHook("compartmentHit", ship, target ?? null, amount);
  for (const { instanceId: id, amount: taken } of hit.lost.splash) emitHook("compartmentHit", ship, find(id), taken);
  return hit.lost;
}

/** Отмена попадания: возвращает то, что попадание сняло с прочности, отсека и соседей, и снимает его состояния. */
export async function undoHit(ship, instanceId, lost, logText) {
  if (!requireGM()) return;
  lost ??= {};
  const removed = (lost.conditions ?? []).filter((condition) => hasCondition(getCompartment(ship, instanceId) ?? {}, condition));
  const undo = resolveUndoHit({ compartments: ship.system.toObject().compartments, hull: ship.system.currentHp, maxHull: ship.system.maxHp }, instanceId, lost);
  const find = (id) => undo.compartments.find((compartment) => compartment.instanceId === id);
  const target = find(instanceId);
  const entries = [logEntry("attack", logText), ...removed.map((condition) => conditionEntry(target, condition, false, game.user))];
  await writeShip(ship, { compartments: undo.compartments, hull: undo.hull, entries }, game.user);
  emitHook("compartmentHit", ship, target ?? null, -(lost.hull || lost.compartment));
  for (const { instanceId: id, amount } of lost.splash ?? []) {
    if (find(id) && amount > 0) emitHook("compartmentHit", ship, find(id), -amount);
  }
}

const PLAYER_ACTIONS = {
  updateParams: { right: "params", run: updateParams },
  buildAction: { right: "build", run: buildAction },
  repairCompartment: { right: "repair", run: repairCompartment },
  setPhlogiston: { right: "phlogiston", run: setPhlogiston },
  setDistance: { right: "phlogiston", run: setDistance },
  extinguish: { right: "repair", run: extinguish }
};

/** Модуль боя добавляет свои действия игроков (обстрел, разведка) с теми же проверками прав. */
export function registerPlayerAction(name, definition) {
  PLAYER_ACTIONS[name] = definition;
}

/**
 * Изменения кораблей на клиенте ГМа идут по одному: каждое читает корабль, дожидается своей записи
 * и только потом пускает следующее — два одновременных выстрела по одной цели не затирают друг друга.
 * ponytail: одна очередь на все корабли — действия короткие; очередь по кораблю, если станет узким местом.
 * Внутри задачи очереди serialized не вызывать: задача ждала бы саму себя.
 */
let actionQueue = Promise.resolve();

export function serialized(task) {
  const run = actionQueue.then(task);
  actionQueue = run.catch(() => {});
  return run;
}

/** Выполняется на клиенте ГМа: проверка права и членства в экипаже, затем действие — в общей очереди. */
export function runPlayerAction(name, shipUuid, payload, user) {
  return serialized(() => executePlayerAction(name, shipUuid, payload, user));
}

async function executePlayerAction(name, shipUuid, payload, user) {
  const definition = PLAYER_ACTIONS[name];
  const ship = getShip(await fromUuid(shipUuid));
  if (!definition || !ship) return denied("notify.unknownAction");
  // right: null — действие само проверяет присутствие токена (инвентарь, в том числе на вражеском корабле).
  if (definition.right && !canUser(user, ship, definition.right)) {
    console.warn(`${MODULE_ID} | ${user.name}: отказ в действии ${name} для ${ship.name}`);
    return denied();
  }
  try {
    return (await definition.run(ship, payload ?? {}, user)) ?? { ok: true };
  } catch (error) {
    console.error(`${MODULE_ID} | ${name}`, error);
    return denied("notify.actionFailed");
  }
}

/* ---------------- Действия только ГМа ---------------- */

/*
 * Прямые изменения ГМа идут через ту же очередь, что и действия игроков: каждое пишет массив отсеков целиком
 * и иначе затёрло бы инвентарь, положенный игроком в ту же секунду. Задачи очереди эти функции не вызывают.
 */
export function damageShip(ship, amount) {
  if (!requireGM()) return;
  return serialized(() => writeShip(ship, { hull: ship.system.currentHp - Math.abs(Number(amount) || 0) }, game.user));
}

export function healShip(ship, amount) {
  if (!requireGM()) return;
  return serialized(() => writeShip(ship, { hull: Math.min(ship.system.maxHp, ship.system.currentHp + Math.abs(Number(amount) || 0)) }, game.user));
}

export function setShipHp(ship, value) {
  if (!requireGM()) return;
  return serialized(() => writeShip(ship, { hull: Math.min(ship.system.maxHp, value) }, game.user));
}

export function damageCompartment(ship, instanceId, amount) {
  if (!requireGM()) return null;
  return serialized(() => {
    const compartment = getCompartment(ship, instanceId);
    if (!compartment) return null;
    return writeCompartmentHp(ship, instanceId, compartment.currentHp - Math.abs(Number(amount) || 0), game.user);
  });
}

export function setCompartmentHp(ship, instanceId, value) {
  if (!requireGM()) return null;
  return serialized(() => writeCompartmentHp(ship, instanceId, value, game.user));
}

/** Галочки ГМа: проходы вверх/вниз, «Узкий», включение эффекта. */
export function setCompartmentFlags(ship, instanceId, flags) {
  if (!requireGM()) return;
  return serialized(() => writeCompartmentFlags(ship, instanceId, flags));
}

async function writeCompartmentFlags(ship, instanceId, flags) {
  const compartments = foundry.utils.deepClone(ship.system.compartments);
  const compartment = compartments.find((entry) => entry.instanceId === instanceId);
  if (!compartment) return;
  for (const key of ["passageUp", "passageDown", "isNarrow", "effectActive"]) {
    if (key in flags) compartment[key] = !!flags[key];
  }
  let update = { "system.compartments": compartments };
  if ("effectActive" in flags) update = { ...update, ...statsUpdate(ship, compartments) };
  await ship.update(update);
}

/* ---------------- Состояния отсеков и боезапас ---------------- */

function conditionEntry(compartment, condition, active, user = game.user) {
  return logEntry("damage", format(active ? "log.condition.on" : "log.condition.off", {
    name: compartment.name, condition: localize(`condition.${condition}.label`)
  }), user);
}

/** Включает и выключает состояния отсека ({burning: true, smoke: false}) прямо в объекте; возвращает строки журнала. */
function toggleConditions(compartment, changes, user = game.user) {
  const entries = [];
  for (const [condition, active] of Object.entries(changes)) {
    if (!CONDITIONS.includes(condition) || active === compartment.conditions.includes(condition)) continue;
    compartment.conditions = active ? [...compartment.conditions, condition] : compartment.conditions.filter((entry) => entry !== condition);
    entries.push(conditionEntry(compartment, condition, active, user));
  }
  return entries;
}

/** Состояния одного отсека одной записью; пробоина меняет скорость — writeShip пересчитает характеристики. */
async function writeConditions(ship, instanceId, changes, user = game.user) {
  const compartments = ship.system.toObject().compartments;
  const compartment = compartments.find((entry) => entry.instanceId === instanceId);
  if (!compartment) return;
  const entries = toggleConditions(compartment, changes, user);
  if (entries.length) await writeShip(ship, { compartments, entries }, user);
}

export function setCompartmentConditions(ship, instanceId, changes) {
  if (!requireGM()) return;
  return serialized(() => writeConditions(ship, instanceId, changes));
}

/** ГМ ставит число зарядов пушки; без аргумента — пополняет до максимума. */
export function setCompartmentAmmo(ship, instanceId, value = null) {
  if (!requireGM()) return;
  return serialized(() => writeCompartmentAmmo(ship, instanceId, value));
}

async function writeCompartmentAmmo(ship, instanceId, value) {
  const compartments = ship.system.toObject().compartments;
  const compartment = compartments.find((entry) => entry.instanceId === instanceId);
  if (!compartment?.ammo) return;
  compartment.currentAmmo = value == null ? null : Math.max(0, Math.min(compartment.ammo, Math.round(Number(value) || 0)));
  await ship.update(appendLog(ship, { "system.compartments": compartments }, [
    logEntry("build", format("log.ammo.set", { name: compartment.name, value: compartment.currentAmmo ?? compartment.ammo, max: compartment.ammo }))
  ]));
}

/** Игрок потушил пожар (проверка уже прошла на его клиенте): ГМ проверяет, что его токен стоит в этом отсеке. */
async function extinguish(ship, { instanceId, tokenId, sceneId }, user) {
  const compartment = getCompartment(ship, instanceId);
  if (!hasCondition(compartment ?? {}, "burning")) return denied("notify.notBurning");
  if (!user.isGM) {
    const token = game.scenes.get(sceneId)?.tokens.get(tokenId);
    if (!token?.testUserPermission(user, "OWNER")) return denied("combat.noShooter");
  }
  await writeConditions(ship, instanceId, { burning: false }, user);
  return { ok: true };
}

/**
 * Начало раунда боя (клиент ГМа): горящие отсеки получают 1d6 урона в свои HP, дым рассеивается.
 * Разрушенный отсек перестаёт гореть.
 */
export function processRoundConditions(ship) {
  if (!game.user.isGM) return;
  return serialized(async () => {
    const compartments = ship.system.toObject().compartments;
    const entries = [];
    const burned = [];
    for (const compartment of compartments) {
      entries.push(...toggleConditions(compartment, { smoke: false }));
      if (!hasCondition(compartment, "burning")) continue;
      const roll = await new Roll("1d6").evaluate();
      await roll.toMessage({ flavor: format("condition.burning.damageFlavor", { name: compartment.name, ship: ship.name }), speaker: { alias: ship.name } });
      const before = compartment.currentHp;
      compartment.currentHp = Math.max(0, before - roll.total);
      entries.push(logEntry("damage", format("log.condition.fire", { name: compartment.name, amount: before - compartment.currentHp })));
      burned.push([compartment, before - compartment.currentHp]);
      if (isDestroyed(compartment)) entries.push(...toggleConditions(compartment, { burning: false }));
    }
    if (!entries.length) return;
    // Все пожары и рассеявшийся дым раунда — одной записью корабля.
    await writeShip(ship, { compartments, entries }, game.user);
    for (const [compartment, amount] of burned) emitHook("compartmentHit", ship, compartment, amount);
  });
}

export async function addCrewMember(ship, actorUuid) {
  if (!requireGM()) return;
  const actor = fromUuidSync(actorUuid);
  if (!actor || isShip(actor) || ship.system.crew.some((member) => member.actorUuid === actorUuid)) return;
  const crew = [...ship.system.crew.map((member) => ({ ...member })), { actorUuid, capacityCost: 1, note: "" }];
  await ship.update(appendLog(ship, { "system.crew": crew }, [logEntry("crew", format("log.crew.add", { name: actor.name }))]));
}

export async function updateCrewMember(ship, actorUuid, changes) {
  if (!requireGM()) return;
  const crew = ship.system.crew.map((member) => ({ ...member }));
  const member = crew.find((entry) => entry.actorUuid === actorUuid);
  if (!member) return;
  if ("capacityCost" in changes) member.capacityCost = Math.max(0, Math.round(Number(changes.capacityCost) || 0));
  if ("note" in changes) member.note = String(changes.note ?? "");
  await ship.update({ "system.crew": crew });
}

export async function removeCrewMember(ship, actorUuid) {
  if (!requireGM()) return;
  const crew = ship.system.crew.filter((member) => member.actorUuid !== actorUuid).map((member) => ({ ...member }));
  const update = { "system.crew": crew };
  if (ship.system.captainUuid === actorUuid) update["system.captainUuid"] = "";
  const name = fromUuidSync(actorUuid)?.name ?? actorUuid;
  await ship.update(appendLog(ship, update, [logEntry("crew", format("log.crew.remove", { name }))]));
}

export async function addLogNote(ship, text) {
  if (!requireGM() || !text?.trim()) return;
  await ship.update(appendLog(ship, {}, [logEntry("note", text.trim())]));
}

/** Запись о событии сцены (развёрнута, перестроена, бой, раскрытие) — вместе с сопутствующими изменениями корабля. */
export async function logSceneEvent(ship, text, update = {}) {
  if (!game.user.isGM) return;
  await ship.update(appendLog(ship, update, [logEntry("scene", text)]));
}

export async function clearLog(ship) {
  if (!requireGM()) return;
  await ship.update({ [`flags.${MODULE_ID}.log`]: [] });
}

/** Отсеки на кораблях, поставленные из этого предмета каталога (по UUID или catalogId). */
function placedFrom(item, compartment) {
  return compartment.sourceUuid === item.uuid || (!!item.system.catalogId && compartment.catalogId === item.system.catalogId);
}

export function countPlacedFrom(item) {
  return game.actors.filter(isShip).reduce((sum, ship) => sum + ship.system.compartments.filter((compartment) => placedFrom(item, compartment)).length, 0);
}

/**
 * «Обновить на кораблях»: поставленные копии отсека получают свойства из каталога.
 * Место, проходы, включённость эффекта и полученный урон сохраняются; новый размер — только если отсек влезает.
 */
export function syncCatalogItem(item) {
  if (!requireGM()) return null;
  return serialized(() => writeCatalogSync(item));
}

async function writeCatalogSync(item) {
  const definition = buildPlacedCompartment(item, 1, 1);
  const result = { ships: 0, compartments: 0, keptSize: [], keptInventory: [] };
  for (const ship of game.actors.filter(isShip)) {
    const compartments = ship.system.toObject().compartments;
    let changed = 0;
    for (const [index, compartment] of compartments.entries()) {
      if (!placedFrom(item, compartment)) continue;
      const damage = compartment.maxHp - compartment.currentHp;
      const next = {
        ...definition,
        instanceId: compartment.instanceId,
        x: compartment.x,
        y: compartment.y,
        passageUp: compartment.passageUp,
        passageDown: compartment.passageDown,
        effectActive: compartment.effectActive,
        conditions: compartment.conditions ?? [],
        currentAmmo: compartment.currentAmmo == null || !definition.ammo ? null : Math.min(compartment.currentAmmo, definition.ammo),
        currentHp: Math.max(0, definition.maxHp - damage),
        inventory: compartment.inventory ?? []
      };
      // Сетка инвентаря меняется, только если содержимое в неё помещается.
      if (!fitsGrid(next.inventory, next.inventoryWidth, next.inventoryHeight)) {
        next.inventoryWidth = compartment.inventoryWidth;
        next.inventoryHeight = compartment.inventoryHeight;
        result.keptInventory.push(`${ship.name}: ${compartment.name}`);
      }
      const others = compartments.filter((other) => other.instanceId !== compartment.instanceId);
      const resized = next.width !== compartment.width || next.height !== compartment.height;
      if (resized && !checkPlacement(next, others, ship.system.gridWidth, ship.system.gridHeight).ok) {
        next.width = compartment.width;
        next.height = compartment.height;
        result.keptSize.push(`${ship.name}: ${compartment.name}`);
      }
      compartments[index] = next;
      changed++;
    }
    if (!changed) continue;
    await ship.update(appendLog(ship, { "system.compartments": compartments, ...statsUpdate(ship, compartments) }, [
      logEntry("build", format("log.build.synced", { name: item.name, count: changed }))
    ]));
    result.ships++;
    result.compartments += changed;
  }
  return result;
}

/**
 * Импорт корабля из JSON (файл «Экспорт» листа или каталога актёров Foundry) поверх этого корабля.
 * Сцена, журнал и права остаются от текущего корабля; из экипажа выпадают актёры, которых нет в этом мире.
 */
export async function importShipData(ship, data) {
  if (!requireGM()) return false;
  if (data?.type !== SHIP_TYPE || typeof data.system !== "object") {
    ui.notifications.warn(localize("notify.notShipJson"));
    return false;
  }
  const system = foundry.utils.deepClone(data.system);
  system.crew = (Array.isArray(system.crew) ? system.crew : [])
    .filter((member) => typeof member?.actorUuid === "string" && fromUuidSync(member.actorUuid));
  // Сначала проверка на копии: файл без отсеков или с битыми данными не должен стереть корабль.
  try {
    if (!Array.isArray(system.compartments)) throw new Error("compartments");
    new Actor.implementation({ name: data.name || ship.name, type: SHIP_TYPE, system }, { strict: true });
  } catch (error) {
    console.error(`${MODULE_ID} | импорт`, error);
    ui.notifications.error(localize("notify.invalidJson"));
    return false;
  }
  if (!system.crew.some((member) => member.actorUuid === system.captainUuid)) system.captainUuid = "";
  const dropped = (data.system.crew?.length ?? 0) - system.crew.length;
  try {
    await ship.update({ name: data.name || ship.name, img: data.img || ship.img, system }, { recursive: false, diff: false });
  } catch (error) {
    console.error(`${MODULE_ID} | импорт`, error);
    ui.notifications.error(localize("notify.invalidJson"));
    return false;
  }
  await ship.update(appendLog(ship, {}, [logEntry("build", format("log.build.imported", { name: data.name ?? "—" }))]));
  if (dropped > 0) ui.notifications.warn(format("notify.crewDropped", { count: dropped }));
  return true;
}

/** Помечает расходник dnd5e как ремонтный: сколько HP отсека он восстанавливает. */
export async function markRepairItem(item, amount) {
  if (!requireGM()) return null;
  const document = typeof item === "string" ? await fromUuid(item) : item;
  if (!document || document.documentName !== "Item") return null;
  return document.setFlag(MODULE_ID, "repair", { amount: Math.max(1, Math.round(Number(amount) || 1)) });
}
