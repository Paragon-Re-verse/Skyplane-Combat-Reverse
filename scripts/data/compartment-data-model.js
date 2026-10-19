import { MODULE_ID, SYSTEM_CATEGORIES, EFFECT_STATS, RANGES, WEAPON_SPECIALS, DAMAGE_FACES } from "../constants.js";
import { LEGACY_RANGES } from "../rules/ship-rules.js";
import { INVENTORY_LIMIT } from "../rules/inventory-rules.js";

const fields = foundry.data.fields;

/** Поля отсека, общие для Item каталога и размещённого на корабле экземпляра. */
export function compartmentFields() {
  return {
    catalogId: new fields.StringField({ required: false, blank: true }),
    systemCategory: new fields.StringField({
      required: true,
      initial: "equipment",
      choices: Object.fromEntries(SYSTEM_CATEGORIES.map((category) => [category, `${MODULE_ID}.system.${category}`]))
    }),
    width: new fields.NumberField({ required: true, integer: true, min: 1, max: 14, initial: 1 }),
    height: new fields.NumberField({ required: true, integer: true, min: 1, max: 8, initial: 1 }),
    hp: new fields.NumberField({ required: true, integer: true, min: 0, initial: 10 }),
    img: new fields.FilePathField({ required: false, categories: ["IMAGE"], blank: true }),
    keywords: new fields.ArrayField(new fields.StringField()),
    isResidential: new fields.BooleanField({ initial: false }),
    isNoHp: new fields.BooleanField({ initial: false }),
    ignoresPassage: new fields.BooleanField({ initial: false }),
    isOutsideOnly: new fields.BooleanField({ initial: false }),
    isStairs: new fields.BooleanField({ initial: false }),
    isNarrow: new fields.BooleanField({ initial: false }),
    speed: new fields.NumberField({ required: false, integer: true, min: 0, nullable: true, initial: null }),
    fuelEconomy: new fields.NumberField({ required: false, integer: true, min: 0, nullable: true, initial: null }),
    // Бой: проверка навыка dnd5e (обстрел у пушек, разведка у радаров), дальность и урон пушки.
    checkSkill: new fields.StringField({ required: false, blank: true }),
    checkDc: new fields.NumberField({ required: true, integer: true, min: 0, initial: 12 }),
    ranges: new fields.ArrayField(new fields.StringField({
      choices: Object.fromEntries(RANGES.map((range) => [range, `${MODULE_ID}.range.${range}`]))
    }), { initial: [...RANGES] }),
    special: new fields.StringField({
      required: false,
      blank: true,
      initial: "",
      choices: { "": `${MODULE_ID}.special.none`, ...Object.fromEntries(WEAPON_SPECIALS.map((special) => [special, `${MODULE_ID}.special.${special}`])) }
    }),
    damageDice: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    damageDie: new fields.NumberField({
      required: true, integer: true, initial: 6, choices: Object.fromEntries(DAMAGE_FACES.map((faces) => [faces, `d${faces}`]))
    }),
    damageBonus: new fields.NumberField({ required: true, integer: true, initial: 0 }),
    // Боезапас пушки: сколько выстрелов до пополнения; 0 — без ограничения.
    ammo: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    // Снаряды пушки — предмет, перетащенный в поле «Снаряды»; пусто — пушка снарядов не тратит.
    ammoItem: new fields.SchemaField({
      uuid: new fields.StringField({ required: false, blank: true }),
      source: new fields.StringField({ required: false, blank: true }),
      name: new fields.StringField({ required: false, blank: true }),
      img: new fields.StringField({ required: false, blank: true })
    }),
    // Сетка инвентаря отсека в клетках; 0 — инвентаря нет.
    inventoryWidth: new fields.NumberField({ required: true, integer: true, min: 0, max: INVENTORY_LIMIT, initial: 0 }),
    inventoryHeight: new fields.NumberField({ required: true, integer: true, min: 0, max: INVENTORY_LIMIT, initial: 0 }),
    effect: new fields.StringField({ required: false, blank: true }),
    effectStat: new fields.StringField({
      required: false,
      blank: true,
      initial: "",
      choices: { "": `${MODULE_ID}.effectStat.none`, ...Object.fromEntries(EFFECT_STATS.map((stat) => [stat, `${MODULE_ID}.effectStat.${stat}`])) }
    }),
    effectValue: new fields.NumberField({ required: true, integer: true, initial: 0 }),
    worksWhenDestroyed: new fields.BooleanField({ initial: false })
  };
}

/** До 1.2 у пушки был один класс дальности: переводим его в набор дистанций без штрафа. */
export function migrateCompartmentSource(source) {
  if (source && "range" in source && !("ranges" in source)) source.ranges = [...(LEGACY_RANGES[source.range] ?? RANGES)];
  return source;
}

export class CompartmentData extends foundry.abstract.TypeDataModel {
  static migrateData(source) {
    migrateCompartmentSource(source);
    return super.migrateData(source);
  }

  static defineSchema() {
    return {
      ...compartmentFields(),
      description: new fields.HTMLField({ required: false, blank: true })
    };
  }
}
