import {
  MODULE_ID, TEMPLATE_PATH, COMPARTMENT_TYPE, SHIP_TYPE, DISTANCES, SYSTEM_CATEGORIES, PERMISSION_RIGHTS, localize, format, describeChanges, effectKeyLabel
} from "../constants.js";
import { GRID_LIMITS, SHIP_BONUSES, isFunctioning } from "../rules/ship-rules.js";
import {
  canUser, getCompartment, getLog, addCrewMember, updateCrewMember, removeCrewMember, addLogNote, clearLog, isShip, importShipData
} from "../documents/ship-actions.js";
import { deployShip, confirmAndRebuild, startBattle, isSceneStale, placeholderFor } from "../scene/scene-builder.js";
import { requestAction } from "../socket.js";
import { buildGridContext, cellFromEvent, grabOffset } from "./parts/ship-grid-view.js";
import { openCompartmentWindow } from "./compartment-window.js";
import { openBattlePanel } from "./battle-panel.js";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;
const TextEditor = foundry.applications.ux.TextEditor.implementation;

const PARAM_INPUTS = {
  name: "name",
  "system.shipClass": "shipClass",
  "system.captainUuid": "captainUuid",
  "system.currentHp": "currentHp",
  "system.maxHp": "maxHp",
  "system.maxCrew": "maxCrew",
  "system.speed": "speed",
  "system.fuelEconomy": "fuelEconomy",
  "system.description": "description"
};
/** Папка предметов «SkyPlane» для своих отсеков каталога. */
async function catalogFolder() {
  return game.folders.find((folder) => folder.type === "Item" && folder.name === "SkyPlane" && !folder.folder)
    ?? Folder.create({ name: "SkyPlane", type: "Item", color: "#6b1f1a" });
}

const LOG_TYPES = ["damage", "heal", "destroyed", "restored", "repair", "disabled", "phlogiston", "distance", "build", "crew", "scene", "note"];

/**
 * Лист корабля виден всем. Игрок — наблюдатель: любое изменение уходит ГМу именованным действием,
 * поэтому стандартная отправка формы отключена, а поля блокируются по матрице прав.
 */
export class ShipSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["skyplane-combat-reverse", "skyplane-ship-sheet"],
    position: { width: 1060, height: 820 },
    window: { resizable: true },
    form: { handler: ShipSheet.#onSubmit, submitOnChange: false, closeOnSubmit: false },
    actions: {
      setPhlogiston: ShipSheet.#onSetPhlogiston,
      setDistance: ShipSheet.#onSetDistance,
      deploy: ShipSheet.#onDeploy,
      rebuild: ShipSheet.#onRebuild,
      startBattle: ShipSheet.#onStartBattle,
      battlePanel: () => openBattlePanel(),
      viewScene: ShipSheet.#onViewScene,
      recalc: ShipSheet.#onRecalc,
      resize: ShipSheet.#onResize,
      starterKit: ShipSheet.#onStarterKit,
      removeCompartment: ShipSheet.#onRemoveCompartment,
      openCompartment: ShipSheet.#onOpenCompartment,
      openActor: ShipSheet.#onOpenActor,
      removeCrew: ShipSheet.#onRemoveCrew,
      addNote: ShipSheet.#onAddNote,
      clearLog: ShipSheet.#onClearLog,
      newCompartment: ShipSheet.#onNewCompartment,
      editCatalogEntry: ShipSheet.#onEditCatalogEntry,
      deleteCatalogEntry: ShipSheet.#onDeleteCatalogEntry,
      exportJson: ShipSheet.#onExportJson,
      importJson: ShipSheet.#onImportJson
    }
  };

  /** Экспорт и импорт корабля в JSON — кнопки в меню заголовка, только у ГМа. */
  _getHeaderControls() {
    const controls = super._getHeaderControls();
    if (!game.user.isGM) return controls;
    return [
      ...controls,
      { icon: "fa-solid fa-file-export", label: `${MODULE_ID}.sheet.exportJson`, action: "exportJson" },
      { icon: "fa-solid fa-file-import", label: `${MODULE_ID}.sheet.importJson`, action: "importJson" }
    ];
  }

  static PARTS = {
    header: { template: `${TEMPLATE_PATH}/ship-sheet/header.hbs` },
    tabs: { template: "templates/generic/tab-navigation.hbs" },
    params: { template: `${TEMPLATE_PATH}/ship-sheet/params.hbs`, scrollable: [""] },
    builder: { template: `${TEMPLATE_PATH}/ship-sheet/builder.hbs`, scrollable: ["", ".skyplane-palette", ".skyplane-validation"] },
    systems: { template: `${TEMPLATE_PATH}/ship-sheet/systems.hbs`, scrollable: [""] },
    crew: { template: `${TEMPLATE_PATH}/ship-sheet/crew.hbs`, scrollable: [""] },
    description: { template: `${TEMPLATE_PATH}/ship-sheet/description.hbs` },
    log: { template: `${TEMPLATE_PATH}/ship-sheet/log.hbs`, scrollable: [""] }
  };

  static TABS = {
    primary: {
      tabs: [
        { id: "params", icon: "fa-solid fa-gauge" },
        { id: "builder", icon: "fa-solid fa-hammer" },
        { id: "systems", icon: "fa-solid fa-table-list" },
        { id: "crew", icon: "fa-solid fa-users" },
        { id: "description", icon: "fa-solid fa-feather" },
        { id: "log", icon: "fa-solid fa-book" }
      ],
      initial: "params",
      labelPrefix: `${MODULE_ID}.tabs`
    }
  };

  logFilter = "";

  /** Поля открываются по матрице прав; ГМ и игрок с любым правом получают рабочую форму. */
  get isEditable() {
    if (game.user.isGM) return true;
    return PERMISSION_RIGHTS.some((right) => canUser(game.user, this.actor, right));
  }

  _getTabsConfig(group) {
    const config = foundry.utils.deepClone(super._getTabsConfig(group));
    if (!game.user.isGM) config.tabs = config.tabs.filter((tab) => tab.id !== "log");
    return config;
  }

  _configureRenderParts(options) {
    const parts = super._configureRenderParts(options);
    if (!game.user.isGM) delete parts.log;
    return parts;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const ship = this.actor;
    const system = ship.system;
    const rights = Object.fromEntries(PERMISSION_RIGHTS.map((right) => [right, canUser(game.user, ship, right)]));
    const scene = game.scenes.get(ship.getFlag(MODULE_ID, "sceneId"));
    const crew = system.crew.map((member) => {
      const actor = fromUuidSync(member.actorUuid);
      return {
        ...member,
        name: actor?.name ?? localize("crew.missingActor"),
        img: actor?.img ?? "icons/svg/mystery-man.svg",
        isCaptain: member.actorUuid === system.captainUuid
      };
    });

    return Object.assign(context, {
      ship,
      system,
      isGM: game.user.isGM,
      rights,
      tabs: this._prepareTabs("primary"),
      scene,
      sceneStale: scene ? isSceneStale(scene) : false,
      crew,
      captainOptions: [{ value: "", label: localize("crew.noCaptain") }, ...crew.map((member) => ({ value: member.actorUuid, label: member.name }))],
      phlogistonSlots: [5, 4, 3, 2, 1, 0].map((value) => ({
        value, label: value === 0 ? "!" : value, active: value === system.phlogiston, critical: value === 0
      })),
      distances: DISTANCES.map((distance) => ({
        id: distance,
        label: localize(`distance.${distance}.label`),
        effect: localize(`distance.${distance}.effect`),
        active: distance === system.combatDistance
      })),
      statuses: [
        system.isOverloaded && localize("status.overloaded"),
        system.isDisabled && localize("status.disabled"),
        system.isCritical && localize("status.critical")
      ].filter(Boolean),
      grid: buildGridContext(ship, rights.build),
      gridLimits: GRID_LIMITS,
      palette: await this.#paletteEntries(rights.build),
      errors: system.validation.errors.map((entry) => format(entry.key, entry.data)),
      warnings: system.validation.warnings.map((entry) => format(entry.key, entry.data)),
      systemTables: SYSTEM_CATEGORIES.map((category) => ({
        id: category,
        label: localize(`system.${category}`),
        rows: system.systems[category],
        isWeapons: category === "weapons",
        isEngine: category === "engine"
      })),
      effectRows: system.compartments.flatMap((compartment) => compartment.effects.map((effect) => ({
        instanceId: compartment.instanceId,
        compartment: compartment.name,
        name: effect.name,
        img: effect.img,
        summary: describeChanges(effect.changes),
        active: !effect.disabled && compartment.effectActive !== false && isFunctioning(compartment)
      }))),
      bonuses: SHIP_BONUSES.filter((bonus) => system.bonuses[bonus]).map((bonus) => {
        const value = system.bonuses[bonus];
        return `${effectKeyLabel(`system.bonuses.${bonus}`)} ${value > 0 ? "+" : ""}${value}`;
      }).join(", "),
      descriptionHtml: await TextEditor.enrichHTML(system.description ?? "", { relativeTo: ship }),
      log: this.#logEntries(),
      logTypes: LOG_TYPES.map((type) => ({ value: type, label: localize(`logType.${type}`) })),
      logFilter: this.logFilter
    });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (options.parts && !options.parts.includes("builder")) return;
    for (const entry of this.element.querySelectorAll(".skyplane-palette-entry")) {
      entry.addEventListener("mouseenter", () => this.#highlightCatalogEntry(entry));
      entry.addEventListener("mouseleave", () => this.#highlightCatalogEntry(null));
    }
  }

  /** Подсветка на сетке: такие же отсеки светятся, остальные притухают. */
  #highlightCatalogEntry(entry) {
    const grid = this.element.querySelector(".skyplane-grid");
    if (!grid) return;
    let matches = 0;
    for (const element of grid.querySelectorAll(".skyplane-compartment")) {
      const same = !!entry && (element.dataset.sourceUuid === entry.dataset.uuid ||
        (!!entry.dataset.catalogId && element.dataset.catalogId === entry.dataset.catalogId));
      element.classList.toggle("skyplane-highlight", same);
      if (same) matches++;
    }
    // Если такого отсека на корабле нет, сетку не притушаем.
    grid.classList.toggle("has-highlight", matches > 0);
  }

  async _preparePartContext(partId, context, options) {
    context = await super._preparePartContext(partId, context, options);
    context.tab = context.tabs[partId];
    return context;
  }

  /** Каталог: отсеки мира и компендиума; мировая копия с тем же catalogId заменяет запись компендиума. */
  async #paletteEntries(canBuild) {
    if (!canBuild) return [];
    const entries = [];
    const worldItems = game.items.filter((document) => document.type === COMPARTMENT_TYPE);
    const overridden = new Set(worldItems.map((item) => item.system.catalogId).filter(Boolean));
    for (const item of worldItems) {
      entries.push({
        uuid: item.uuid, name: item.name, width: item.system.width, height: item.system.height,
        category: item.system.systemCategory, catalogId: item.system.catalogId, world: true
      });
    }
    const pack = game.packs.get(`${MODULE_ID}.compartments`);
    const index = await pack?.getIndex({ fields: ["system.width", "system.height", "system.systemCategory", "system.catalogId"] });
    for (const entry of index ?? []) {
      if (overridden.has(entry.system?.catalogId)) continue;
      entries.push({
        uuid: entry.uuid, name: entry.name, width: entry.system?.width, height: entry.system?.height,
        category: entry.system?.systemCategory, catalogId: entry.system?.catalogId
      });
    }
    return entries
      .map((entry) => ({ ...entry, categoryLabel: localize(`system.${entry.category ?? "equipment"}`) }))
      .sort((first, second) => first.categoryLabel.localeCompare(second.categoryLabel) || first.name.localeCompare(second.name));
  }

  #logEntries() {
    if (!game.user.isGM) return [];
    return [...getLog(this.actor)]
      .reverse()
      .filter((entry) => !this.logFilter || entry.type === this.logFilter)
      .map((entry) => ({
        ...entry,
        timeLabel: new Date(entry.time).toLocaleString(game.i18n.lang),
        userName: game.users.get(entry.userId)?.name ?? "—",
        typeLabel: localize(`logType.${entry.type}`)
      }));
  }

  /* ---------------- Изменения полей ---------------- */

  static async #onSubmit() {}

  _onChangeForm(formConfig, event) {
    const target = event.target;
    if (target.name === "logFilter") {
      this.logFilter = target.value;
      return this.render({ parts: ["log"] });
    }
    if (target.dataset.crewUuid) {
      return updateCrewMember(this.actor, target.dataset.crewUuid, { [target.dataset.crewField]: target.value });
    }
    const param = PARAM_INPUTS[target.name];
    if (param) return requestAction("updateParams", this.actor, { changes: { [param]: target.value } });
  }

  /* ---------------- Перетаскивание ---------------- */

  _canDragStart() {
    return canUser(game.user, this.actor, "build");
  }

  _canDragDrop() {
    return game.user.isGM || canUser(game.user, this.actor, "build");
  }

  async _onDragStart(event) {
    const element = event.currentTarget;
    let dragData = null;
    if (element.dataset.instanceId) {
      const compartment = getCompartment(this.actor, element.dataset.instanceId);
      if (!compartment) return;
      dragData = { type: `${MODULE_ID}.placed`, shipUuid: this.actor.uuid, instanceId: compartment.instanceId, offset: grabOffset(element, event, compartment) };
    } else if (element.dataset.uuid) {
      dragData = { type: "Item", uuid: element.dataset.uuid, offset: { x: 0, y: 0 } };
    }
    if (dragData) event.dataTransfer.setData("text/plain", JSON.stringify(dragData));
  }

  async _onDrop(event) {
    const data = TextEditor.getDragEventData(event);
    const grid = event.target.closest(".skyplane-grid");
    const crewZone = event.target.closest(".skyplane-crew");

    if (crewZone && data.type === "Actor") {
      if (!game.user.isGM) return ui.notifications.warn(localize("notify.gmOnly"));
      const actor = await fromUuid(data.uuid);
      if (!actor || isShip(actor)) return;
      return addCrewMember(this.actor, actor.uuid);
    }
    if (!grid) return;
    const { gridWidth, gridHeight } = this.actor.system;
    const cell = cellFromEvent(grid, event, gridWidth, gridHeight, data.offset ?? { x: 0, y: 0 });

    if (data.type === `${MODULE_ID}.placed` && data.shipUuid === this.actor.uuid) {
      return requestAction("buildAction", this.actor, { op: "move", instanceId: data.instanceId, ...cell });
    }
    if (data.type === "Item") {
      const item = await fromUuid(data.uuid);
      if (item?.type !== COMPARTMENT_TYPE) return ui.notifications.warn(localize("notify.notCompartment"));
      return requestAction("buildAction", this.actor, { op: "add", sourceUuid: item.uuid, ...cell });
    }
  }

  /* ---------------- Кнопки ---------------- */

  static #onSetPhlogiston(event, target) {
    requestAction("setPhlogiston", this.actor, { value: Number(target.dataset.value) });
  }

  static #onSetDistance(event, target) {
    requestAction("setDistance", this.actor, { value: target.dataset.value });
  }

  static async #onDeploy() {
    const scene = await deployShip(this.actor);
    scene?.view();
  }

  static async #onRebuild() {
    const scene = game.scenes.get(this.actor.getFlag(MODULE_ID, "sceneId"));
    if (scene) await confirmAndRebuild(scene);
  }

  static #onViewScene() {
    game.scenes.get(this.actor.getFlag(MODULE_ID, "sceneId"))?.view();
  }

  static async #onStartBattle() {
    const others = game.actors.filter((actor) => actor.type === SHIP_TYPE && actor !== this.actor);
    if (!others.length) return ui.notifications.warn(localize("notify.noOtherShips"));
    const options = others.map((actor) => `<option value="${actor.uuid}">${foundry.utils.escapeHTML(actor.name)}</option>`).join("");
    const opponentUuid = await foundry.applications.api.DialogV2.prompt({
      window: { title: localize("battle.startTitle"), icon: "fa-solid fa-crosshairs" },
      content: `<div class="form-group"><label>${localize("battle.opponent")}</label><select name="opponent">${options}</select></div>`,
      ok: { label: localize("battle.start"), callback: (event, button) => button.form.elements.opponent.value },
      rejectClose: false
    });
    if (!opponentUuid) return;
    const scene = await startBattle(this.actor, opponentUuid);
    scene?.view();
  }

  static #onRecalc() {
    requestAction("updateParams", this.actor, { recalc: true });
  }

  static #onResize(event, target) {
    const { gridWidth, gridHeight } = this.actor.system;
    requestAction("buildAction", this.actor, {
      op: "resize",
      width: gridWidth + Number(target.dataset.width ?? 0),
      height: gridHeight + Number(target.dataset.height ?? 0)
    });
  }

  static #onStarterKit() {
    requestAction("buildAction", this.actor, { op: "starterKit" });
  }

  static #onRemoveCompartment(event, target) {
    event.stopPropagation();
    requestAction("buildAction", this.actor, { op: "remove", instanceId: target.closest("[data-instance-id]").dataset.instanceId });
  }

  static #onOpenCompartment(event, target) {
    openCompartmentWindow(this.actor, target.closest("[data-instance-id]").dataset.instanceId);
  }

  static async #onOpenActor(event, target) {
    (await fromUuid(target.dataset.uuid))?.sheet.render(true);
  }

  static #onRemoveCrew(event, target) {
    removeCrewMember(this.actor, target.dataset.uuid);
  }

  static async #onAddNote() {
    const input = this.element.querySelector("textarea[name=logNote]");
    await addLogNote(this.actor, input?.value);
  }

  static async #onNewCompartment() {
    const folder = await catalogFolder();
    const item = await Item.create({
      name: localize("catalog.newName"),
      type: COMPARTMENT_TYPE,
      img: placeholderFor("equipment"),
      folder: folder.id,
      system: { catalogId: `custom_${foundry.utils.randomID(8)}` }
    });
    item?.sheet.render(true);
  }

  /** Мировой отсек правится сразу; отсек компендиума сначала копируется в мир с тем же catalogId. */
  static async #onEditCatalogEntry(event, target) {
    event.stopPropagation();
    const source = await fromUuid(target.closest("[data-uuid]").dataset.uuid);
    if (!source) return;
    if (!source.pack) return source.sheet.render(true);
    const folder = await catalogFolder();
    const copy = await Item.create({ ...game.items.fromCompendium(source), folder: folder.id });
    ui.notifications.info(format("catalog.copied", { name: copy.name }));
    copy.sheet.render(true);
  }

  static async #onDeleteCatalogEntry(event, target) {
    event.stopPropagation();
    const item = await fromUuid(target.closest("[data-uuid]").dataset.uuid);
    if (!item || item.pack) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: localize("catalog.delete") },
      content: `<p>${format("catalog.deleteConfirm", { name: foundry.utils.escapeHTML(item.name) })}</p>`
    });
    if (confirmed) await item.delete();
  }

  static #onExportJson() {
    this.actor.exportToJSON();
  }

  /** Файл экспорта (этого листа или каталога актёров Foundry) заменяет корабль; сцена, журнал и права остаются. */
  static async #onImportJson() {
    const file = await foundry.applications.api.DialogV2.prompt({
      window: { title: localize("sheet.importJson"), icon: "fa-solid fa-file-import" },
      content: `<p>${localize("sheet.importHint")}</p><input type="file" name="file" accept=".json,application/json">`,
      ok: { label: localize("sheet.importJson"), callback: (event, button) => button.form.elements.file.files[0] ?? null },
      rejectClose: false
    });
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await foundry.utils.readTextFromFile(file));
    } catch {
      return ui.notifications.warn(localize("notify.invalidJson"));
    }
    if (await importShipData(this.actor, data)) ui.notifications.info(format("notify.imported", { name: this.actor.name }));
  }

  static async #onClearLog() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: localize("log.clearTitle") },
      content: `<p>${localize("log.clearConfirm")}</p>`
    });
    if (confirmed) await clearLog(this.actor);
  }
}
