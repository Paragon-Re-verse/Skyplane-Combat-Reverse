/**
 * Сцена корабля и сцена боя: раскладка, тайлы, регионы, стены, перестройка.
 * Источник истины — актор корабля; сцена пишет обратно только позиции токенов.
 */
import {
  MODULE_ID, CELL_SIZE, GRID_SIZE, GRID_DISTANCE, PARAMS_WIDTH, DESCRIPTION_HEIGHT, SKY_WIDTH,
  SCENE_BACKGROUND, DESTROYED_TINT, SIDES, localize, format
} from "../constants.js";
import { isDestroyed, isDifficultTerrain, structureSignature, compartmentAtCell } from "../rules/ship-rules.js";
import { getShip, logSceneEvent } from "../documents/ship-actions.js";
import { wallDataForShip } from "./walls.js";
import { emitHook } from "../socket.js";

const CATEGORY_COLORS = {
  equipment: "#b08d57",
  recon: "#4f8a8b",
  control: "#3a6ea5",
  engine: "#9c5b2e",
  weapons: "#6b1f1a"
};

export function getLayout(scene) {
  return scene?.getFlag(MODULE_ID, "layout") ?? null;
}

function greatestCommonDivisor(first, second) {
  return second ? greatestCommonDivisor(second, first % second) : first;
}

// ponytail: заглушки нарисованы для соотношений сторон отсеков до 6×5, остальные берут ближайшее; добавить файлы, если появятся отсеки крупнее.
const PLACEHOLDER_RATIOS = [];
for (let width = 1; width <= 6; width++) {
  for (let height = 1; height <= 5; height++) {
    const divisor = greatestCommonDivisor(width, height);
    const key = `${width / divisor}x${height / divisor}`;
    if (!PLACEHOLDER_RATIOS.some((ratio) => ratio.key === key)) PLACEHOLDER_RATIOS.push({ key, value: Math.log(width / height) });
  }
}

/** Заглушка по категории и соотношению сторон отсека: тайл тянется на весь отсек без искажения иконки. */
export function placeholderFor(systemCategory, width = 1, height = 1) {
  const target = Math.log(width / height);
  const best = PLACEHOLDER_RATIOS.reduce((closest, ratio) => (Math.abs(ratio.value - target) < Math.abs(closest.value - target) ? ratio : closest));
  return `modules/${MODULE_ID}/assets/placeholders/${systemCategory || "equipment"}/${best.key}.svg`;
}

/** Стороны сцены с кораблями: [{side, ship, origin}] */
export function sceneSides(scene) {
  const layout = getLayout(scene);
  if (!layout) return [];
  return SIDES
    .filter((side) => layout.sides?.[side]?.actorUuid)
    .map((side) => ({ side, origin: layout.sides[side], ship: getShip(layout.sides[side].actorUuid) }))
    .filter((entry) => entry.ship);
}

export function scenesWithShip(ship) {
  return game.scenes.filter((scene) => sceneSides(scene).some((entry) => entry.ship === ship));
}

/** Области стороны в пикселях сцены: карта, параметры, описание. */
export function sideRects(layout, side) {
  const origin = layout.sides[side];
  const map = { x: origin.originX, y: origin.originY, width: origin.width, height: origin.height };
  const paramsX = side === "left" ? map.x - PARAMS_WIDTH : map.x + map.width;
  const params = { x: paramsX, y: map.y, width: PARAMS_WIDTH, height: map.height };
  const descriptionX = side === "left" ? paramsX : map.x;
  const description = { x: descriptionX, y: layout.descriptionY, width: PARAMS_WIDTH + map.width, height: DESCRIPTION_HEIGHT };
  return { map, params, description };
}

/** Квадрат корабля под точкой сцены, или null. */
export function compartmentAtPoint(scene, point) {
  for (const { side, origin, ship } of sceneSides(scene)) {
    const inside = point.x >= origin.originX && point.x < origin.originX + origin.width &&
      point.y >= origin.originY && point.y < origin.originY + origin.height;
    if (!inside) continue;
    const cellX = Math.floor((point.x - origin.originX) / CELL_SIZE) + 1;
    const cellY = Math.floor((point.y - origin.originY) / CELL_SIZE) + 1;
    return { side, ship, compartment: compartmentAtCell(ship.system.compartments, cellX, cellY) };
  }
  return null;
}

export function tokenCenter(tokenDocument) {
  const size = tokenDocument.parent?.grid?.size ?? GRID_SIZE;
  return { x: tokenDocument.x + (tokenDocument.width * size) / 2, y: tokenDocument.y + (tokenDocument.height * size) / 2 };
}

/** Раскладка: параметры | карта (| небо | карта | параметры), описание под ними. */
function computeLayout(mode, ships) {
  const maps = ships.map((ship) => ({ width: ship.system.gridWidth * CELL_SIZE, height: ship.system.gridHeight * CELL_SIZE }));
  const mapHeight = Math.max(...maps.map((map) => map.height));
  const sides = {
    left: { actorUuid: ships[0].uuid, originX: PARAMS_WIDTH, originY: 0, ...maps[0], signature: structureSignature(ships[0].system) }
  };
  let width = PARAMS_WIDTH + maps[0].width;
  if (mode === "battle") {
    sides.right = {
      actorUuid: ships[1].uuid, originX: width + SKY_WIDTH, originY: 0, ...maps[1], signature: structureSignature(ships[1].system)
    };
    width += SKY_WIDTH + maps[1].width + PARAMS_WIDTH;
  }
  return { width, height: mapHeight + DESCRIPTION_HEIGHT, sides, descriptionY: mapHeight };
}

function generatedFlag(side, instanceId) {
  return { [MODULE_ID]: { generated: { side, instanceId } } };
}

function movementDifficulties(value) {
  const difficulties = {};
  for (const [action, config] of Object.entries(CONFIG.Token.movement.actions)) {
    if (!config.deriveTerrainDifficulty) difficulties[action] = value;
  }
  return difficulties;
}

function compartmentRect(compartment, origin) {
  return {
    x: origin.originX + (compartment.x - 1) * CELL_SIZE,
    y: origin.originY + (compartment.y - 1) * CELL_SIZE,
    width: compartment.width * CELL_SIZE,
    height: compartment.height * CELL_SIZE
  };
}

function tileTint(compartment) {
  return isDestroyed(compartment) ? DESTROYED_TINT : "#ffffff";
}

function tileData(compartment, side, origin) {
  return {
    ...compartmentRect(compartment, origin),
    // «fill»: тайл ровно по отсеку. «cover» в v13 не обрезает текстуру, и она вылезает на соседей.
    texture: {
      src: compartment.img || placeholderFor(compartment.systemCategory, compartment.width, compartment.height),
      tint: tileTint(compartment),
      fit: "fill"
    },
    locked: true,
    flags: generatedFlag(side, compartment.instanceId)
  };
}

function regionData(ship, compartment, side, origin) {
  return {
    name: `${ship.name}: ${compartment.name}`,
    color: CATEGORY_COLORS[compartment.systemCategory] ?? CATEGORY_COLORS.equipment,
    shapes: [{ type: "rectangle", ...compartmentRect(compartment, origin), rotation: 0, hole: false }],
    visibility: CONST.REGION_VISIBILITY.LAYER,
    behaviors: [{
      type: "modifyMovementCost",
      name: localize("region.difficult"),
      disabled: !isDifficultTerrain(compartment),
      system: { difficulties: movementDifficulties(2) }
    }],
    flags: generatedFlag(side, compartment.instanceId)
  };
}

function isGenerated(document) {
  return !!document.getFlag(MODULE_ID, "generated");
}

/** Удаляет и создаёт заново только сгенерированные объекты, одним пакетом на тип. */
async function replaceGeneratedObjects(scene, layout) {
  for (const collection of ["Tile", "Region", "Wall"]) {
    const ids = scene.getEmbeddedCollection(collection).filter(isGenerated).map((document) => document.id);
    if (ids.length) await scene.deleteEmbeddedDocuments(collection, ids);
  }
  const tiles = [];
  const regions = [];
  const walls = [];
  for (const side of SIDES) {
    const origin = layout.sides[side];
    const ship = getShip(origin?.actorUuid);
    if (!ship) continue;
    for (const compartment of ship.system.compartments) {
      tiles.push(tileData(compartment, side, origin));
      regions.push(regionData(ship, compartment, side, origin));
    }
    walls.push(...wallDataForShip(ship, side, origin));
  }
  if (tiles.length) await scene.createEmbeddedDocuments("Tile", tiles);
  if (regions.length) await scene.createEmbeddedDocuments("Region", regions);
  if (walls.length) await scene.createEmbeddedDocuments("Wall", walls);
}

function tokensOutsideCompartments(scene) {
  return scene.tokens.filter((token) => !compartmentAtPoint(scene, tokenCenter(token))?.compartment).map((token) => token.name);
}

function warnTokensOutside(scene) {
  const names = tokensOutsideCompartments(scene);
  if (names.length) ui.notifications.warn(format("notify.tokensOutside", { names: names.join(", ") }), { permanent: true });
}

function sceneData(name, layout, mode, ships) {
  return {
    name,
    width: layout.width,
    height: layout.height,
    padding: 0,
    backgroundColor: SCENE_BACKGROUND,
    grid: { type: CONST.GRID_TYPES.SQUARE, size: GRID_SIZE, distance: GRID_DISTANCE, units: "ft" },
    tokenVision: false,
    fog: { exploration: false },
    initial: { x: layout.width / 2, y: layout.height / 2, scale: 0.35 },
    flags: {
      [MODULE_ID]: {
        layout: {
          mode,
          sides: layout.sides,
          descriptionY: layout.descriptionY,
          reveal: { left: false, right: false },
          manualReveal: { left: false, right: false }
        }
      }
    },
    navName: ships.map((ship) => ship.name).join(" — ")
  };
}

/**
 * Перестройка: новые размеры из текущих листов, токены сдвигаются вместе с картой своего корабля,
 * ручные объекты ГМа не трогаются. orderedShips меняет стороны местами (повторный «Начать бой…»).
 */
export async function rebuildScene(scene, orderedShips = null) {
  if (!game.user.isGM) return ui.notifications.warn(localize("notify.gmOnly"));
  const oldLayout = getLayout(scene);
  if (!oldLayout) return ui.notifications.warn(localize("notify.notModuleScene"));
  const ships = orderedShips ?? SIDES.map((side) => getShip(oldLayout.sides?.[side]?.actorUuid)).filter(Boolean);
  if (!ships.length || (oldLayout.mode === "battle" && ships.length < 2)) return ui.notifications.warn(localize("notify.shipMissing"));

  const layout = computeLayout(oldLayout.mode, ships);
  const swapped = oldLayout.mode === "battle" && oldLayout.sides?.left?.actorUuid !== layout.sides.left.actorUuid;
  const tokenMoves = [];
  for (const side of SIDES) {
    const after = layout.sides[side];
    const before = Object.values(oldLayout.sides ?? {}).find((origin) => origin?.actorUuid === after?.actorUuid);
    if (!before || !after) continue;
    const deltaX = after.originX - before.originX;
    const deltaY = after.originY - before.originY;
    if (!deltaX && !deltaY) continue;
    for (const token of scene.tokens) {
      const center = tokenCenter(token);
      const inside = center.x >= before.originX && center.x < before.originX + before.width &&
        center.y >= before.originY && center.y < before.originY + before.height;
      if (inside) tokenMoves.push({ _id: token.id, x: token.x + deltaX, y: token.y + deltaY });
    }
  }

  await scene.update({
    width: layout.width,
    height: layout.height,
    [`flags.${MODULE_ID}.layout.sides`]: layout.sides,
    [`flags.${MODULE_ID}.layout.descriptionY`]: layout.descriptionY,
    ...(swapped && {
      [`flags.${MODULE_ID}.layout.manualReveal`]: { left: !!oldLayout.manualReveal?.right, right: !!oldLayout.manualReveal?.left },
      [`flags.${MODULE_ID}.layout.override`]: { left: oldLayout.override?.right ?? null, right: oldLayout.override?.left ?? null },
      [`flags.${MODULE_ID}.layout.reveal`]: { left: !!oldLayout.reveal?.right, right: !!oldLayout.reveal?.left }
    })
  });
  if (tokenMoves.length) {
    // Сдвиг вместе с картой — не ход: на отрисованной сцене v13 иначе остановит токен о стены.
    const movement = Object.fromEntries(tokenMoves.map((move) => [move._id, {
      constrainOptions: { ignoreWalls: true, ignoreCost: true }, autoRotate: false, showRuler: false
    }]));
    await scene.updateEmbeddedDocuments("Token", tokenMoves, { animate: false, movement });
  }
  await replaceGeneratedObjects(scene, { ...oldLayout, ...layout });
  warnTokensOutside(scene);
  for (const ship of ships) await logSceneEvent(ship, format("log.scene.rebuilt", { scene: scene.name }));
  emitHook("sceneBuilt", scene, ships);
  return scene;
}

/** Создаёт сцену корабля или перестраивает уже развёрнутую. */
export async function deployShip(ship) {
  if (!game.user.isGM) return ui.notifications.warn(localize("notify.gmOnly"));
  if (ship.system.validation.errors.length) ui.notifications.warn(localize("notify.deployWithErrors"));
  const existing = game.scenes.get(ship.getFlag(MODULE_ID, "sceneId"));
  if (existing && getLayout(existing)?.mode === "ship") return rebuildScene(existing);

  const layout = computeLayout("ship", [ship]);
  const scene = await Scene.create(sceneData(ship.name, layout, "ship", [ship]));
  await ship.setFlag(MODULE_ID, "sceneId", scene.id);
  await replaceGeneratedObjects(scene, getLayout(scene));
  await logSceneEvent(ship, format("log.scene.deployed", { scene: scene.name }));
  emitHook("sceneBuilt", scene, [ship]);
  return scene;
}

function findBattleScene(left, right) {
  return game.scenes.find((scene) => {
    const layout = getLayout(scene);
    if (layout?.mode !== "battle") return false;
    const pair = [layout.sides?.left?.actorUuid, layout.sides?.right?.actorUuid];
    return pair.includes(left.uuid) && pair.includes(right.uuid);
  });
}

/** Токены со сцен кораблей переносятся в те же места карты на сцене боя. */
function copiedTokens(ship, targetOrigin) {
  const shipScene = game.scenes.get(ship.getFlag(MODULE_ID, "sceneId"));
  const sourceOrigin = getLayout(shipScene)?.sides?.left;
  if (!shipScene || !sourceOrigin) return [];
  return shipScene.tokens
    .filter((token) => {
      const center = tokenCenter(token);
      return center.x >= sourceOrigin.originX && center.x < sourceOrigin.originX + sourceOrigin.width &&
        center.y >= sourceOrigin.originY && center.y < sourceOrigin.originY + sourceOrigin.height;
    })
    .map((token) => {
      const data = token.toObject();
      delete data._id;
      data.x += targetOrigin.originX - sourceOrigin.originX;
      data.y += targetOrigin.originY - sourceOrigin.originY;
      return data;
    });
}

/** Сцена боя: корабль, из которого начали, — слева. */
export async function startBattle(leftShip, rightShip) {
  if (!game.user.isGM) return ui.notifications.warn(localize("notify.gmOnly"));
  const left = getShip(leftShip);
  const right = getShip(rightShip);
  if (!left || !right || left === right) return ui.notifications.warn(localize("notify.battlePair"));

  let scene = findBattleScene(left, right);
  const created = !scene;
  if (scene) {
    const layout = getLayout(scene);
    const oldName = format("scene.battleName", { left: getShip(layout.sides.left.actorUuid)?.name, right: getShip(layout.sides.right.actorUuid)?.name });
    // Имя, данное ГМом вручную, не трогаем; стандартное следует за порядком сторон.
    if (scene.name === oldName) await scene.update({ name: format("scene.battleName", { left: left.name, right: right.name }) });
    await rebuildScene(scene, [left, right]);
  } else {
    const layout = computeLayout("battle", [left, right]);
    scene = await Scene.create(sceneData(format("scene.battleName", { left: left.name, right: right.name }), layout, "battle", [left, right]));
    await replaceGeneratedObjects(scene, getLayout(scene));
    const tokens = [...copiedTokens(left, layout.sides.left), ...copiedTokens(right, layout.sides.right)];
    if (tokens.length) await scene.createEmbeddedDocuments("Token", tokens);
    emitHook("sceneBuilt", scene, [left, right]);
  }
  if (created) {
    // Фаза боя начинается на средней дистанции.
    for (const ship of [left, right]) if (ship.system.combatDistance !== "medium") await ship.update({ "system.combatDistance": "medium" });
  } else if (right.system.combatDistance !== left.system.combatDistance) {
    await right.update({ "system.combatDistance": left.system.combatDistance });
  }
  for (const ship of [left, right]) await logSceneEvent(ship, format("log.scene.battle", { scene: scene.name }));
  return scene;
}

/** Подтверждение перестройки: ручные правки сгенерированных объектов теряются. */
export async function confirmAndRebuild(scene) {
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: localize("rebuild.title") },
    content: `<p>${localize("rebuild.warning")}</p>`
  });
  if (confirmed) await rebuildScene(scene);
}

/** Устарела ли сцена: форма корабля изменилась после построения. */
export function isSceneStale(scene) {
  return sceneSides(scene).some(({ ship, origin }) => origin.signature !== structureSignature(ship.system));
}

/**
 * Точечная синхронизация после смены HP: tint тайла и труднопроходимость региона,
 * только там, где состояние «цел / повреждён / разрушен» изменилось.
 */
export async function syncSceneState(scene, ship) {
  const sides = sceneSides(scene).filter((entry) => entry.ship === ship).map((entry) => entry.side);
  if (!sides.length) return;
  const tileUpdates = [];
  for (const compartment of ship.system.compartments) {
    for (const side of sides) {
      const matches = (document) => {
        const generated = document.getFlag(MODULE_ID, "generated");
        return generated?.side === side && generated.instanceId === compartment.instanceId;
      };
      const tile = scene.tiles.find(matches);
      const tint = tileTint(compartment);
      if (tile && (tile._source.texture.tint ?? "#ffffff").toLowerCase() !== tint) tileUpdates.push({ _id: tile.id, "texture.tint": tint });
      const behavior = scene.regions.find(matches)?.behaviors.find((entry) => entry.type === "modifyMovementCost");
      const disabled = !isDifficultTerrain(compartment);
      if (behavior && behavior.disabled !== disabled) await behavior.update({ disabled });
    }
  }
  if (tileUpdates.length) await scene.updateEmbeddedDocuments("Tile", tileUpdates);
}

export function registerSceneSync() {
  Hooks.on("updateActor", (actor, changed) => {
    if (!game.user.isGM || game.users.activeGM !== game.user || !changed.system?.compartments) return;
    const ship = getShip(actor);
    if (!ship) return;
    for (const scene of scenesWithShip(ship)) syncSceneState(scene, ship);
  });
}
