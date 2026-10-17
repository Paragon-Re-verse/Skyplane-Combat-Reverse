import { MODULE_ID, DISTANCES, SYSTEM_CATEGORIES } from "../constants.js";
import { GRID_LIMITS, validateShip, crewUsed, groupSystems, shipBonuses } from "../rules/ship-rules.js";
import { compartmentFields, migrateCompartmentSource } from "./compartment-data-model.js";

const fields = foundry.data.fields;

function placedCompartmentSchema() {
  return new fields.SchemaField({
    ...compartmentFields(),
    instanceId: new fields.StringField({ required: true, blank: false }),
    sourceUuid: new fields.StringField({ required: false, blank: true }),
    name: new fields.StringField({ required: true, blank: false, initial: "—" }),
    description: new fields.StringField({ required: false, blank: true }),
    x: new fields.NumberField({ required: true, integer: true, min: 1, initial: 1 }),
    y: new fields.NumberField({ required: true, integer: true, min: 1, initial: 1 }),
    currentHp: new fields.NumberField({ required: true, integer: true, min: 0, initial: 10 }),
    maxHp: new fields.NumberField({ required: true, integer: true, min: 0, initial: 10 }),
    passageUp: new fields.BooleanField({ initial: false }),
    passageDown: new fields.BooleanField({ initial: false }),
    effectActive: new fields.BooleanField({ initial: true }),
    // Копии активных эффектов предмета каталога: корабль учитывает их, пока отсек работает.
    effects: new fields.ArrayField(new fields.SchemaField({
      name: new fields.StringField({ required: true, blank: true }),
      img: new fields.StringField({ required: false, blank: true }),
      disabled: new fields.BooleanField({ initial: false }),
      changes: new fields.ArrayField(new fields.SchemaField({
        key: new fields.StringField({ required: true, blank: true }),
        mode: new fields.NumberField({ required: true, integer: true, initial: 2 }),
        value: new fields.StringField({ required: true, blank: true }),
        priority: new fields.NumberField({ required: false, nullable: true, initial: null })
      }))
    }))
  });
}

export class ShipData extends foundry.abstract.TypeDataModel {
  static migrateData(source) {
    for (const compartment of source.compartments ?? []) migrateCompartmentSource(compartment);
    return super.migrateData(source);
  }

  static defineSchema() {
    return {
      shipClass: new fields.StringField({ required: false, blank: true }),
      captainUuid: new fields.StringField({ required: false, blank: true }),
      crew: new fields.ArrayField(new fields.SchemaField({
        actorUuid: new fields.StringField({ required: true, blank: false }),
        capacityCost: new fields.NumberField({ required: true, integer: true, min: 0, initial: 1 }),
        note: new fields.StringField({ required: false, blank: true })
      })),
      maxCrew: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      currentHp: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      maxHp: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      speed: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      fuelEconomy: new fields.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      phlogiston: new fields.NumberField({ required: true, integer: true, min: 0, max: 5, initial: 5 }),
      combatDistance: new fields.StringField({
        required: true,
        initial: "medium",
        choices: Object.fromEntries(DISTANCES.map((distance) => [distance, `${MODULE_ID}.distance.${distance}.label`]))
      }),
      gridWidth: new fields.NumberField({
        required: true, integer: true, min: GRID_LIMITS.minWidth, max: GRID_LIMITS.maxWidth, initial: GRID_LIMITS.defaultWidth
      }),
      gridHeight: new fields.NumberField({
        required: true, integer: true, min: GRID_LIMITS.minHeight, max: GRID_LIMITS.maxHeight, initial: GRID_LIMITS.defaultHeight
      }),
      compartments: new fields.ArrayField(placedCompartmentSchema()),
      description: new fields.HTMLField({ required: false, blank: true })
    };
  }

  prepareDerivedData() {
    this.crewUsed = crewUsed(this.crew);
    this.isOverloaded = this.crewUsed > this.maxCrew;
    this.isDisabled = this.maxHp > 0 && this.currentHp <= 0;
    this.isCritical = this.phlogiston === 0;
    this.validation = validateShip({
      compartments: this.compartments,
      gridWidth: this.gridWidth,
      gridHeight: this.gridHeight,
      crew: this.crew,
      maxCrew: this.maxCrew
    });
    this.systems = groupSystems(this.compartments, SYSTEM_CATEGORIES);
    this.bonuses = shipBonuses(this.compartments);
  }
}
