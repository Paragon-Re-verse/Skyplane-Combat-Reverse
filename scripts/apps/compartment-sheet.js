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
      toggleEffect: CompartmentItemSheet.#onToggleEffect,
      clearAmmoItem: CompartmentItemSheet.#onClearAmmoItem
    }
  };

  static PARTS = {
    header: { template: `${TEMPLATE_PATH}/compartment-sheet/header.hbs` },
    tabs: { template: "templates/generic/tab-navigation.hbs" },
    description: { template: `${TEMPLATE_PATH}/compartment-sheet/description.hbs`, scrollable: [""] },
    details: { template: `${TEMPLATE_PATH}/compartment-sheet/details.hbs`, scrollable: [""] },
    combat: { template: `${TEMPLATE_PATH}/compartment-sheet/combat.hbs`, scrollable: [""] },
    inventory: { template: `${TEMPLATE_PATH}/compartment-sheet/inventory.hbs`, scrollable: [""] },
    effects: { template: `${TEMPLATE_PATH}/compartment-sheet/effects.hbs`, scrollable: [""] },
    footer: { template: `${TEMPLATE_PATH}/compartment-sheet/footer.hbs` }
  };

  /** Вкладки как у листа предмета dnd5e: лист отсека не растёт в длину. */
  static TABS = {
    primary: {
      tabs: [
        { id: "description", icon: "fa-solid fa-feather" },
        { id: "details", icon: "fa-solid fa-list" },
        { id: "combat", icon: "fa-solid fa-burst" },
        { id: "inventory", icon: "fa-solid fa-boxes-stacked" },
        { id: "effects", icon: "fa-solid fa-bolt" }
      ],
      initial: "description",
      labelPrefix: `${MODULE_ID}.itemSheet.tab`
    }
  };

  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    context.tab = context.tabs[partId];
    return context;
  }

  /** Поле «Снаряды» принимает перетащенный предмет: ссылка, источник (компендиум), название и картинка. */
  async _onRender(context, options) {
    await super._onRender(context, options);
    const zone = this.element.querySelector('[data-drop-zone="ammo"]');
    if (!zone || !this.isEditable || zone.dataset.bound) return;
    zone.dataset.bound = "true";
    zone.addEventListener("dragover", (event) => event.preventDefault());
    zone.addEventListener("drop", (event) => this.#onDropAmmo(event));
  }

  async #onDropAmmo(event) {
    event.preventDefault();
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    if (data?.type !== "Item") return;
    const item = await fromUuid(data.uuid);
    if (!item) return;
    await this.item.update({
      "system.ammoItem": { uuid: item.uuid, source: item._stats?.compendiumSource ?? "", name: item.name, img: item.img }
    });
  }

  static async #onClearAmmoItem() {
    await this.item.update({ "system.ammoItem": { uuid: "", source: "", name: "", img: "" } });
  }

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
    if (result.keptInventory.length) ui.notifications.warn(format("catalog.syncKeptInventory", { names: result.keptInventory.join(", ") }), { permanent: true });
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
