/**
 * Инвентарь отсеков: действия выполняет клиент ГМа (socket.js → runPlayerAction, общая очередь).
 * Право — не матрица, а присутствие: токен пользователя стоит в отсеке (на своём или на вражеском корабле).
 * Перенос с персонажем — изменение его предмета и одна запись корабля; если запись корабля не прошла, предмет возвращается.
 */
import { MODULE_ID, format } from "../constants.js";
import { canPlace, findSlot, findStack, stackKey, takeAmmo, parseQuantity, INVENTORY_LIMIT } from "../rules/inventory-rules.js";
import { ammoLeft } from "../rules/ship-rules.js";
import { getShip, getCompartment, isShip, registerPlayerAction, appendLog, logEntry } from "./ship-actions.js";
import { tokenInCompartment } from "../combat/ship-combat.js";
import { compartmentAtPoint, tokenCenter } from "../scene/scene-builder.js";

/** Предметы dnd5e, которые можно положить: у них есть количество и место в рюкзаке. */
export const PHYSICAL_TYPES = ["consumable", "container", "equipment", "loot", "tool", "weapon"];

function refusal(key, data = {}) {
  return { ok: false, reason: { key, data } };
}

/** ГМ — всегда; игрок — если его токен стоит в отсеке на этой сцене. */
export function isPresent(user, scene, ship, instanceId) {
  if (user.isGM) return true;
  return !!scene && !!tokenInCompartment(scene, ship, instanceId, user);
}

function quantityOf(item) {
  return item.system?.quantity ?? 1;
}

/** Токен этого персонажа стоит в отсеке: отдавать и получать вещи может только тот, кто сам здесь. */
function actorPresent(user, scene, ship, instanceId, actor) {
  if (user.isGM) return true;
  return !!scene && scene.tokens.some((token) => {
    if (token.actor?.uuid !== actor.uuid && token.actorId !== actor.id) return false;
    const location = compartmentAtPoint(scene, tokenCenter(token));
    return location?.ship === ship && location.compartment?.instanceId === instanceId;
  });
}

function withQuantity(item, quantity) {
  return { ...item, system: { ...item.system, quantity } };
}

/**
 * Изменение инвентаря одного отсека одной записью корабля. mutate(compartment) меняет compartment.inventory
 * и возвращает отказ или ничего; entries — строки журнала.
 */
async function writeInventory(ship, instanceId, mutate, entries = []) {
  const compartments = ship.system.toObject().compartments;
  const compartment = compartments.find((entry) => entry.instanceId === instanceId);
  if (!compartment?.inventoryWidth) return refusal("inventory.noInventory");
  const refused = mutate(compartment);
  if (refused) return refused;
  return confirmWrite(await ship.update(appendLog(ship, { "system.compartments": compartments }, entries)));
}

/** Foundry не бросает исключение, если данные не прошли проверку, а возвращает пустой результат. */
function confirmWrite(updated) {
  return updated ? { ok: true } : refusal("notify.actionFailed");
}

/** Кладёт предмет в отсек: в стопку того же источника или на свободное место (точка под курсором — первой). */
function placeItem(compartment, item, { x, y } = {}) {
  const stack = item.type === "container" ? null : findStack(compartment.inventory, item);
  if (stack) {
    stack.item = withQuantity(stack.item, quantityOf(stack.item) + quantityOf(item));
    return null;
  }
  const slot = findSlot(compartment.inventory, item, compartment.inventoryWidth, compartment.inventoryHeight, { x, y });
  if (!slot) return refusal("inventory.noSpace", { name: compartment.name });
  compartment.inventory.push({ instanceId: foundry.utils.randomID(), item, ...slot });
  return null;
}

/** Убирает count штук из записи; пустая запись уходит. Возвращает данные снятых предметов или отказ. */
function removeFromEntry(compartment, entryId, count) {
  const entry = compartment.inventory.find((candidate) => candidate.instanceId === entryId);
  if (!entry) return { refused: refusal("notify.notFound") };
  const quantity = Math.min(count, quantityOf(entry.item));
  if (quantity >= quantityOf(entry.item)) compartment.inventory.splice(compartment.inventory.indexOf(entry), 1);
  else entry.item = withQuantity(entry.item, quantityOf(entry.item) - quantity);
  return { item: withQuantity(entry.item, quantity), quantity };
}

/** Контейнер dnd5e вместе с тем, что в нём лежит (рекурсивно). */
function containerContents(actor, container) {
  return actor.items
    .filter((item) => item.system.container === container.id)
    .flatMap((item) => [item, ...(item.type === "container" ? containerContents(actor, item) : [])]);
}

/** Сцена из запроса; игроку — только та, на которую он сейчас смотрит (токен на другой сцене доступа не даёт). */
function sceneOf(payload, user) {
  const scene = game.scenes.get(payload.sceneId) ?? null;
  if (!scene || user.isGM) return scene;
  return scene.id === user.viewedScene ? scene : null;
}

function ownedActor(user, actorUuid) {
  if (typeof actorUuid !== "string") return null;
  const actor = fromUuidSync(actorUuid);
  if (!actor || isShip(actor) || actor.documentName !== "Actor") return null;
  return actor.testUserPermission(user, "OWNER") ? actor : null;
}

/* ---------------- Перенос с персонажем ---------------- */

/** С листа персонажа в отсек. Содержимое контейнера уезжает вместе с ним (флаг contents). */
async function inventoryStore(ship, payload, user) {
  const scene = sceneOf(payload, user);
  if (!isPresent(user, scene, ship, payload.instanceId)) return refusal("inventory.notPresent");
  const actor = ownedActor(user, payload.actorUuid);
  const source = actor?.items.get(payload.itemId);
  if (!source) return refusal("notify.notYourItem");
  if (!actorPresent(user, scene, ship, payload.instanceId, actor)) return refusal("inventory.actorNotPresent", { name: actor.name });
  if (!PHYSICAL_TYPES.includes(source.type)) return refusal("inventory.notPhysical");
  const quantity = parseQuantity(payload.quantity, quantityOf(source));
  if (!quantity) return refusal("inventory.badQuantity");
  const contents = source.type === "container" ? containerContents(actor, source) : [];
  const item = withQuantity(source.toObject(), quantity);
  // _id нужен только контейнеру: по нему содержимое находит, в чём лежит.
  if (!contents.length) delete item._id;
  if (!source._stats?.compendiumSource) foundry.utils.setProperty(item, `flags.${MODULE_ID}.origin`, source.uuid);
  if (contents.length) foundry.utils.setProperty(item, `flags.${MODULE_ID}.contents`, contents.map((entry) => entry.toObject()));

  const compartment = getCompartment(ship, payload.instanceId);
  const entry = logEntry("inventory", format("log.inventory.store", { item: source.name, count: quantity, actor: actor.name, compartment: compartment?.name ?? "—" }), user);
  // Сначала проверка места на копии — предмет персонажа не трогается, если положить некуда.
  const trial = foundry.utils.deepClone(ship.system.toObject().compartments.find((candidate) => candidate.instanceId === payload.instanceId));
  if (!trial?.inventoryWidth) return refusal("inventory.noInventory");
  const refused = placeItem(trial, item, payload);
  if (refused) return refused;

  const whole = quantity >= quantityOf(source);
  const restore = whole
    ? () => actor.createEmbeddedDocuments("Item", [source.toObject(), ...contents.map((content) => content.toObject())], { keepId: true })
    : () => source.update({ "system.quantity": quantityOf(source) + quantity });
  if (whole) await actor.deleteEmbeddedDocuments("Item", [source.id, ...contents.map((content) => content.id)]);
  else await source.update({ "system.quantity": quantityOf(source) - quantity });
  return writeOrUndo(() => writeInventory(ship, payload.instanceId, (target) => placeItem(target, item, payload), [entry]), restore);
}

/** Запись корабля после изменения персонажа: при отказе или ошибке изменение персонажа отменяется — вещь не теряется и не удваивается. */
async function writeOrUndo(write, undo) {
  let result;
  try {
    result = await write();
  } catch (error) {
    // Ошибка отката не должна скрыть исходную: в консоль уходят обе.
    try {
      await undo();
    } catch (undoError) {
      console.error(`${MODULE_ID} | откат после ошибки записи не удался`, undoError);
    }
    throw error;
  }
  if (!result.ok) await undo();
  return result;
}

/** Создаёт предмет у персонажа (в стопку того же источника, если есть); контейнер — с содержимым. Возвращает отмену. */
async function giveToActor(actor, item, quantity) {
  // Та же стопка: тот же источник, или это и есть предмет, из которого вещь положили в отсек.
  const key = stackKey(item);
  const origin = item.flags?.[MODULE_ID]?.origin;
  const stack = item.type === "container" ? null : actor.items.find((candidate) => candidate.type === item.type
    && candidate.type !== "container" && (candidate.uuid === origin || stackKey(candidate.toObject()) === key));
  if (stack) {
    await stack.update({ "system.quantity": quantityOf(stack) + quantity });
    return () => stack.update({ "system.quantity": quantityOf(stack) - quantity });
  }
  const data = withQuantity(foundry.utils.deepClone(item), quantity);
  const contents = foundry.utils.getProperty(data, `flags.${MODULE_ID}.contents`) ?? [];
  if (data.flags?.[MODULE_ID]) delete data.flags[MODULE_ID].contents;
  // Новые идентификаторы для контейнера и всего, что в нём, с теми же связями «что в чём лежит».
  const ids = new Map([data, ...contents].filter((entry) => entry._id).map((entry) => [entry._id, foundry.utils.randomID()]));
  const documents = [data, ...contents].map((entry) => ({
    ...entry,
    _id: ids.get(entry._id) ?? foundry.utils.randomID(),
    system: { ...entry.system, container: ids.get(entry.system?.container) ?? entry.system?.container ?? null }
  }));
  documents[0].system.container = null;
  const created = await actor.createEmbeddedDocuments("Item", documents, { keepId: true });
  if (!created?.length) throw new Error(`${MODULE_ID} | предмет не создан у ${actor.name}`);
  return () => actor.deleteEmbeddedDocuments("Item", created.map((document) => document.id));
}

/** Из отсека персонажу, чьим токеном или листом пользователь владеет. */
async function inventoryTake(ship, payload, user) {
  const scene = sceneOf(payload, user);
  if (!isPresent(user, scene, ship, payload.instanceId)) return refusal("inventory.notPresent");
  const actor = ownedActor(user, payload.actorUuid);
  if (!actor) return refusal("notify.notYourItem");
  if (!actorPresent(user, scene, ship, payload.instanceId, actor)) return refusal("inventory.actorNotPresent", { name: actor.name });
  const compartment = getCompartment(ship, payload.instanceId);
  const current = compartment?.inventory.find((entry) => entry.instanceId === payload.entryId);
  if (!current) return refusal("notify.notFound");
  if (!PHYSICAL_TYPES.includes(current.item?.type) || !current.item?.name) return refusal("inventory.notPhysical");
  const quantity = parseQuantity(payload.quantity, quantityOf(current.item));
  if (!quantity) return refusal("inventory.badQuantity");
  const undo = await giveToActor(actor, current.item, quantity);
  const entry = logEntry("inventory", format("log.inventory.take", { item: current.item.name, count: quantity, actor: actor.name, compartment: compartment.name }), user);
  return writeOrUndo(() => writeInventory(ship, payload.instanceId, (target) => removeFromEntry(target, payload.entryId, quantity).refused, [entry]), undo);
}

/* ---------------- Внутри сетки и между отсеками ---------------- */

async function inventoryMove(ship, payload, user) {
  if (!isPresent(user, sceneOf(payload, user), ship, payload.instanceId)) return refusal("inventory.notPresent");
  return writeInventory(ship, payload.instanceId, (compartment) => {
    const entry = compartment.inventory.find((candidate) => candidate.instanceId === payload.entryId);
    if (!entry) return refusal("notify.notFound");
    const moved = { ...entry, x: Number(payload.x), y: Number(payload.y), rotated: payload.rotated === true };
    if (!canPlace(compartment.inventory, moved, compartment.inventoryWidth, compartment.inventoryHeight).ok) return refusal("inventory.noSpace", { name: compartment.name });
    Object.assign(entry, moved);
    return null;
  });
}

/** В другой отсек этого или другого корабля; пользователь присутствует в обоих. Сначала пишется цель. */
async function inventoryTransfer(ship, payload, user) {
  const scene = sceneOf(payload, user);
  const target = getShip(payload.targetShipUuid);
  if (!target) return refusal("notify.notFound");
  if (!isPresent(user, scene, ship, payload.instanceId) || !isPresent(user, scene, target, payload.targetInstanceId)) return refusal("inventory.notPresent");
  if (target === ship && payload.targetInstanceId === payload.instanceId) return inventoryMove(ship, payload, user);
  const source = getCompartment(ship, payload.instanceId);
  const current = source?.inventory.find((entry) => entry.instanceId === payload.entryId);
  if (!current) return refusal("notify.notFound");
  const quantity = parseQuantity(payload.quantity, quantityOf(current.item));
  if (!quantity) return refusal("inventory.badQuantity");
  const moved = withQuantity(current.item, quantity);
  const destination = getCompartment(target, payload.targetInstanceId);
  const entry = logEntry("inventory", format("log.inventory.transfer", {
    item: current.item.name, count: quantity, from: source.name, to: destination?.name ?? "—", ship: target.name
  }), user);
  const at = { x: payload.x, y: payload.y };

  if (target === ship) {
    // Один корабль — одна запись: снять в одном отсеке и положить в другом.
    const compartments = ship.system.toObject().compartments;
    const from = compartments.find((candidate) => candidate.instanceId === payload.instanceId);
    const to = compartments.find((candidate) => candidate.instanceId === payload.targetInstanceId);
    if (!to?.inventoryWidth) return refusal("inventory.noInventory");
    const refused = placeItem(to, moved, at) ?? removeFromEntry(from, payload.entryId, quantity).refused;
    if (refused) return refused;
    return confirmWrite(await ship.update(appendLog(ship, { "system.compartments": compartments }, [entry])));
  }
  // Между кораблями — две записи. В очереди ГМа источник между ними не меняется, поэтому вторая не отказывает.
  const placed = await writeInventory(target, payload.targetInstanceId, (compartment) => placeItem(compartment, moved, at), [entry]);
  if (!placed.ok) return placed;
  return writeInventory(ship, payload.instanceId, (compartment) => removeFromEntry(compartment, payload.entryId, quantity).refused, [entry]);
}

/** Свой размер предмета (правый клик → «Размер…»): только если он по-прежнему помещается на месте. */
async function inventoryResize(ship, payload, user) {
  if (!isPresent(user, sceneOf(payload, user), ship, payload.instanceId)) return refusal("inventory.notPresent");
  const size = {
    width: Math.max(1, Math.min(INVENTORY_LIMIT, Math.round(Number(payload.width) || 1))),
    height: Math.max(1, Math.min(INVENTORY_LIMIT, Math.round(Number(payload.height) || 1)))
  };
  return writeInventory(ship, payload.instanceId, (compartment) => {
    const entry = compartment.inventory.find((candidate) => candidate.instanceId === payload.entryId);
    if (!entry) return refusal("notify.notFound");
    const resized = { ...entry, item: foundry.utils.mergeObject(foundry.utils.deepClone(entry.item), { [`flags.${MODULE_ID}.size`]: size }) };
    if (!canPlace(compartment.inventory, resized, compartment.inventoryWidth, compartment.inventoryHeight).ok) return refusal("inventory.noSpace", { name: compartment.name });
    Object.assign(entry, resized);
    return null;
  });
}

/** «Разделить стопку…»: часть стопки — отдельной записью на свободном месте. */
async function inventorySplit(ship, payload, user) {
  if (!isPresent(user, sceneOf(payload, user), ship, payload.instanceId)) return refusal("inventory.notPresent");
  return writeInventory(ship, payload.instanceId, (compartment) => {
    const entry = compartment.inventory.find((candidate) => candidate.instanceId === payload.entryId);
    if (!entry || quantityOf(entry.item) < 2) return refusal("notify.notFound");
    const quantity = parseQuantity(payload.quantity, quantityOf(entry.item) - 1);
    if (!quantity) return refusal("inventory.badQuantity");
    const slot = findSlot(compartment.inventory, entry.item, compartment.inventoryWidth, compartment.inventoryHeight);
    if (!slot) return refusal("inventory.noSpace", { name: compartment.name });
    entry.item = withQuantity(entry.item, quantityOf(entry.item) - quantity);
    compartment.inventory.push({ instanceId: foundry.utils.randomID(), item: withQuantity(entry.item, quantity), ...slot });
    return null;
  });
}

/* ---------------- Только ГМ ---------------- */

/** Каталог ГМа: груз или предмет из компендиума — в отсек. */
async function inventoryAddCatalog(ship, payload, user) {
  if (!user.isGM) return refusal("notify.gmOnly");
  const document = await fromUuid(payload.uuid);
  if (document?.documentName !== "Item" || !PHYSICAL_TYPES.includes(document.type)) return refusal("inventory.notPhysical");
  const quantity = parseQuantity(payload.quantity, Infinity);
  if (!quantity) return refusal("inventory.badQuantity");
  const item = withQuantity(document.toObject(), quantity);
  delete item._id;
  foundry.utils.setProperty(item, "_stats.compendiumSource", document.pack ? document.uuid : document._stats?.compendiumSource ?? null);
  if (!document.pack && !document._stats?.compendiumSource) foundry.utils.setProperty(item, `flags.${MODULE_ID}.origin`, document.uuid);
  const compartment = getCompartment(ship, payload.instanceId);
  const entry = logEntry("inventory", format("log.inventory.add", { item: document.name, count: quantity, compartment: compartment?.name ?? "—" }), user);
  return writeInventory(ship, payload.instanceId, (target) => placeItem(target, item, payload), [entry]);
}

async function inventoryDelete(ship, payload, user) {
  if (!user.isGM) return refusal("notify.gmOnly");
  const compartment = getCompartment(ship, payload.instanceId);
  const current = compartment?.inventory.find((entry) => entry.instanceId === payload.entryId);
  if (!current) return refusal("notify.notFound");
  const entry = logEntry("inventory", format("log.inventory.delete", { item: current.item.name, count: quantityOf(current.item), compartment: compartment.name }), user);
  return writeInventory(ship, payload.instanceId, (target) => {
    target.inventory = target.inventory.filter((candidate) => candidate.instanceId !== payload.entryId);
    return null;
  }, [entry]);
}

/* ---------------- Снаряды ---------------- */

/** «Перезарядить»: магазин пушки до полного из снарядов в инвентаре её отсека (сколько есть). */
async function reloadFromInventory(ship, payload, user) {
  if (!isPresent(user, sceneOf(payload, user), ship, payload.instanceId)) return refusal("inventory.notPresent");
  const weapon = getCompartment(ship, payload.instanceId);
  if (!weapon?.ammo || !weapon.ammoItem?.uuid) return refusal("notify.unknownAction");
  const need = weapon.ammo - ammoLeft(weapon);
  if (need <= 0) return refusal("inventory.magazineFull");
  let taken = 0;
  const compartments = ship.system.toObject().compartments;
  const target = compartments.find((entry) => entry.instanceId === payload.instanceId);
  ({ entries: target.inventory, taken } = takeAmmo(target.inventory, target.ammoItem, need));
  if (!taken) return refusal("inventory.noAmmoStock", { item: weapon.ammoItem.name });
  target.currentAmmo = ammoLeft(weapon) + taken;
  await ship.update(appendLog(ship, { "system.compartments": compartments }, [
    logEntry("inventory", format("log.inventory.reload", { weapon: weapon.name, count: taken, item: weapon.ammoItem.name }), user)
  ]));
  return { ok: true, taken };
}

for (const [name, run] of Object.entries({
  inventoryStore, inventoryTake, inventoryMove, inventoryTransfer, inventoryResize, inventorySplit,
  inventoryAddCatalog, inventoryDelete, reloadFromInventory
})) {
  registerPlayerAction(name, { right: null, run });
}
