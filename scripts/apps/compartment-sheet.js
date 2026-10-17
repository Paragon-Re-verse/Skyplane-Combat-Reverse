import {
  MODULE_ID, TEMPLATE_PATH, SYSTEM_CATEGORIES, RANGES, WEAPON_SPECIALS, DAMAGE_FACES, EFFECT_KEYS,
  localize, format, effectKeyLabel, describeChanges
} from "../constants.js";
import { countPlacedFrom, syncCatalogItem } from "../documents/ship-actions.js";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;

/** Лист Item «Отсек» каталога: обычная форма документа, правит владелец. */
export class CompartmentItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["skyplane-combat-reverse", "skyplane-compartment-sheet"],
    position: { width: 560, height: 720 },
    window: { resizable: true },
    form: { submitOnChange: true },
    actions: {
      syncShips: CompartmentItemSheet.#onSyncShips,
      addEffect: CompartmentItemSheet.#onAddEffect,
      editEffect: CompartmentItemSheet.#onEditEffect,
      deleteEffect: CompartmentItemSheet.#onDeleteEffect,
      toggleEffect: CompartmentItemSheet.#onToggleEffect
    }
  };

  static PARTS = {
    body: { template: `${TEMPLATE_PATH}/compartment-sheet.hbs`, scrollable: [""] }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.item;
    return Object.assign(context, {
      item,
      system: item.system,
      editable: this.isEditable,
      isGM: game.user.isGM,
      placedCount: game.user.isGM ? countPlacedFrom(item) : 0,
      keywordsText: item.system.keywords.join(", "),
      categories: SYSTEM_CATEGORIES.map((value) => ({ value, label: localize(`system.${value}`) })),
      skills: [{ value: "", label: localize("itemSheet.defaultSkill") },
        ...Object.entries(CONFIG.DND5E.skills).map(([value, skill]) => ({ value, label: skill.label }))],
      ranges: RANGES.map((value) => ({ value, label: localize(`range.${value}`), checked: item.system.ranges.includes(value) })),
      specials: [{ value: "", label: localize("special.none") }, ...WEAPON_SPECIALS.map((value) => ({ value, label: localize(`special.${value}`) }))],
      specialHint: item.system.special ? localize(`specialHint.${item.system.special}`) : "",
      effects: item.effects.map((effect) => ({
        id: effect.id, name: effect.name, img: effect.img, disabled: effect.disabled, summary: describeChanges(effect.changes)
      })),
      effectPresets: [{ value: "", label: localize("effects.blank") }, ...EFFECT_KEYS.map((value) => ({ value, label: effectKeyLabel(value) }))],
      faces: DAMAGE_FACES.map((value) => ({ value, label: `d${value}` })),
      flags: ["isResidential", "isNoHp", "ignoresPassage", "isOutsideOnly", "isStairs", "isNarrow", "worksWhenDestroyed"].map((key) => ({
        key, label: localize(`keyword.${key}`), checked: item.system[key]
      })),
      descriptionHtml: await foundry.applications.ux.TextEditor.implementation.enrichHTML(item.system.description ?? "", { relativeTo: item })
    });
  }

  /** «Обновить на кораблях»: поставленные копии получают свойства из этого отсека каталога. */
  static async #onSyncShips() {
    const count = countPlacedFrom(this.item);
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: localize("catalog.sync") },
      content: `<p>${format("catalog.syncConfirm", { name: foundry.utils.escapeHTML(this.item.name), count })}</p>`
    });
    if (!confirmed) return;
    const result = await syncCatalogItem(this.item);
    if (!result) return;
    ui.notifications.info(format("catalog.syncDone", { compartments: result.compartments, ships: result.ships }));
    if (result.keptSize.length) ui.notifications.warn(format("catalog.syncKeptSize", { names: result.keptSize.join(", ") }), { permanent: true });
    this.render();
  }

  /** Заготовка: эффект с одним изменением выбранного ключа (+1, прочность +100); пустой — без изменений. */
  static async #onAddEffect() {
    const key = this.element.querySelector("select[data-effect-preset]")?.value ?? "";
    const value = key === "system.maxHp" ? "100" : "1";
    const effect = {
      name: key ? `${effectKeyLabel(key)} +${value}` : localize("effects.newName"),
      img: "icons/svg/aura.svg",
      changes: key ? [{ key, mode: CONST.ACTIVE_EFFECT_MODES.ADD, value }] : []
    };
    const [created] = await this.item.createEmbeddedDocuments("ActiveEffect", [effect]);
    created?.sheet.render(true);
  }

  #effect(target) {
    return this.item.effects.get(target.closest("[data-effect-id]")?.dataset.effectId);
  }

  static #onEditEffect(event, target) {
    this.#effect(target)?.sheet.render(true);
  }

  static async #onDeleteEffect(event, target) {
    await this.#effect(target)?.delete();
  }

  static async #onToggleEffect(event, target) {
    const effect = this.#effect(target);
    await effect?.update({ disabled: !effect.disabled });
  }

  _processFormData(event, form, formData) {
    const data = super._processFormData(event, form, formData);
    // Галочки дистанций приходят отдельными полями, в документ уходит список.
    if (data.rangeFlags) {
      data.system = { ...data.system, ranges: RANGES.filter((range) => data.rangeFlags[range]) };
      delete data.rangeFlags;
    }
    if (typeof data.system?.keywords === "string") {
      data.system.keywords = data.system.keywords.split(",").map((keyword) => keyword.trim()).filter(Boolean);
    }
    return data;
  }
}
