/**
 * game.modules.get("skyplane-combat-reverse").api
 * Методы принимают актора или его UUID; вызов игроком проходит те же проверки прав, что и кнопки.
 */
import { localize } from "./constants.js";
import {
  getShip, damageShip, healShip, damageCompartment, markRepairItem
} from "./documents/ship-actions.js";
import { deployShip, rebuildScene, startBattle } from "./scene/scene-builder.js";
import { setReveal } from "./scene/reveal.js";
import { requestAction } from "./socket.js";
import { openBattlePanel } from "./apps/battle-panel.js";
import { startShot, startScouting } from "./combat/ship-combat.js";

function requireShip(shipOrUuid) {
  const ship = getShip(shipOrUuid);
  if (!ship) throw new Error(localize("notify.shipMissing"));
  return ship;
}

function resolveScene(sceneOrId) {
  if (typeof sceneOrId !== "string") return sceneOrId;
  return game.scenes.get(sceneOrId) ?? fromUuidSync(sceneOrId);
}

export const api = {
  deployShip: (ship) => deployShip(requireShip(ship)),
  rebuildScene: (scene) => rebuildScene(resolveScene(scene)),
  startBattle: (left, right) => startBattle(requireShip(left), requireShip(right)),
  damageShip: (ship, amount) => damageShip(requireShip(ship), amount),
  healShip: (ship, amount) => healShip(requireShip(ship), amount),
  damageCompartment: (ship, instanceId, amount) => damageCompartment(requireShip(ship), instanceId, amount),
  repairCompartment: (ship, instanceId, { amount, itemUuid } = {}) =>
    requestAction("repairCompartment", requireShip(ship), { instanceId, amount, itemUuid }),
  setPhlogiston: (ship, value) => requestAction("setPhlogiston", requireShip(ship), { value }),
  setDistance: (ship, value) => requestAction("setDistance", requireShip(ship), { value }),
  setReveal: (scene, side, revealed) => setReveal(resolveScene(scene), side, revealed),
  validateShip: (ship) => requireShip(ship).system.validation,
  markRepairItem: (item, amount) => markRepairItem(item, amount),
  openBattlePanel: () => openBattlePanel(),
  fireWeapon: (ship, instanceId) => startShot(requireShip(ship), instanceId),
  scout: (ship, instanceId) => startScouting(requireShip(ship), instanceId)
};
