/**
 * Надписи, рамки и области параметров и описания на канве каждого клиента.
 * Ничего не хранится документами: перерисовка с задержкой при изменении акторов текущей сцены.
 */
import { MODULE_ID, HOOK_PREFIX, CELL_SIZE, SKY_WIDTH, PALETTE, OVERLAY_DEBOUNCE_MS, DISTANCES, localize, format } from "../constants.js";
import { isDestroyed, isDamaged } from "../rules/ship-rules.js";
import { getShip } from "../documents/ship-actions.js";
import { getLayout, sceneSides, sideRects, isSceneStale, confirmAndRebuild } from "./scene-builder.js";
import { isSideRevealed } from "./reveal.js";
import { openCompartmentWindow } from "../apps/compartment-window.js";

const HEADING_FONT = "Modesto Condensed";
const BODY_FONT = "Signika";
const PADDING = 60;
/** Полоса под номера строк и столбцов между картой и рамками областей. */
const GUTTER = 80;

let container = null;
let mapLayer = null;
let hotspots = null;

/** Слой карты (сетка, рамки, плашки, силуэты, небо) лежит в основной группе выше тайлов и ниже токенов. */
const MAP_SORT_LAYER = 650;

function clearLayers() {
  for (const layer of [container, mapLayer, hotspots]) layer?.destroy({ children: true });
  container = mapLayer = hotspots = null;
}
let redrawTimer = null;

function text(content, { size = 26, color = PALETTE.ink, font = BODY_FONT, bold = false, italic = false, wrap = 0, align = "left" } = {}) {
  const style = new PIXI.TextStyle({
    fontFamily: font,
    fontSize: size,
    fill: color,
    fontWeight: bold ? "bold" : "normal",
    fontStyle: italic ? "italic" : "normal",
    wordWrap: wrap > 0,
    wordWrapWidth: wrap,
    breakWords: true,
    align,
    // PIXI занижает высоту глифов (особенно у Modesto Condensed) и срезает низ букв; запас это лечит.
    padding: Math.ceil(size * 0.3)
  });
  return new foundry.canvas.containers.PreciseText(String(content ?? ""), style);
}

/** Наибольший кегль от max до min, при котором самое длинное слово помещается в строку без разрыва. */
function fittingSize(content, width, max, min) {
  const longest = String(content ?? "").split(/\s+/).reduce((best, word) => (word.length > best.length ? word : best), "");
  for (let size = max; size > min; size -= 2) {
    const style = new PIXI.TextStyle({ fontFamily: BODY_FONT, fontSize: size, fontWeight: "bold" });
    if (PIXI.TextMetrics.measureText(longest, style).width <= width) return size;
  }
  return min;
}

/**
 * Кликабельная зона в координатах сцены. Зоны лежат над слоем токенов (иначе активный слой
 * перехватывает все клики), но пропускают клик, если в точке стоит видимый токен.
 */
function addHotspot(rect, handler) {
  const hotspot = new PIXI.Container();
  hotspot.hitArea = {
    contains: (x, y) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height &&
      !canvas.tokens.placeables.some((token) => token.visible && token.bounds.contains(x, y))
  };
  hotspot.eventMode = "static";
  hotspot.cursor = "pointer";
  hotspot.on("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    handler();
  });
  hotspots.addChild(hotspot);
}

/** Рамка в стиле листа: пергамент, двойная латунная рамка, заклёпки в углах. */
function drawFrame(graphics, rect, { fill = PALETTE.parchment, alpha = 1 } = {}) {
  graphics.beginFill(fill, alpha).drawRect(rect.x, rect.y, rect.width, rect.height).endFill();
  graphics.lineStyle(8, PALETTE.brass, 1).drawRect(rect.x + 6, rect.y + 6, rect.width - 12, rect.height - 12);
  graphics.lineStyle(3, PALETTE.brass, 1).drawRect(rect.x + 22, rect.y + 22, rect.width - 44, rect.height - 44);
  graphics.lineStyle(0);
  for (const [x, y] of [[rect.x + 22, rect.y + 22], [rect.x + rect.width - 22, rect.y + 22], [rect.x + 22, rect.y + rect.height - 22], [rect.x + rect.width - 22, rect.y + rect.height - 22]]) {
    graphics.beginFill(PALETTE.copper).drawCircle(x, y, 11).endFill();
    graphics.beginFill(0xf6d8a8, 0.8).drawCircle(x - 3, y - 3, 4).endFill();
  }
}

function clipTo(displayObject, rect, parent) {
  const mask = new PIXI.Graphics().beginFill(0xffffff).drawRect(rect.x, rect.y, rect.width, rect.height).endFill();
  parent.addChild(mask);
  displayObject.mask = mask;
}

// ponytail: длина строки оценивается по средней ширине символа (0.5 кегля), без измерения шрифта.
function clampLines(content, width, size, lines) {
  if (!content) return "";
  const limit = Math.floor(width / (size * 0.5)) * lines;
  if (content.length <= limit) return content;
  return `${content.slice(0, limit - 1).replace(/\s+\S*$/, "")}…`;
}

function stripHtml(html) {
  const element = document.createElement("div");
  element.innerHTML = html ?? "";
  return element.textContent.replace(/\n{3,}/g, "\n\n").trim();
}

/* ---------------- Карта корабля ---------------- */

function drawMap(parent, { ship, side, origin }, rects, revealed) {
  const graphics = parent.addChild(new PIXI.Graphics());
  const { map } = rects;
  const { gridWidth, gridHeight, compartments } = ship.system;
  const occupied = new Set();
  for (const compartment of compartments) {
    for (let dx = 0; dx < compartment.width; dx++) {
      for (let dy = 0; dy < compartment.height; dy++) occupied.add(`${compartment.x + dx},${compartment.y + dy}`);
    }
  }

  graphics.lineStyle(2, PALETTE.brass, 0.35);
  for (let x = 1; x <= gridWidth; x++) {
    for (let y = 1; y <= gridHeight; y++) {
      if (!occupied.has(`${x},${y}`)) graphics.drawRect(map.x + (x - 1) * CELL_SIZE, map.y + (y - 1) * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    }
  }
  graphics.lineStyle(10, PALETTE.brass, 1, 0).drawRect(map.x, map.y, map.width, map.height);
  graphics.lineStyle(0);

  // Номера столбцов под картой, номера строк со стороны параметров.
  for (let x = 1; x <= gridWidth; x++) {
    const label = parent.addChild(text(x, { size: 52, color: PALETTE.brass, bold: true }));
    label.anchor.set(0.5);
    label.position.set(map.x + (x - 0.5) * CELL_SIZE, map.y + map.height + GUTTER / 2);
  }
  for (let y = 1; y <= gridHeight; y++) {
    const label = parent.addChild(text(y, { size: 52, color: PALETTE.brass, bold: true }));
    label.anchor.set(0.5);
    label.position.set(side === "left" ? map.x - GUTTER / 2 : map.x + map.width + GUTTER / 2, map.y + (y - 0.5) * CELL_SIZE);
  }

  for (const compartment of compartments) {
    const rect = {
      x: origin.originX + (compartment.x - 1) * CELL_SIZE,
      y: origin.originY + (compartment.y - 1) * CELL_SIZE,
      width: compartment.width * CELL_SIZE,
      height: compartment.height * CELL_SIZE
    };
    if (!revealed) {
      graphics.beginFill(PALETTE.silhouette, 0.95).lineStyle(4, 0x3b2a1d, 1).drawRect(rect.x, rect.y, rect.width, rect.height).endFill();
      graphics.lineStyle(0);
      continue;
    }
    graphics.lineStyle(4, PALETTE.wood, 0.9).drawRect(rect.x, rect.y, rect.width, rect.height).lineStyle(0);

    const plate = parent.addChild(new PIXI.Container());
    const destroyed = isDestroyed(compartment);
    const hpText = compartment.isNoHp
      ? localize("compartment.noHp")
      : format("overlay.hp", { value: compartment.currentHp, max: compartment.maxHp });
    const nameSize = fittingSize(compartment.name, rect.width - 20, 34, 22);
    const nameLabel = text(compartment.name, { size: nameSize, color: PALETTE.parchment, bold: true, wrap: rect.width - 20 });
    const hpLabel = text(destroyed ? `${hpText} · ${localize("compartment.destroyed")}` : hpText, {
      size: 30, color: destroyed ? 0xff8a7a : isDamaged(compartment) ? 0xf2c46b : PALETTE.parchment
    });
    nameLabel.position.set(10, 4);
    hpLabel.position.set(10, 6 + nameLabel.height);
    const background = new PIXI.Graphics()
      .beginFill(PALETTE.wood, 0.78)
      .drawRect(0, 0, rect.width, Math.min(rect.height, nameLabel.height + hpLabel.height + 14))
      .endFill();
    plate.addChild(background, nameLabel, hpLabel);
    plate.position.set(rect.x, rect.y);
    addHotspot({ x: rect.x, y: rect.y, width: rect.width, height: background.height }, () => openCompartmentWindow(ship, compartment.instanceId));
  }
}

/* ---------------- Параметры ---------------- */

/** Вертикальная колонка с курсором: элементы встают друг под другом. */
function column(parent, x, y) {
  const container = parent.addChild(new PIXI.Container());
  container.position.set(x, y);
  let cursor = 0;
  return {
    container,
    get height() {
      return cursor;
    },
    add(displayObject, gap = 18) {
      displayObject.position.set(displayObject.position.x, cursor);
      container.addChild(displayObject);
      cursor += displayObject.height + gap;
      return displayObject;
    }
  };
}

function hpBar(system, width) {
  const bar = new PIXI.Container();
  const fraction = system.maxHp > 0 ? Math.max(0, Math.min(1, system.currentHp / system.maxHp)) : 0;
  const graphics = new PIXI.Graphics()
    .beginFill(0xd9c9a3).lineStyle(4, PALETTE.wood).drawRect(0, 0, width, 70).endFill()
    .lineStyle(0).beginFill(PALETTE.burgundy).drawRect(4, 4, (width - 8) * fraction, 62).endFill();
  const label = text(`${system.currentHp} / ${system.maxHp}`, { size: 46, color: PALETTE.parchment, bold: true });
  label.anchor.set(0.5);
  label.position.set(width / 2, 35);
  bar.addChild(graphics, label);
  return bar;
}

function phlogistonScale(system, width) {
  const scale = new PIXI.Container();
  const boxWidth = Math.min(170, (width - 50) / 6);
  [5, 4, 3, 2, 1, 0].forEach((value, index) => {
    const active = value === system.phlogiston;
    const box = new PIXI.Graphics()
      .lineStyle(4, PALETTE.wood)
      .beginFill(active ? PALETTE.copper : 0xe8dab8)
      .drawRect(index * (boxWidth + 10), 0, boxWidth, 96)
      .endFill();
    const label = text(value === 0 ? "!" : value, { size: 60, bold: true, color: active ? PALETTE.parchment : PALETTE.wood });
    label.anchor.set(0.5);
    label.position.set(index * (boxWidth + 10) + boxWidth / 2, 48);
    scale.addChild(box, label);
  });
  return scale;
}

function distancePlates(system, width) {
  const plates = new PIXI.Container();
  const plateWidth = (width - 20) / 2;
  const contents = DISTANCES.map((distance) => {
    const active = distance === system.combatDistance;
    const color = active ? PALETTE.parchment : PALETTE.ink;
    const name = text(localize(`distance.${distance}.label`), { size: 42, bold: true, color });
    const effect = text(localize(`distance.${distance}.effect`), { size: 28, wrap: plateWidth - 28, color });
    name.position.set(14, 10);
    effect.position.set(14, 18 + name.height);
    return { distance, active, name, effect };
  });
  // Все плашки одной высоты — по самому длинному описанию.
  const plateHeight = Math.max(...contents.map(({ name, effect }) => name.height + effect.height)) + 46;
  contents.forEach(({ active, name, effect }, index) => {
    const plate = new PIXI.Container();
    plate.addChild(new PIXI.Graphics().lineStyle(4, PALETTE.wood).beginFill(active ? PALETTE.burgundy : 0xe8dab8)
      .drawRect(0, 0, plateWidth, plateHeight).endFill(), name, effect);
    plate.position.set((index % 2) * (plateWidth + 20), Math.floor(index / 2) * (plateHeight + 14));
    plates.addChild(plate);
  });
  return plates;
}

/** Параметры: имя и класс на всю ширину, ниже две колонки — характеристики и флогистон с дистанцией. */
function drawParams(parent, ship, rects, revealed) {
  const nearMapOnRight = rects.params.x + rects.params.width === rects.map.x;
  const params = {
    ...rects.params,
    x: nearMapOnRight ? rects.params.x : rects.params.x + GUTTER,
    width: rects.params.width - GUTTER
  };
  drawFrame(parent.addChild(new PIXI.Graphics()), params);
  const content = parent.addChild(new PIXI.Container());
  const width = params.width - PADDING * 2;
  const header = column(content, 0, 0);
  const title = header.add(text(ship.name, { size: 110, color: PALETTE.burgundy, font: HEADING_FONT, wrap: width }), 16);
  if (ship.system.shipClass) header.add(text(ship.system.shipClass, { size: 54, italic: true, wrap: width }), 30);
  let height = header.height;

  if (revealed) {
    const system = ship.system;
    const gap = 40;
    const columnWidth = (width - gap) / 2;
    const left = column(content, 0, header.height);
    const right = column(content, columnWidth + gap, header.height);
    const captain = fromUuidSync(system.captainUuid)?.name ?? localize("crew.noCaptain");
    left.add(text(`${localize("params.captain")}: ${captain}`, { size: 46, wrap: columnWidth }), 26);
    left.add(text(localize("params.hp"), { size: 46, bold: true }), 8);
    left.add(hpBar(system, columnWidth), 26);
    left.add(text(`${localize("params.crew")}: ${system.crewUsed} / ${system.maxCrew}`, { size: 46, wrap: columnWidth }));
    left.add(text(`${localize("params.speed")}: ${system.speed}`, { size: 46 }));
    left.add(text(`${localize("params.fuelEconomy")}: ${system.fuelEconomy}`, { size: 46, wrap: columnWidth }), 26);
    const statuses = [];
    if (system.isOverloaded) statuses.push(localize("status.overloaded"));
    if (system.isDisabled) statuses.push(localize("status.disabled"));
    if (system.isCritical) statuses.push(localize("status.critical"));
    if (statuses.length) left.add(text(statuses.join("\n"), { size: 46, bold: true, color: PALETTE.burgundy, wrap: columnWidth }));

    right.add(text(localize("params.phlogiston"), { size: 46, bold: true }), 8);
    right.add(phlogistonScale(system, columnWidth), 30);
    right.add(text(localize("params.distance"), { size: 46, bold: true }), 8);
    right.add(distancePlates(system, columnWidth));
    height += Math.max(left.height, right.height);
  }

  // Содержимое ужимается под высоту области, если корабль невысокий.
  const fit = Math.min(1, (params.height - PADDING * 2) / Math.max(1, height));
  content.scale.set(fit);
  content.position.set(params.x + PADDING, params.y + PADDING);
  // Нераскрытый корабль не открывает лист кликом: иначе силуэт обходится в одно касание.
  if (revealed) addHotspot({ x: params.x + PADDING, y: params.y + PADDING, width: title.width * fit, height: title.height * fit }, () => ship.sheet.render(true));
}

/* ---------------- Описание и системы ---------------- */

function systemRowText(row, category) {
  const lines = [`${row.name}${row.count > 1 ? ` ×${row.count}` : ""}`];
  if (category === "weapons" && row.firepower) lines.push(format("overlay.firepower", { value: row.firepower }));
  if (category === "engine") lines.push(format("overlay.engine", { speed: row.speed ?? "—", fuel: row.fuelEconomy ?? "—" }));
  return lines;
}

function drawColumn(parent, column, x, y, width, height, ship) {
  const content = parent.addChild(new PIXI.Container());
  let cursor = 0;
  for (const category of column) {
    if (category === "description") {
      const title = text(localize("description.title"), { size: 54, color: PALETTE.burgundy, font: HEADING_FONT });
      title.position.set(0, cursor);
      content.addChild(title);
      cursor += title.height + 6;
      const body = text(stripHtml(ship.system.description) || "—", { size: 32, wrap: width });
      body.position.set(0, cursor);
      content.addChild(body);
      cursor += body.height + 20;
      continue;
    }
    const title = text(localize(`system.${category}`), { size: 54, color: PALETTE.burgundy, font: HEADING_FONT });
    title.position.set(0, cursor);
    content.addChild(title);
    cursor += title.height + 4;
    const rows = ship.system.systems[category];
    if (!rows.length) {
      const empty = text("—", { size: 34 });
      empty.position.set(0, cursor);
      content.addChild(empty);
      cursor += empty.height + 14;
    }
    for (const row of rows) {
      const [head, ...details] = systemRowText(row, category);
      const name = text(head, { size: 36, bold: true, wrap: width, color: row.destroyed ? 0x7a6a55 : PALETTE.ink });
      name.position.set(0, cursor);
      content.addChild(name);
      if (row.destroyed) {
        content.addChild(new PIXI.Graphics().lineStyle(3, PALETTE.burgundy).moveTo(0, cursor + name.height / 2).lineTo(Math.min(width, name.width), cursor + name.height / 2));
      }
      cursor += name.height + 2;
      // Эффект на сцене — две строки; полный текст в окне отсека и на вкладке «Системы».
      const effectLines = [...details, clampLines(row.effect, width, 28, 2)].filter(Boolean).join("\n");
      if (effectLines) {
        const effect = text(effectLines, { size: 28, wrap: width, color: row.destroyed ? 0x7a6a55 : 0x3b2f22 });
        effect.position.set(0, cursor);
        content.addChild(effect);
        cursor += effect.height;
      }
      cursor += 12;
    }
    cursor += 10;
  }
  content.position.set(x, y);
  clipTo(content, { x, y, width, height }, parent);
}

function drawDescription(parent, ship, rects, revealed) {
  const description = { ...rects.description, y: rects.description.y + GUTTER, height: rects.description.height - GUTTER };
  drawFrame(parent.addChild(new PIXI.Graphics()), description);
  if (!revealed) {
    const hidden = parent.addChild(text(localize("overlay.hidden"), { size: 64, italic: true, color: PALETTE.wood }));
    hidden.anchor.set(0.5);
    hidden.position.set(description.x + description.width / 2, description.y + description.height / 2);
    return;
  }
  const columns = [["equipment"], ["recon", "control"], ["engine", "weapons"], ["description"]];
  const innerWidth = description.width - PADDING * 2;
  const gap = 40;
  const columnWidth = (innerWidth - gap * (columns.length - 1)) / columns.length;
  columns.forEach((column, index) => {
    drawColumn(parent, column, description.x + PADDING + index * (columnWidth + gap), description.y + PADDING, columnWidth, description.height - PADDING * 2, ship);
  });
}

/* ---------------- Сборка ---------------- */

function drawSky(parent, layout) {
  const left = layout.sides.left;
  const skyX = left.originX + left.width;
  const height = layout.descriptionY + 800;
  const graphics = parent.addChild(new PIXI.Graphics());
  graphics.beginFill(PALETTE.sky, 0.9).drawRect(skyX, 0, SKY_WIDTH, height).endFill();
  graphics.beginFill(0x3d5566, 0.5).drawRect(skyX, 0, SKY_WIDTH, height / 3).endFill();
  const label = parent.addChild(text(localize("overlay.sky"), { size: 90, color: 0xc9d6df, font: HEADING_FONT }));
  label.anchor.set(0.5, 0);
  label.position.set(skyX + SKY_WIDTH / 2, 60);
}

/** Плашка ГМа над канвой: форма кораблей изменилась, сцену пора перестроить. */
function updateStaleBanner(scene) {
  document.getElementById("skyplane-stale-banner")?.remove();
  if (!game.user.isGM || !getLayout(scene) || !isSceneStale(scene)) return;
  const banner = document.createElement("div");
  banner.id = "skyplane-stale-banner";
  banner.className = "skyplane-stale-banner";
  banner.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i><span></span><button type="button"><i class="fa-solid fa-rotate"></i> </button>`;
  banner.querySelector("span").textContent = localize("params.stale");
  banner.querySelector("button").append(localize("params.rebuild"));
  banner.querySelector("button").addEventListener("click", () => confirmAndRebuild(scene));
  document.body.append(banner);
}

function drawOverlay() {
  redrawTimer = null;
  clearLayers();
  const scene = canvas.scene;
  const layout = getLayout(scene);
  updateStaleBanner(canvas.ready ? scene : null);
  if (!canvas.ready || !layout?.sides) return;

  container = new PIXI.Container();
  container.zIndex = 50;
  container.sortableChildren = false;
  canvas.interface.addChild(container);
  mapLayer = new foundry.canvas.primary.PrimaryCanvasContainer();
  mapLayer.sortLayer = MAP_SORT_LAYER;
  mapLayer.elevation = 0;
  canvas.primary.addChild(mapLayer);
  hotspots = new PIXI.Container();
  hotspots.zIndex = 250;
  canvas.interface.addChild(hotspots);
  if (layout.mode === "battle") drawSky(mapLayer, layout);
  for (const entry of sceneSides(scene)) {
    const rects = sideRects(layout, entry.side);
    const revealed = isSideRevealed(scene, entry.side);
    drawParams(container, entry.ship, rects, revealed);
    drawDescription(container, entry.ship, rects, revealed);
    drawMap(mapLayer, entry, rects, revealed);
  }
}

export function scheduleOverlayRedraw() {
  if (redrawTimer) clearTimeout(redrawTimer);
  redrawTimer = setTimeout(drawOverlay, OVERLAY_DEBOUNCE_MS);
}

function sceneHasShip(actor) {
  return !!getShip(actor) && sceneSides(canvas.scene).some((entry) => entry.ship === actor);
}

/** Всплывающая цифра урона над отсеком: «−N» при попадании, «+N» при отмене. */
function showFloatingDamage(ship, compartment, amount) {
  if (!canvas.ready || !amount || !compartment) return;
  const entry = sceneSides(canvas.scene).find((sideEntry) => sideEntry.ship === ship);
  if (!entry) return;
  const center = {
    x: entry.origin.originX + (compartment.x - 1 + compartment.width / 2) * CELL_SIZE,
    y: entry.origin.originY + (compartment.y - 1 + compartment.height / 2) * CELL_SIZE
  };
  canvas.interface.createScrollingText(center, amount > 0 ? `−${amount}` : `+${-amount}`, {
    anchor: CONST.TEXT_ANCHOR_POINTS.CENTER,
    direction: CONST.TEXT_ANCHOR_POINTS.TOP,
    distance: CELL_SIZE,
    duration: 2600,
    jitter: 0.25,
    fontSize: 110,
    fontFamily: BODY_FONT,
    fontWeight: "bold",
    fill: amount > 0 ? 0xff5a4a : 0x7be38a,
    stroke: 0x000000,
    strokeThickness: 10
  });
}

function compartmentCenter(entry, compartment) {
  return {
    x: entry.origin.originX + (compartment.x - 1 + compartment.width / 2) * CELL_SIZE,
    y: entry.origin.originY + (compartment.y - 1 + compartment.height / 2) * CELL_SIZE
  };
}

const TRACER_FLIGHT_MS = 450;
const TRACER_BURST_MS = 400;

/**
 * Трассер выстрела: снаряд летит от пушки к отсеку цели, в конце — вспышка.
 * Попадание — оранжевая вспышка в центре цели, промах — серый дымок мимо неё. Выключается настройкой анимаций.
 */
function showTracer(ship, weapon, enemyShip, target, damage) {
  if (!canvas.ready || !weapon || !target || !game.settings.get(MODULE_ID, "animations")) return;
  const sides = sceneSides(canvas.scene);
  const from = sides.find((entry) => entry.ship === ship);
  const to = sides.find((entry) => entry.ship === enemyShip);
  if (!from || !to) return;
  const start = compartmentCenter(from, weapon);
  const end = compartmentCenter(to, target);
  const hit = damage > 0;
  if (!hit) {
    // Промах уходит мимо: в сторону от центра цели на клетку-полторы.
    const angle = Math.random() * Math.PI * 2;
    end.x += Math.cos(angle) * CELL_SIZE * 1.2;
    end.y += Math.sin(angle) * CELL_SIZE * 1.2;
  }
  const color = hit ? 0xffa23a : 0xb8b0a0;
  const graphics = new PIXI.Graphics();
  graphics.zIndex = 260;
  canvas.interface.addChild(graphics);
  const began = performance.now();
  const point = (progress) => ({ x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress });
  const tick = () => {
    const elapsed = performance.now() - began;
    graphics.clear();
    if (elapsed < TRACER_FLIGHT_MS) {
      const head = point(elapsed / TRACER_FLIGHT_MS);
      const tail = point(Math.max(0, elapsed / TRACER_FLIGHT_MS - 0.3));
      graphics.lineStyle(40, color, 0.35).moveTo(tail.x, tail.y).lineTo(head.x, head.y);
      graphics.lineStyle(14, 0xfff3d0, 0.95).moveTo(tail.x, tail.y).lineTo(head.x, head.y);
      graphics.lineStyle(0).beginFill(0xfff3d0, 1).drawCircle(head.x, head.y, 28).endFill();
      return;
    }
    const burst = (elapsed - TRACER_FLIGHT_MS) / TRACER_BURST_MS;
    if (burst >= 1) {
      canvas.app.ticker.remove(tick);
      graphics.destroy();
      return;
    }
    const radius = (hit ? 60 : 40) + burst * (hit ? 200 : 100);
    graphics.beginFill(color, (1 - burst) * (hit ? 0.75 : 0.45)).drawCircle(end.x, end.y, radius).endFill();
  };
  canvas.app.ticker.add(tick);
}

export function registerOverlay() {
  Hooks.on(`${HOOK_PREFIX}.compartmentHit`, showFloatingDamage);
  Hooks.on(`${HOOK_PREFIX}.shipFired`, showTracer);
  Hooks.on("canvasReady", drawOverlay);
  Hooks.on("canvasTearDown", () => {
    clearLayers();
    updateStaleBanner(null);
  });
  Hooks.on("updateActor", (actor) => {
    if (canvas.ready && getLayout(canvas.scene) && (sceneHasShip(actor) || isCrewOfSceneShip(actor))) scheduleOverlayRedraw();
  });
  Hooks.on("updateScene", (scene, changed) => {
    if (scene === canvas.scene && foundry.utils.hasProperty(changed, `flags.${MODULE_ID}`)) scheduleOverlayRedraw();
  });
  Hooks.on("updateUser", (user, changed) => {
    if (user === game.user && "character" in changed) scheduleOverlayRedraw();
  });
}

/** Имя капитана на сцене берётся из актора экипажа. */
function isCrewOfSceneShip(actor) {
  return sceneSides(canvas.scene).some((entry) => entry.ship.system.captainUuid === actor.uuid);
}
