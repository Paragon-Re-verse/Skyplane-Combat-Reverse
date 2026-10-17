export const MODULE_ID = "skyplane-combat-reverse";
export const SHIP_TYPE = `${MODULE_ID}.ship`;
export const COMPARTMENT_TYPE = `${MODULE_ID}.compartment`;
export const HOOK_PREFIX = "skyplaneCombatReverse";
export const TEMPLATE_PATH = `modules/${MODULE_ID}/templates`;

/** Масштаб сцены: 1 квадрат корабля = 2×2 клетки Foundry по 100 px = 10 фт. */
export const GRID_SIZE = 100;
export const GRID_DISTANCE = 5;
export const CELL_SIZE = 200;
export const PARAMS_WIDTH = 1200;
export const DESCRIPTION_HEIGHT = 800;
export const SKY_WIDTH = 1600;
export const SCENE_BACKGROUND = "#1b130d";
export const DESTROYED_TINT = "#3a3a3a";

export const LOG_LIMIT = 200;
export const OVERLAY_DEBOUNCE_MS = 100;

export const SYSTEM_CATEGORIES = ["equipment", "recon", "control", "engine", "weapons"];
export const DISTANCES = ["melee", "close", "medium", "far"];
export const EFFECT_STATS = ["maxHp", "maxCrew", "speed", "fuelEconomy"];
export const PERMISSION_RIGHTS = ["params", "build", "repair", "phlogiston", "combat"];
/** Дистанции пушки без штрафа, особые свойства пушек и грани костей урона. */
export const RANGES = ["close", "medium", "far"];
export const WEAPON_SPECIALS = ["splash", "charge", "volley"];
export const DAMAGE_FACES = [4, 6, 8, 10, 12, 20];
export const SIDES = ["left", "right"];
/** Ключи активных эффектов, которые учитывает корабль: характеристики и боевые бонусы. */
export const EFFECT_KEYS = [
  "system.maxHp", "system.maxCrew", "system.speed", "system.fuelEconomy",
  "system.bonuses.attack", "system.bonuses.damage", "system.bonuses.defense", "system.bonuses.repair", "system.bonuses.scout"
];

export const PALETTE = {
  parchment: 0xf1e6cc,
  wood: 0x2b1d14,
  brass: 0xb08d57,
  copper: 0x9c5b2e,
  burgundy: 0x6b1f1a,
  ink: 0x191813,
  silhouette: 0x0d0907,
  sky: 0x24323d
};

export function localize(key) {
  return game.i18n.localize(`${MODULE_ID}.${key}`);
}

export function format(key, data = {}) {
  return game.i18n.format(`${MODULE_ID}.${key}`, data);
}

/** «system.bonuses.attack» → «Точность пушек»; незнакомый ключ показывается как есть. */
export function effectKeyLabel(key) {
  const short = String(key).replace(/^system\.(bonuses\.)?/, "");
  return game.i18n.has(`${MODULE_ID}.effectKey.${short}`) ? localize(`effectKey.${short}`) : key;
}

const MODE_SIGNS = { 1: "×", 2: "+", 3: "≤", 4: "≥", 5: "=" };

/** Изменения эффекта одной строкой: «Прочность +200, Защита +2». */
export function describeChanges(changes) {
  return (changes ?? []).map((change) => {
    const value = String(change.value);
    const sign = Number(change.mode) === 2 && value.startsWith("-") ? "" : MODE_SIGNS[change.mode] ?? "";
    return `${effectKeyLabel(change.key)} ${sign}${value}`;
  }).join(", ");
}
