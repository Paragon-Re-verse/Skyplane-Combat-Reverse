import { MODULE_ID, SHIP_TYPE, COMPARTMENT_TYPE, localize, effectKeyLabel, localPack } from "../constants.js";
import { computeStats } from "../rules/ship-rules.js";
import { buildPlacedCompartment } from "../documents/ship-actions.js";
import { deployShip } from "../scene/scene-builder.js";

const SETUP_VERSION = "1.0.0";
const FOLDER_NAME = "SkyPlane";

/** «Альбатрос» 11×6: [catalogId, x, y] — связный по проходам, с обязательными отсеками. */
const ALBATROSS = [
  ["bridge_leather", 5, 1], ["crows_nest", 7, 1], ["weapon_flamethrower", 7, 2], ["weapon_carbolin", 3, 2],
  ["stairs_vert", 4, 2], ["stairs_vert", 4, 3], ["stairs_vert", 4, 4], ["stairs_vert", 4, 5], ["stairs_vert", 4, 6],
  ["cabin_captain", 5, 3], ["radar_station", 8, 3], ["engine_hobgoblin", 9, 3],
  ["mess_hall", 5, 5], ["workshop_repair", 7, 5],
  ["cargo_hold", 1, 6], ["cabin_crew", 5, 6], ["cabin_crew", 7, 6], ["weapon_falconet", 11, 6]
];

async function folderFor(type) {
  return game.folders.find((folder) => folder.type === type && folder.name === FOLDER_NAME && !folder.folder)
    ?? Folder.create({ name: FOLDER_NAME, type, color: "#6b1f1a" });
}

async function createExampleShip() {
  const pack = game.packs.get(localPack("compartments"));
  const catalog = new Map((await pack.getDocuments()).map((item) => [item.system.catalogId, item]));
  const compartments = ALBATROSS
    .filter(([catalogId]) => catalog.has(catalogId))
    .map(([catalogId, x, y]) => buildPlacedCompartment(catalog.get(catalogId), x, y));
  const stats = computeStats(compartments);
  const folder = await folderFor("Actor");
  return Actor.create({
    name: localize("setup.exampleName"),
    type: SHIP_TYPE,
    folder: folder.id,
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
    system: {
      shipClass: localize("setup.exampleClass"),
      gridWidth: 11,
      gridHeight: 6,
      compartments,
      ...stats,
      currentHp: stats.maxHp,
      phlogiston: 5,
      combatDistance: "medium",
      description: `<p>${localize("setup.exampleDescription")}</p>`
    }
  });
}

async function importMacros() {
  const pack = game.packs.get(localPack("macros"));
  if (!pack) return;
  const folder = await folderFor("Macro");
  const existing = new Set(game.macros.filter((macro) => macro.folder === folder).map((macro) => macro.name));
  const macros = (await pack.getDocuments())
    .filter((macro) => !existing.has(macro.name))
    .map((macro) => ({ ...game.macros.fromCompendium(macro), folder: folder.id }));
  if (macros.length) await Macro.createDocuments(macros);
}

async function announce() {
  const pack = game.packs.get(localPack("help"));
  const entry = (await pack?.getIndex())?.contents[0];
  const link = entry ? `<p>@UUID[${entry.uuid}]{${localize("setup.helpLink")}}</p>` : "";
  await ChatMessage.create({
    content: `<h3>SkyPlane Combat Re:verse</h3><p>${localize("setup.done")}</p>${link}`,
    whisper: [game.user.id],
    speaker: { alias: "SkyPlane Combat Re:verse" }
  });
  ui.notifications.info(localize("setup.done"));
}

const COMBAT_FIELDS = ["checkSkill", "checkDc", "ranges", "damageDice", "damageDie", "damageBonus"];

/** Миграции данных мира: один раз на мир, у активного ГМа. */
export async function migrateData() {
  if (!game.user.isGM || game.users.activeGM !== game.user) return;
  const version = game.settings.get(MODULE_ID, "dataVersion") || "0";
  const older = (target) => foundry.utils.isNewerVersion(target, version);
  if (!older(DATA_VERSION)) return;
  if (older("1.1")) await migrateCombatFields();
  if (older("1.1.1")) await migrateEffects();
  if (older("1.2")) await migrateEffectStats();
  if (older("1.3")) await migrateInventory();
  await game.settings.set(MODULE_ID, "dataVersion", DATA_VERSION);
}

/**
 * Данные 1.1: отсеки, поставленные до появления боя, получают пушечные и разведочные поля
 * из каталога по catalogId (мировая копия важнее компендиума). Один раз на мир.
 */
async function migrateCombatFields() {
  const catalog = new Map();
  for (const name of ["compartments", "starcraft-compartments"]) {
    for (const item of await game.packs.get(`${MODULE_ID}.${name}`)?.getDocuments() ?? []) catalog.set(item.system.catalogId, item.system);
  }
  for (const item of game.items.filter((document) => document.type === `${MODULE_ID}.compartment`)) catalog.set(item.system.catalogId, item.system);

  for (const ship of game.actors.filter((actor) => actor.type === SHIP_TYPE)) {
    let changed = false;
    const compartments = ship.system.toObject().compartments.map((compartment) => {
      const source = catalog.get(compartment.catalogId);
      if (!source || compartment.damageDice || compartment.checkSkill) return compartment;
      changed = true;
      return { ...compartment, ...Object.fromEntries(COMBAT_FIELDS.map((field) => [field, source[field]])) };
    });
    if (changed) await ship.update({ "system.compartments": compartments });
  }
}

const DATA_VERSION = "1.3";

/** Сетки инвентаря по умолчанию (ширина, высота): трюмы, мастерские, каюты и их аналоги StarCraft II. */
export const INVENTORY_DEFAULTS = {
  cargo_hold: [10, 6], sc2p_vault: [10, 6],
  workshop_repair: [6, 4], sc2t_armory: [6, 4],
  cabin_crew: [3, 3], cabin_captain: [3, 3], sc2p_cells: [3, 3], sc2t_barracks: [3, 3],
  weapon_torpedo: [2, 2], sc2t_yamato: [2, 2]
};

/** Снаряды поставленных пушек: торпеды «Шмель» и заряды Ямато из компендиума грузов (оба языка подходят). */
const AMMO_DEFAULTS = {
  weapon_torpedo: { id: "skyCrgTorpedo001", img: "icons/weapons/thrown/bomb-fuse-black-grey.webp", key: "setup.ammoTorpedo" },
  sc2t_yamato: { id: "skyCrgYamatoChrg", img: "icons/commodities/gems/gem-cluster-blue-white.webp", key: "setup.ammoYamato" }
};

function defaultAmmo(catalogId) {
  const ammo = AMMO_DEFAULTS[catalogId];
  if (!ammo) return null;
  const [own, other] = localPack("cargo").endsWith("-en") ? ["cargo-en", "cargo"] : ["cargo", "cargo-en"];
  return {
    uuid: `Compendium.${MODULE_ID}.${own}.Item.${ammo.id}`,
    source: `Compendium.${MODULE_ID}.${other}.Item.${ammo.id}`,
    name: localize(ammo.key),
    img: ammo.img
  };
}

/** Данные 1.3: мировые отсеки каталога и поставленные отсеки без сетки получают сетку по умолчанию. */
async function migrateInventory() {
  const sized = (system) => {
    const size = INVENTORY_DEFAULTS[system.catalogId];
    if (!size || system.inventoryWidth) return null;
    const ammoItem = system.ammoItem?.uuid ? null : defaultAmmo(system.catalogId);
    return { inventoryWidth: size[0], inventoryHeight: size[1], ...(ammoItem ? { ammoItem } : {}) };
  };
  for (const item of game.items.filter((document) => document.type === COMPARTMENT_TYPE)) {
    const size = sized(item.system);
    if (size) await item.update({ system: size });
  }
  // Свои каталоги в папке модуля (незаблокированные): отсеки с исходным catalogId. Копии «Нового каталога»
  // получают свой catalogId (custom_…) — их сетку ГМ задаёт во вкладке «Инвентарь».
  const folderId = game.packs.get(localPack("compartments"))?.folder?.id;
  const customPacks = game.packs.filter((pack) => pack.documentName === "Item" && pack.folder?.id === folderId
    && pack.metadata.packageName !== MODULE_ID && !pack.locked);
  for (const pack of customPacks) {
    for (const item of await pack.getDocuments({ type: COMPARTMENT_TYPE })) {
      const size = sized(item.system);
      if (size) await item.update({ system: size });
    }
  }
  for (const ship of game.actors.filter((actor) => actor.type === SHIP_TYPE)) {
    let changed = false;
    const compartments = ship.system.toObject().compartments.map((compartment) => {
      const size = sized(compartment);
      if (!size) return compartment;
      changed = true;
      return { ...compartment, ...size };
    });
    if (changed) await ship.update({ "system.compartments": compartments });
  }
}

/** Старый модификатор характеристики (effectStat) как активный эффект «Прибавить». */
function effectFromStat(stat, value) {
  const key = `system.${stat}`;
  return { name: `${effectKeyLabel(key)} ${value > 0 ? "+" : ""}${value}`, img: "icons/svg/aura.svg", disabled: false, changes: [{ key, mode: 2, value: String(value) }] };
}

/** Данные 1.2: модификатор характеристики становится активным эффектом — у предметов каталога и у поставленных отсеков. */
async function migrateEffectStats() {
  const cleared = { "system.effectStat": "", "system.effectValue": 0 };
  for (const item of game.items.filter((document) => document.type === COMPARTMENT_TYPE && document.system.effectStat && document.system.effectValue)) {
    await item.createEmbeddedDocuments("ActiveEffect", [effectFromStat(item.system.effectStat, item.system.effectValue)]);
    await item.update(cleared);
  }
  for (const ship of game.actors.filter((actor) => actor.type === SHIP_TYPE)) {
    const compartments = ship.system.toObject().compartments;
    if (!compartments.some((compartment) => compartment.effectStat && compartment.effectValue)) continue;
    await ship.update({
      "system.compartments": compartments.map((compartment) => {
        if (!compartment.effectStat || !compartment.effectValue) return compartment;
        const effects = [...compartment.effects, effectFromStat(compartment.effectStat, compartment.effectValue)];
        return { ...compartment, effects, effectStat: "", effectValue: 0 };
      })
    });
  }
}

/** Старые эффекты каталога повторяли характеристики, которые сцена и так выводит строкой выше. */
const EFFECT_FIXES = new Map([
  ["Скорость 3, Экономия топлива 2. Поддерживает стабильную тягу во всех эшелонах высоты.", "Поддерживает стабильную тягу во всех эшелонах высоты."],
  ["Скорость 2, Экономия топлива 1. Надежный и неприхотливый в ремонте двигатель.", "Надежный и неприхотливый в ремонте двигатель."],
  ["Скорость 5, Экономия топлива 3. Повышенная тяга для массивных крейсеров.", "Повышенная тяга для массивных крейсеров."],
  ["Огневая мощь 5. Дистанция: Средняя и Дальняя. Бронебойные снаряды.", "Бронебойные снаряды."],
  ["Огневая мощь 2. Скорострельное малокалиберное орудие против десанта и катеров.", "Скорострельное малокалиберное орудие против десанта и катеров."],
  ["Огневая мощь 3. Дистанция: Схватка и Ближняя. Поджигает смежные отсеки врага.", "Поджигает смежные отсеки врага."],
  ["Огневая мощь 8 (Средняя/Дальняя). Высокий шанс критического повреждения киля.", "Высокий шанс критического повреждения киля."],
  ["Скорость 3, экономия топлива 3.", ""],
  ["Скорость 4, экономия топлива 2.", ""],
  ["Раунд зарядки, затем один выстрел по отсеку цели. Дистанция: Средняя и Дальняя.", "Раунд зарядки, затем один выстрел по отсеку цели."],
  ["Против кораблей. Дистанция: Ближняя и Средняя.", "Против кораблей."],
]);

/** Данные 1.1.1: заменяет только нетронутые тексты каталога — правки ГМа остаются. */
async function migrateEffects() {
  for (const item of game.items.filter((document) => document.type === `${MODULE_ID}.compartment` && EFFECT_FIXES.has(document.system.effect))) {
    await item.update({ "system.effect": EFFECT_FIXES.get(item.system.effect) });
  }
  for (const ship of game.actors.filter((actor) => actor.type === SHIP_TYPE)) {
    const compartments = ship.system.toObject().compartments;
    if (!compartments.some((compartment) => EFFECT_FIXES.has(compartment.effect))) continue;
    await ship.update({ "system.compartments": compartments.map((compartment) => EFFECT_FIXES.has(compartment.effect) ? { ...compartment, effect: EFFECT_FIXES.get(compartment.effect) } : compartment) });
  }
}

/** Один раз на мир, только у активного ГМа. Удалённое ГМом повторно не создаётся. */
export async function firstRun() {
  if (!game.user.isGM || game.users.activeGM !== game.user) return;
  if (game.settings.get(MODULE_ID, "setupVersion")) return;
  await game.settings.set(MODULE_ID, "setupVersion", SETUP_VERSION);
  try {
    const ship = await createExampleShip();
    await deployShip(ship);
    await importMacros();
    await announce();
  } catch (error) {
    console.error(`${MODULE_ID} | первый запуск`, error);
    ui.notifications.error(localize("setup.failed"));
  }
}
