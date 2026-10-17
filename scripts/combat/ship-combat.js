/**
 * Бой кораблей: обстрел и разведка.
 * Броски делает клиент стрелка (проверка навыка dnd5e и окно урона dnd5e), применяет результат клиент ГМа:
 * он заново проверяет, кто стреляет, откуда и не стреляла ли пушка в этом раунде.
 * Особые пушки: «Брызги» (огнемёт) задевают соседние отсеки, «Зарядка» (Ямато) стреляет раунд спустя
 * после зарядки, «Залп» (перехватчики, ATA) — каждая кость отдельный выстрел со своей целью.
 */
import { MODULE_ID, CELL_SIZE, localize, format } from "../constants.js";
import { isWeapon, isFunctioning, weaponFormula, attackDifficulty, shotCount } from "../rules/ship-rules.js";
import { getShip, getCompartment, canUser, registerPlayerAction, applyHit, appendLog, logEntry, battleOpponents } from "../documents/ship-actions.js";
import { getLayout, sceneSides, compartmentAtPoint, tokenCenter } from "../scene/scene-builder.js";
import { isSideRevealed, isTokenOnRecon, markScouted, revealState } from "../scene/reveal.js";
import { requestAction, emitHook } from "../socket.js";
import { createHitCard } from "./hit-card.js";

const DEFAULT_SKILL = "prc";

function refusal(key) {
  return { ok: false, reason: { key, data: {} } };
}

/** Сцена боя с этим кораблём: своя сторона и противник. */
function battleOf(scene, ship) {
  if (getLayout(scene)?.mode !== "battle") return null;
  const sides = sceneSides(scene);
  const own = sides.find((entry) => entry.ship === ship);
  const enemy = sides.find((entry) => entry.ship !== ship);
  return own && enemy ? { scene, side: own.side, enemy } : null;
}

/** Бой на текущей сцене этого клиента. */
export function currentBattle(ship) {
  return canvas.ready ? battleOf(canvas.scene, ship) : null;
}

/** Раунд — бой трекера dnd5e на этой сцене; без начатого боя ограничения на выстрелы нет. */
export function sceneCombat(scene) {
  return game.combats.find((combat) => combat.scene?.id === scene.id && combat.started) ?? null;
}

function roundKey(combat) {
  return combat ? `${combat.id}:${combat.round}` : null;
}

export function hasFiredThisRound(ship, instanceId, scene) {
  const key = roundKey(sceneCombat(scene));
  return !!key && ship.getFlag(MODULE_ID, "fired")?.[instanceId] === key;
}

/** Пушка с зарядкой: null — не заряжена, "charging" — заряжена в этом раунде, "charged" — готова к выстрелу. */
export function chargeState(ship, instanceId, scene) {
  const value = ship.getFlag(MODULE_ID, "charged")?.[instanceId];
  if (!value) return null;
  return value === roundKey(sceneCombat(scene)) ? "charging" : "charged";
}

export function checkSkillLabel(compartment) {
  return CONFIG.DND5E.skills[compartment.checkSkill || DEFAULT_SKILL]?.label ?? compartment.checkSkill;
}

/** Сложность попадания пушки при текущей дистанции: штраф дальности, защита противника, точность своего корабля. */
export function currentDifficulty(ship, compartment) {
  const defense = battleOpponents(ship)[0]?.system.bonuses?.defense ?? 0;
  const modifier = defense - (ship.system.bonuses?.attack ?? 0);
  return attackDifficulty(compartment, ship.system.combatDistance, game.settings.get(MODULE_ID, "rangePenalty"), modifier);
}

/** Огневая мощь с бонусом урона от эффектов корабля; у залпа — формула одного выстрела. */
export function shipWeaponFormula(ship, weapon, options) {
  return weaponFormula(weapon, ship.system.bonuses?.damage ?? 0, options);
}

/** Токен пользователя в этом отсеке: выделенный — первым. */
function tokenInCompartment(scene, ship, instanceId, user = game.user) {
  const inside = scene.tokens.filter((token) => {
    const location = compartmentAtPoint(scene, tokenCenter(token));
    return location?.ship === ship && location.compartment?.instanceId === instanceId && token.testUserPermission(user, "OWNER");
  });
  return inside.find((token) => token.object?.controlled) ?? inside[0] ?? null;
}

/**
 * Почему пушка не может выстрелить или зарядиться (ключ i18n) или null. Одни и те же правила у стрелка и у ГМа.
 * action: "fire" — выстрел, "charge" — зарядка.
 */
function shotBlocker(scene, ship, weapon, token, user, action = "fire") {
  if (!weapon || !isWeapon(weapon)) return "combat.notWeapon";
  if (!isFunctioning(weapon)) return "combat.weaponDestroyed";
  // ГМ может стрелять за NPC-экипаж без токена в пушке.
  if (!token && !user.isGM) return "combat.noShooter";
  const combat = sceneCombat(scene);
  if (combat && !user.isGM && combat.combatant?.tokenId !== token.id) return "combat.notYourTurn";
  if (hasFiredThisRound(ship, weapon.instanceId, scene)) return "combat.alreadyFired";
  if (weapon.special === "charge") {
    const state = chargeState(ship, weapon.instanceId, scene);
    if (action === "charge" && state) return "combat.alreadyCharged";
    if (action === "fire" && state !== "charged") return state === "charging" ? "combat.charging" : "combat.notCharged";
  }
  return null;
}

/** Клиент ГМа: стрелок — владелец токена в этой пушке; ГМ может стрелять без токена. */
function shooterBlocker(scene, ship, weaponId, token, user) {
  if (!token && user.isGM) return null;
  const location = token && compartmentAtPoint(scene, tokenCenter(token));
  const owner = !!token && token.testUserPermission(user, "OWNER");
  if (!owner || location?.ship !== ship || location.compartment?.instanceId !== weaponId) return "combat.noShooter";
  return null;
}

/* ---------------- Прицел ---------------- */

let targeting = null;

function cancelTargeting() {
  if (!targeting) return;
  document.removeEventListener("keydown", targeting.onKey);
  targeting.layer.destroy({ children: true });
  const { resolve } = targeting;
  targeting = null;
  resolve(null);
}

/**
 * Выбор отсека противника на канве: подсветка под курсором, левый клик — цель, правый или Esc — отмена.
 * Возвращает выбранное место или null при отмене.
 */
function pickTarget({ scene, enemy }, hint = localize("combat.pickTarget")) {
  cancelTargeting();
  return new Promise((resolve) => {
    // Foundry переключает eventMode прямых детей группы интерфейса, поэтому ловушка кликов — вложенный объект.
    const layer = new PIXI.Container();
    layer.name = "skyplane-targeting";
    layer.zIndex = 300;
    const catcher = layer.addChild(new PIXI.Container());
    catcher.eventMode = "static";
    catcher.cursor = "crosshair";
    catcher.hitArea = new PIXI.Rectangle(0, 0, scene.dimensions.width, scene.dimensions.height);
    const marker = layer.addChild(new PIXI.Graphics());
    const targetAt = (event) => {
      const location = compartmentAtPoint(scene, event.getLocalPosition(layer));
      return location?.side === enemy.side && location.compartment ? location : null;
    };
    const finish = (location) => {
      document.removeEventListener("keydown", targeting.onKey);
      layer.destroy({ children: true });
      targeting = null;
      resolve(location);
    };
    catcher.on("pointermove", (event) => {
      const location = targetAt(event);
      marker.clear();
      if (!location) return;
      const { compartment } = location;
      marker.lineStyle(12, 0xff4d3a, 0.95).drawRect(
        enemy.origin.originX + (compartment.x - 1) * CELL_SIZE,
        enemy.origin.originY + (compartment.y - 1) * CELL_SIZE,
        compartment.width * CELL_SIZE,
        compartment.height * CELL_SIZE
      );
    });
    catcher.on("pointerdown", (event) => {
      event.stopPropagation();
      if (event.button !== 0) {
        ui.notifications.info(localize("combat.cancelled"));
        return finish(null);
      }
      const location = targetAt(event);
      if (!location) return ui.notifications.warn(localize("combat.pickEnemy"));
      finish(location);
    });
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      ui.notifications.info(localize("combat.cancelled"));
      finish(null);
    };
    document.addEventListener("keydown", onKey);
    canvas.interface.addChild(layer);
    targeting = { layer, onKey, resolve };
    ui.notifications.info(hint);
  });
}

/* ---------------- Обстрел ---------------- */

/** Кнопка «Обстрел»: прицел → проверка попадания → окно урона dnd5e → ГМ применяет урон. Незаряженная пушка заряжается. */
export async function startShot(shipOrUuid, instanceId) {
  const ship = getShip(shipOrUuid);
  const weapon = ship && getCompartment(ship, instanceId);
  const battle = ship && currentBattle(ship);
  if (!battle) return ui.notifications.warn(localize("combat.noBattle"));
  if (!canUser(game.user, ship, "combat")) return ui.notifications.warn(localize("notify.denied"));
  // Без ГМа в сети выстрел не применить — не тратим броски впустую.
  if (!game.users.activeGM) return ui.notifications.warn(localize("notify.noGm"));
  const token = tokenInCompartment(battle.scene, ship, instanceId);
  if (weapon?.special === "charge" && !chargeState(ship, instanceId, battle.scene)) {
    const blocker = shotBlocker(battle.scene, ship, weapon, token, game.user, "charge");
    if (blocker) return ui.notifications.warn(localize(blocker));
    const result = await requestAction("chargeWeapon", ship, { sceneId: battle.scene.id, tokenId: token?.id ?? null, weaponId: instanceId });
    if (result?.ok) ui.notifications.info(format("combat.chargedNotice", { weapon: weapon.name }));
    return;
  }
  const blocker = shotBlocker(battle.scene, ship, weapon, token, game.user);
  if (blocker) return ui.notifications.warn(localize(blocker));
  return fire(battle, ship, weapon, shooterOf(ship, token));
}

/**
 * Кто стреляет: токен в пушке, а если его нет (выстрел ГМа за NPC-экипаж) — капитан или первый член экипажа.
 * Без экипажа проверка идёт чистым d20 против сложности пушки.
 */
function shooterOf(ship, token) {
  if (token) return { token, actor: token.actor, name: token.name };
  const crewUuids = [ship.system.captainUuid, ...ship.system.crew.map((member) => member.actorUuid)].filter(Boolean);
  const actor = crewUuids.map((uuid) => fromUuidSync(uuid)).find((candidate) => candidate?.system?.skills) ?? null;
  return { token: null, actor, name: actor?.name ?? format("combat.crewOf", { ship: ship.name }) };
}

async function rollCheck(shooter, skill, dc, disadvantage, flavor) {
  if (shooter.actor) {
    const config = { skill, target: dc };
    if (disadvantage) config.disadvantage = true;
    return (await shooter.actor.rollSkill(config, {}, { data: { flavor } }))?.[0] ?? null;
  }
  const config = { rolls: [{ parts: [], data: {}, options: {} }], target: dc };
  if (disadvantage) config.disadvantage = true;
  const rolls = await CONFIG.Dice.D20Roll.build(config, {}, { data: { flavor, speaker: { alias: shooter.name } } });
  return rolls?.[0] ?? null;
}

/** Один выстрел: проверка попадания и бросок урона. null — стрелок закрыл окно броска. */
async function rollShot({ scene, enemy }, ship, weapon, shooter, target) {
  const { token, actor } = shooter;
  const { dc, disadvantage } = currentDifficulty(ship, weapon);
  // Нераскрытый противник: стрелок не знает, во что целится.
  const targetName = isSideRevealed(scene, enemy.side) ? target.compartment.name : localize("combat.unknownCompartment");
  const flavor = format("combat.shotFlavor", { weapon: weapon.name, target: targetName, ship: enemy.ship.name });

  const check = await rollCheck(shooter, weapon.checkSkill || DEFAULT_SKILL, dc, disadvantage, flavor);
  if (!check) return null;
  const shot = { targetInstanceId: target.compartment.instanceId, targetName, hit: false, amount: 0 };
  if (!check.isSuccess) return shot;

  const damage = await CONFIG.Dice.DamageRoll.build(
    {
      rolls: [{ parts: [shipWeaponFormula(ship, weapon, { perShot: true })], data: actor?.getRollData() ?? {} }],
      critical: { allow: true },
      isCritical: check.isCritical
    },
    { options: { defaultButton: check.isCritical ? "critical" : "normal", window: { title: flavor } } },
    {
      data: {
        flavor: format("combat.damageFlavor", { weapon: weapon.name, target: targetName }),
        speaker: token ? ChatMessage.getSpeaker({ token }) : { alias: shooter.name }
      }
    }
  );
  if (!damage?.length) return null;
  return { ...shot, hit: true, amount: damage.reduce((sum, roll) => sum + roll.total, 0) };
}

/** Выстрел или залп: цели и броски на клиенте стрелка, затем один запрос ГМу со всеми выстрелами. */
async function fire(battle, ship, weapon, shooter) {
  const count = shotCount(weapon);
  const shots = [];
  for (let index = 0; index < count; index++) {
    const hint = count > 1 ? format("combat.pickVolleyTarget", { index: index + 1, count }) : undefined;
    const target = await pickTarget(battle, hint);
    if (!target) break;
    const shot = await rollShot(battle, ship, weapon, shooter, target);
    if (!shot) break;
    shots.push(shot);
  }
  // Залп, прерванный на середине, всё равно считается выстрелом пушки.
  if (!shots.length) return;

  const result = await requestAction("fireWeapon", ship, {
    sceneId: battle.scene.id,
    tokenId: shooter.token?.id ?? null,
    shooterName: shooter.name,
    weaponId: weapon.instanceId,
    shots: shots.map(({ targetInstanceId, hit, amount }) => ({ targetInstanceId, hit, amount }))
  });
  if (!result?.ok) return;
  const hits = shots.filter((shot) => shot.hit);
  if (count > 1) return ui.notifications.info(format("combat.volleyNotice", { hits: hits.length, shots: shots.length, amount: result.damage }));
  if (!hits.length) return ui.notifications.info(localize("combat.missNotice"));
  const key = result.pending ? "combat.pendingNotice" : "combat.hitNotice";
  ui.notifications.info(format(key, { amount: result.damage, target: hits[0].targetName }));
}

/** Клиент ГМа: проверяет выстрел и применяет урон к прочности корабля и HP отсека. */
async function fireWeapon(ship, { sceneId, tokenId, shooterName, weaponId, shots }, user) {
  const scene = game.scenes.get(sceneId);
  const battle = scene && battleOf(scene, ship);
  if (!battle) return refusal("combat.noBattle");
  const token = tokenId ? scene.tokens.get(tokenId) : null;
  const weapon = getCompartment(ship, weaponId);
  const blocker = shooterBlocker(scene, ship, weaponId, token, user) ?? shotBlocker(scene, ship, weapon, token, user);
  if (blocker) return refusal(blocker);
  if (!Array.isArray(shots) || !shots.length || shots.length > shotCount(weapon)) return refusal("notify.unknownAction");
  const enemyShip = battle.enemy.ship;
  const targets = shots.map((shot) => getCompartment(enemyShip, shot.targetInstanceId));
  if (targets.some((target) => !target)) return refusal("notify.notFound");

  const key = roundKey(sceneCombat(scene));
  const shooter = token?.name ?? String(shooterName ?? "");
  const results = shots.map((shot, index) => ({
    target: targets[index],
    damage: shot.hit ? Math.max(0, Math.round(Number(shot.amount) || 0)) : 0,
    hit: !!shot.hit
  }));
  const update = key ? { [`flags.${MODULE_ID}.fired.${weaponId}`]: key } : {};
  if (weapon.special === "charge") update[`flags.${MODULE_ID}.charged.-=${weaponId}`] = null;
  const entries = results.map(({ target, damage, hit }) => logEntry("attack", format(hit ? "log.combat.hit" : "log.combat.miss", {
    weapon: weapon.name, shooter, target: target.name, ship: enemyShip.name, amount: damage
  }), user));
  await ship.update(appendLog(ship, update, entries));

  // Урон применяется сразу или ждёт кнопки ГМа в карточке — галочка в настройках модуля.
  const pending = game.settings.get(MODULE_ID, "gmConfirmsDamage");
  const revealed = revealState(getLayout(scene), battle.side).revealed;
  for (const { target, damage } of results) {
    emitHook("shipFired", ship, weapon, enemyShip, target, damage);
    if (damage <= 0) continue;
    const hitData = {
      attackerUuid: ship.uuid,
      targetUuid: enemyShip.uuid,
      instanceId: target.instanceId,
      amount: damage,
      shooter,
      weapon: weapon.name,
      targetName: revealed ? target.name : localize("combat.unknownCompartment"),
      splash: weapon.special === "splash",
      status: pending ? "pending" : "applied",
      lost: null
    };
    if (!pending) {
      const names = { weapon: weapon.name, shooter, target: target.name, ship: enemyShip.name, amount: damage, attacker: ship.name };
      hitData.lost = await applyHit(enemyShip, target.instanceId, damage, user, format("log.combat.taken", names), { splash: hitData.splash });
    }
    await createHitCard(hitData);
  }
  return { ok: true, damage: results.reduce((sum, { damage }) => sum + damage, 0), pending };
}

/** Клиент ГМа: зарядка пушки занимает её выстрел в этом раунде, стрелять можно со следующего. */
async function chargeWeapon(ship, { sceneId, tokenId, weaponId }, user) {
  const scene = game.scenes.get(sceneId);
  const battle = scene && battleOf(scene, ship);
  if (!battle) return refusal("combat.noBattle");
  const token = tokenId ? scene.tokens.get(tokenId) : null;
  const weapon = getCompartment(ship, weaponId);
  if (weapon?.special !== "charge") return refusal("notify.unknownAction");
  const blocker = shooterBlocker(scene, ship, weaponId, token, user) ?? shotBlocker(scene, ship, weapon, token, user, "charge");
  if (blocker) return refusal(blocker);
  const key = roundKey(sceneCombat(scene));
  const update = { [`flags.${MODULE_ID}.charged.${weaponId}`]: key ?? "ready" };
  if (key) update[`flags.${MODULE_ID}.fired.${weaponId}`] = key;
  const shooter = token?.name ?? format("combat.crewOf", { ship: ship.name });
  await ship.update(appendLog(ship, update, [logEntry("attack", format("log.combat.charged", { weapon: weapon.name, shooter }), user)]));
  return { ok: true };
}

/* ---------------- Разведка ---------------- */

/** Сложность разведки с бонусом от эффектов корабля. */
export function scoutDifficulty(ship, compartment) {
  return Math.max(0, compartment.checkDc - (ship.system.bonuses?.scout ?? 0));
}

/** Кнопка «Разведка»: токен в целом отсеке «Разведка» своего корабля проходит проверку навыка. */
export async function startScouting(shipOrUuid, instanceId) {
  const ship = getShip(shipOrUuid);
  const compartment = ship && getCompartment(ship, instanceId);
  const battle = ship && currentBattle(ship);
  if (!battle) return ui.notifications.warn(localize("combat.noBattle"));
  if (!canUser(game.user, ship, "combat")) return ui.notifications.warn(localize("notify.denied"));
  if (!game.users.activeGM) return ui.notifications.warn(localize("notify.noGm"));
  if (compartment?.systemCategory !== "recon" || !isFunctioning(compartment)) return ui.notifications.warn(localize("combat.notRecon"));
  const token = tokenInCompartment(battle.scene, ship, instanceId);
  if (!token || !isTokenOnRecon(battle.scene, token, battle.side)) return ui.notifications.warn(localize("combat.noScout"));

  const flavor = format("combat.scoutFlavor", { name: compartment.name });
  const checks = await token.actor.rollSkill({ skill: compartment.checkSkill || DEFAULT_SKILL, target: scoutDifficulty(ship, compartment) }, {}, { data: { flavor } });
  const check = checks?.[0];
  if (!check) return;
  if (!check.isSuccess) return ui.notifications.info(localize("combat.scoutFailed"));
  const result = await requestAction("scout", ship, { sceneId: battle.scene.id, tokenId: token.id });
  if (result?.ok) ui.notifications.info(localize(result.revealed ? "combat.scoutSuccess" : "combat.scoutHiddenByGm"));
}

async function scout(ship, { sceneId, tokenId }, user) {
  const scene = game.scenes.get(sceneId);
  const battle = scene && battleOf(scene, ship);
  if (!battle) return refusal("combat.noBattle");
  const token = scene.tokens.get(tokenId);
  if (!token?.testUserPermission(user, "OWNER") || !isTokenOnRecon(scene, token, battle.side)) return refusal("combat.noScout");
  const revealed = await markScouted(scene, battle.side, token.id);
  return { ok: true, revealed };
}

registerPlayerAction("fireWeapon", { right: "combat", run: fireWeapon });
registerPlayerAction("chargeWeapon", { right: "combat", run: chargeWeapon });
registerPlayerAction("scout", { right: "combat", run: scout });

Hooks.on("canvasTearDown", cancelTargeting);
