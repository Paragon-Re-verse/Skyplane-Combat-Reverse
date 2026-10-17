/**
 * Разведка (радар) на сцене боя.
 * Клиент ГМа пересчитывает флаг reveal сцены; каждый клиент сам прячет лишнее для своей стороны,
 * поле hidden документов не меняется.
 * reveal.left = true — сторона left видит корабль противника.
 */
import { MODULE_ID, SIDES, format } from "../constants.js";
import { isFunctioning } from "../rules/ship-rules.js";
import { getShip, logSceneEvent, ownedCrewActors } from "../documents/ship-actions.js";
import { getLayout, sceneSides, compartmentAtPoint, tokenCenter } from "./scene-builder.js";
import { emitHook } from "../socket.js";

function opposite(side) {
  return side === "left" ? "right" : "left";
}

function baseActorUuid(tokenDocument) {
  return tokenDocument.actorId ? `Actor.${tokenDocument.actorId}` : null;
}

/**
 * Сторона пользователя — то же правило, что у прав матрицы: корабль, в экипаже которого есть его актёр.
 * Если его актёры на обоих кораблях, решает назначенный персонаж.
 */
export function userSide(scene, user = game.user) {
  const sides = sceneSides(scene).filter(({ ship }) => ownedCrewActors(user, ship).length > 0);
  if (sides.length <= 1) return sides[0]?.side ?? null;
  const characterUuid = user.character?.uuid;
  return (sides.find(({ ship }) => ship.system.crew.some((member) => member.actorUuid === characterUuid)) ?? sides[0]).side;
}

/**
 * Видит ли сторона viewer противника: решение ГМа («reveal» / «hide») главнее разведки.
 * Старые сцены хранили только ручное раскрытие в manualReveal — оно читается как «reveal».
 * @returns {{revealed: boolean, source: "gm"|"recon"|null, override: "reveal"|"hide"|null}}
 */
export function revealState(layout, viewer) {
  const override = layout?.override?.[viewer] ?? (layout?.manualReveal?.[viewer] ? "reveal" : null);
  if (override) return { revealed: override === "reveal", source: "gm", override };
  const recon = !!layout?.reveal?.[viewer];
  return { revealed: recon, source: recon ? "recon" : null, override: null };
}

/** Виден ли корабль стороны side этому пользователю целиком. */
export function isSideRevealed(scene, side, user = game.user) {
  const layout = getLayout(scene);
  if (user.isGM || layout?.mode !== "battle") return true;
  const mySide = userSide(scene, user);
  const seenBy = (viewer) => revealState(layout, viewer).revealed;
  if (mySide === side) return true;
  if (mySide) return seenBy(mySide);
  // Игрок без стороны видит корабль, если его раскрыла противоположная сторона.
  return seenBy(opposite(side));
}

/** Сторона, на чьей карте стоит токен, если она скрыта от пользователя и токен не своей стороны. */
function isTokenHidden(tokenDocument) {
  const scene = tokenDocument.parent;
  if (game.user.isGM || getLayout(scene)?.mode !== "battle") return false;
  const location = compartmentAtPoint(scene, tokenCenter(tokenDocument));
  if (!location || isSideRevealed(scene, location.side)) return false;
  if (tokenDocument.isOwner) return false;
  const mySide = userSide(scene);
  const myShip = sceneSides(scene).find((entry) => entry.side === mySide)?.ship;
  const actorUuid = baseActorUuid(tokenDocument);
  return !myShip?.system.crew.some((member) => member.actorUuid === actorUuid);
}

function isTileHidden(tileDocument) {
  if (game.user.isGM) return false;
  const generated = tileDocument.getFlag(MODULE_ID, "generated");
  return !!generated && !isSideRevealed(tileDocument.parent, generated.side);
}

/** Подмена isVisible у базовых классов Token и Tile: скрытие на клиенте без записи в базу. */
export function patchVisibility() {
  const { Token, Tile } = foundry.canvas.placeables;
  for (const [cls, isHidden] of [[Token, (placeable) => isTokenHidden(placeable.document)], [Tile, (placeable) => isTileHidden(placeable.document)]]) {
    const descriptor = Object.getOwnPropertyDescriptor(cls.prototype, "isVisible");
    Object.defineProperty(cls.prototype, "isVisible", {
      configurable: true,
      get() {
        if (getLayout(this.document.parent)?.mode === "battle" && isHidden(this)) return false;
        return descriptor.get.call(this);
      }
    });
  }
}

export function refreshPlaceablesVisibility() {
  if (!canvas.ready) return;
  for (const token of canvas.tokens.placeables) token.renderFlags.set({ refreshVisibility: true });
  for (const tile of canvas.tiles.placeables) tile.renderFlags.set({ refreshState: true });
}

/** Стоит ли токен экипажа стороны в целом отсеке «Разведка» своего корабля. */
export function isTokenOnRecon(scene, token, side) {
  const ship = sceneSides(scene).find((entry) => entry.side === side)?.ship;
  if (!ship?.system.crew.some((member) => member.actorUuid === baseActorUuid(token))) return false;
  const location = compartmentAtPoint(scene, tokenCenter(token));
  return location?.side === side && location.compartment?.systemCategory === "recon" && isFunctioning(location.compartment);
}

/**
 * Сторона видит противника, пока в целом отсеке «Разведка» своего корабля стоит член экипажа,
 * прошедший проверку разведки. Ушёл из отсека — проверку нужно пройти заново.
 */
function computeReveal(scene, layout = getLayout(scene)) {
  const reveal = {};
  const scouted = {};
  for (const { side } of sceneSides(scene)) {
    scouted[side] = (layout.scouted?.[side] ?? []).filter((tokenId) => {
      const token = scene.tokens.get(tokenId);
      return token && isTokenOnRecon(scene, token, side);
    });
    reveal[side] = scouted[side].length > 0;
  }
  return { reveal, scouted };
}

async function updateReveal(scene, extraScouted = null) {
  // Разведчика добавляет ГМ, исполняющий действие игрока; пересчёт по движению токенов — только активный ГМ.
  if (!game.user.isGM || (!extraScouted && game.users.activeGM !== game.user)) return;
  const layout = foundry.utils.deepClone(getLayout(scene));
  if (layout?.mode !== "battle") return;
  if (extraScouted) {
    const list = new Set(layout.scouted?.[extraScouted.side] ?? []).add(extraScouted.tokenId);
    layout.scouted = { ...layout.scouted, [extraScouted.side]: [...list] };
  }
  const { reveal, scouted } = computeReveal(scene, layout);
  const changedSides = SIDES.filter((side) => !!layout.reveal?.[side] !== !!reveal[side]);
  const scoutedChanged = SIDES.some((side) => (getLayout(scene).scouted?.[side] ?? []).join() !== (scouted[side] ?? []).join());
  if (!changedSides.length && !scoutedChanged) return;
  await scene.update({
    [`flags.${MODULE_ID}.layout.reveal`]: { ...layout.reveal, ...reveal },
    [`flags.${MODULE_ID}.layout.scouted`]: { left: scouted.left ?? [], right: scouted.right ?? [] }
  });
  for (const side of changedSides) {
    const target = sceneSides(scene).find((entry) => entry.side === opposite(side))?.ship;
    if (target && reveal[side]) await logSceneEvent(target, format("log.scene.revealed", { scene: scene.name }));
    emitHook("revealChanged", scene, side, !!reveal[side]);
  }
}

/** Успешная проверка разведки: токен попадает в список разведчиков стороны (вызывает клиент ГМа). */
export async function markScouted(scene, side, tokenId) {
  await updateReveal(scene, { side, tokenId });
  return revealState(getLayout(scene), side).revealed;
}

/**
 * Решение ГМа для стороны side: true — раскрыть, false — скрыть даже при разведке,
 * null — вернуть «авто» (по разведке).
 */
export async function setReveal(scene, side, revealed) {
  if (!game.user.isGM || !SIDES.includes(side)) return;
  const layout = getLayout(scene);
  if (layout?.mode !== "battle") return;
  const before = revealState(layout, side).revealed;
  const override = revealed === true ? "reveal" : revealed === false ? "hide" : null;
  await scene.update({
    [`flags.${MODULE_ID}.layout.override`]: { ...layout.override, [side]: override },
    [`flags.${MODULE_ID}.layout.manualReveal`]: { ...layout.manualReveal, [side]: false }
  });
  const after = revealState(getLayout(scene), side).revealed;
  const target = sceneSides(scene).find((entry) => entry.side === opposite(side))?.ship;
  if (target && override === "reveal") await logSceneEvent(target, format("log.scene.revealedManual", { scene: scene.name }));
  if (before !== after) emitHook("revealChanged", scene, side, after);
}

export function registerReveal() {
  const recompute = (scene) => {
    if (game.user.isGM && getLayout(scene)?.mode === "battle") updateReveal(scene);
  };
  Hooks.on("createToken", (token) => recompute(token.parent));
  Hooks.on("deleteToken", (token) => recompute(token.parent));
  Hooks.on("updateToken", (token, changed) => {
    if ("x" in changed || "y" in changed || "actorId" in changed) recompute(token.parent);
  });
  Hooks.on("updateActor", (actor, changed) => {
    if (!changed.system?.compartments && !changed.system?.crew) return;
    const ship = getShip(actor);
    if (!ship) return;
    for (const scene of game.scenes) {
      if (sceneSides(scene).some((entry) => entry.ship === ship)) recompute(scene);
    }
  });
  Hooks.on("canvasReady", () => recompute(canvas.scene));

  // Смена раскрытия, состава экипажа или персонажа игрока — пересчёт видимости на этом клиенте.
  // На обычных сценах хуки выходят сразу.
  const onBattle = () => canvas.ready && getLayout(canvas.scene)?.mode === "battle";
  Hooks.on("updateScene", (scene, changed) => {
    if (scene === canvas.scene && onBattle() && foundry.utils.hasProperty(changed, `flags.${MODULE_ID}`)) refreshPlaceablesVisibility();
  });
  Hooks.on("updateUser", (user, changed) => {
    if (user === game.user && onBattle() && "character" in changed) refreshPlaceablesVisibility();
  });
  Hooks.on("updateActor", (actor, changed) => {
    if (onBattle() && getShip(actor) && changed.system?.crew) refreshPlaceablesVisibility();
  });
  Hooks.on("updateToken", (token, changed) => {
    if (token.parent === canvas.scene && onBattle() && ("x" in changed || "y" in changed)) refreshPlaceablesVisibility();
  });
}
