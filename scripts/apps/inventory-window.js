/**
 * Окно инвентаря отсека: сетка (перетаскивание, поворот, меню правого клика), у ГМа — каталог грузов с поиском.
 * Игрок меняет инвентарь, только пока его токен стоит в отсеке; иначе окно только для просмотра.
 * Все изменения — действия ГМа (inventory-actions.js) через requestAction.
 */
import { MODULE_ID, TEMPLATE_PATH, localize, format, localPack } from "../constants.js";
import { footprint, INVENTORY_LIMIT } from "../rules/inventory-rules.js";
import { getShip, getCompartment, isShip } from "../documents/ship-actions.js";
import { isPresent, PHYSICAL_TYPES } from "../documents/inventory-actions.js";
import { tokenInCompartment } from "../combat/ship-combat.js";
import { requestAction } from "../socket.js";
import { askQuantity } from "./quantity-dialog.js";
import { attachGrid, CELL_SIZE } from "./parts/inventory-grid.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/** Свой компендиум грузов ГМа — с этим префиксом имени, чтобы конструктор не принял его за каталог отсеков. */
export const CUSTOM_CARGO_PREFIX = "skyplane-cargo-";
const CATALOG_MAX = 20;

export function openInventoryWindow(shipOrUuid, instanceId) {
  const ship = getShip(shipOrUuid);
  if (!ship || !getCompartment(ship, instanceId)?.inventoryWidth) return null;
  const id = `${MODULE_ID}-inventory-${ship.id}-${instanceId}`;
  const existing = foundry.applications.instances.get(id);
  if (existing) return existing.render({ force: true });
  return new InventoryWindow({ id, ship, instanceId }).render({ force: true });
}

/** Компендиумы для каталога ГМа: грузы и ремкомплекты модуля и компендиумы предметов в папке модуля. */
export function cargoPacks() {
  const base = [localPack("cargo"), localPack("repair-items")].map((id) => game.packs.get(id)).filter(Boolean);
  const folderId = game.packs.get(localPack("compartments"))?.folder?.id;
  const custom = folderId
    ? game.packs.filter((pack) => pack.documentName === "Item" && pack.folder?.id === folderId && pack.metadata.packageName !== MODULE_ID)
    : [];
  return [...base, ...custom].filter((pack) => pack.visible);
}

export class InventoryWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options) {
    super(options);
    this.ship = options.ship;
    this.instanceId = options.instanceId;
  }

  catalogFilter = { text: "", type: "" };

  static DEFAULT_OPTIONS = {
    classes: ["skyplane-combat-reverse", "skyplane-inventory-window"],
    position: { width: "auto", height: "auto" },
    window: { icon: "fa-solid fa-boxes-stacked", resizable: true },
    actions: {
      newCargo: InventoryWindow.#onNewCargo,
      addCatalogItem: InventoryWindow.#onAddCatalogItem
    }
  };

  static PARTS = {
    body: { template: `${TEMPLATE_PATH}/inventory-window.hbs`, scrollable: [".skyplane-inventory-catalog ol"] }
  };

  get title() {
    return format("inventory.title", { compartment: getCompartment(this.ship, this.instanceId)?.name ?? "—", ship: this.ship.name });
  }

  get #scene() {
    return canvas.ready ? canvas.scene : null;
  }

  get readOnly() {
    return !isPresent(game.user, this.#scene, this.ship, this.instanceId);
  }

  async _prepareContext() {
    const compartment = getCompartment(this.ship, this.instanceId);
    if (!compartment?.inventoryWidth) return { missing: true };
    const entries = compartment.inventory.map((entry) => {
      const { width, height } = footprint(entry);
      const quantity = entry.item.system?.quantity ?? 1;
      return {
        instanceId: entry.instanceId,
        name: entry.item.name,
        img: entry.item.img || "icons/svg/item-bag.svg",
        quantity,
        multiple: quantity > 1,
        style: `left: ${(entry.x - 1) * CELL_SIZE}px; top: ${(entry.y - 1) * CELL_SIZE}px; width: ${width * CELL_SIZE}px; height: ${height * CELL_SIZE}px;`
      };
    });
    return {
      shipUuid: this.ship.uuid,
      instanceId: this.instanceId,
      width: compartment.inventoryWidth,
      height: compartment.inventoryHeight,
      gridStyle: `width: ${compartment.inventoryWidth * CELL_SIZE}px; height: ${compartment.inventoryHeight * CELL_SIZE}px; --cell: ${CELL_SIZE}px;`,
      entries,
      readOnly: this.readOnly,
      isGM: game.user.isGM,
      catalog: game.user.isGM ? await this.#catalogEntries() : [],
      types: PHYSICAL_TYPES.map((value) => ({ value, label: game.i18n.localize(CONFIG.Item.typeLabels[value] ?? value) }))
    };
  }

  async #catalogEntries() {
    const entries = [];
    for (const pack of cargoPacks()) {
      const index = await pack.getIndex({ fields: ["type", "img"] });
      for (const entry of index) {
        if (PHYSICAL_TYPES.includes(entry.type)) entries.push({ uuid: entry.uuid, name: entry.name, img: entry.img, type: entry.type, pack: pack.metadata.label });
      }
    }
    return entries.sort((first, second) => first.name.localeCompare(second.name));
  }

  /** Меню правого клика вешается один раз на окно: элементы сетки перерисовываются, окно — нет. */
  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    new foundry.applications.ux.ContextMenu.implementation(this.element, ".skyplane-inventory-grid:not(.readonly) [data-entry-id]", this.#menuItems(), {
      jQuery: false, fixed: true
    });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const grid = this.element.querySelector("[data-inventory-grid]");
    if (grid && !context.readOnly) {
      const entries = getCompartment(this.ship, this.instanceId).inventory;
      attachGrid(grid, { entries, onDrop: (entry, target) => this.#onGridDrop(entry, target) });
      grid.addEventListener("dragover", (event) => event.preventDefault());
      grid.addEventListener("drop", (event) => this.#onNativeDrop(event, grid));
    }
    // Поиск и фильтр каталога — без перерисовки окна; переживают перерисовку после каждого изменения корабля.
    const catalog = this.element.querySelector(".skyplane-inventory-catalog");
    if (catalog) {
      const search = catalog.querySelector("input[type=search]");
      const type = catalog.querySelector("select");
      search.value = this.catalogFilter.text;
      type.value = this.catalogFilter.type;
      const filter = () => {
        this.catalogFilter = { text: search.value, type: type.value };
        const text = search.value.trim().toLowerCase();
        for (const item of catalog.querySelectorAll("[data-uuid]")) {
          item.hidden = (text && !item.dataset.name.toLowerCase().includes(text)) || (type.value && item.dataset.type !== type.value);
        }
      };
      search.addEventListener("input", filter);
      type.addEventListener("change", filter);
      filter();
      for (const item of catalog.querySelectorAll("[data-uuid]")) {
        item.addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid: item.dataset.uuid })));
      }
    }
  }

  #request(name, payload) {
    return requestAction(name, this.ship, { instanceId: this.instanceId, sceneId: this.#scene?.id ?? null, ...payload });
  }

  #entry(entryId) {
    return getCompartment(this.ship, this.instanceId)?.inventory.find((entry) => entry.instanceId === entryId) ?? null;
  }

  async #onGridDrop(entry, target) {
    const quantity = entry.item.system?.quantity ?? 1;
    if (target.kind === "grid") {
      if (target.shipUuid === this.ship.uuid && target.instanceId === this.instanceId) {
        if (target.x === entry.x && target.y === entry.y && target.rotated === entry.rotated) return;
        return this.#request("inventoryMove", { entryId: entry.instanceId, x: target.x, y: target.y, rotated: target.rotated });
      }
      const count = await askQuantity(entry.item.name, quantity);
      if (!count) return;
      return this.#request("inventoryTransfer", {
        entryId: entry.instanceId, quantity: count, targetShipUuid: target.shipUuid, targetInstanceId: target.instanceId, x: target.x, y: target.y
      });
    }
    if (target.kind === "actor" && !isShip(target.actor)) {
      const count = await askQuantity(entry.item.name, quantity);
      if (count) return this.#request("inventoryTake", { entryId: entry.instanceId, quantity: count, actorUuid: target.actor.uuid });
    }
  }

  /** Предмет с листа персонажа (переносится) или, у ГМа, из каталога и компендиумов (кладётся копия). */
  async #onNativeDrop(event, grid) {
    event.preventDefault();
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    if (data?.type !== "Item") return;
    const item = await fromUuid(data.uuid);
    if (!item) return;
    const rect = grid.getBoundingClientRect();
    const cell = { x: Math.floor((event.clientX - rect.left) / CELL_SIZE) + 1, y: Math.floor((event.clientY - rect.top) / CELL_SIZE) + 1 };
    const owner = item.parent;
    if (owner?.documentName === "Actor" && !isShip(owner)) {
      const count = await askQuantity(item.name, item.system.quantity ?? 1);
      if (count) await this.#request("inventoryStore", { actorUuid: owner.uuid, itemId: item.id, quantity: count, ...cell });
      return;
    }
    if (!game.user.isGM) return ui.notifications.warn(localize("inventory.onlyFromCharacter"));
    const count = await askQuantity(item.name, CATALOG_MAX, 1);
    if (count) await this.#request("inventoryAddCatalog", { uuid: item.uuid, quantity: count, ...cell });
  }

  /** Кому отдать вещь по «Забрать себе»: токен пользователя в отсеке, выбранный токен, назначенный персонаж. */
  #receiver() {
    const scene = this.#scene;
    const candidates = [
      scene && tokenInCompartment(scene, this.ship, this.instanceId)?.actor,
      canvas.tokens?.controlled[0]?.actor,
      game.user.character
    ];
    return candidates.find((actor) => actor && !isShip(actor)) ?? null;
  }

  #menuItems() {
    const entryOf = (element) => this.#entry(element.closest("[data-entry-id]")?.dataset.entryId);
    const quantityOf = (entry) => entry?.item.system?.quantity ?? 1;
    return [
      {
        name: `${MODULE_ID}.inventory.rotate`,
        icon: '<i class="fa-solid fa-rotate"></i>',
        callback: (element) => {
          const entry = entryOf(element);
          if (entry) this.#request("inventoryMove", { entryId: entry.instanceId, x: entry.x, y: entry.y, rotated: !entry.rotated });
        }
      },
      {
        name: `${MODULE_ID}.inventory.resize`,
        icon: '<i class="fa-solid fa-up-right-and-down-left-from-center"></i>',
        callback: (element) => this.#resize(entryOf(element))
      },
      {
        name: `${MODULE_ID}.inventory.split`,
        icon: '<i class="fa-solid fa-scissors"></i>',
        condition: (element) => quantityOf(entryOf(element)) > 1,
        callback: async (element) => {
          const entry = entryOf(element);
          const count = entry && await askQuantity(entry.item.name, quantityOf(entry) - 1);
          if (count) this.#request("inventorySplit", { entryId: entry.instanceId, quantity: count });
        }
      },
      {
        name: `${MODULE_ID}.inventory.take`,
        icon: '<i class="fa-solid fa-hand"></i>',
        callback: async (element) => {
          const entry = entryOf(element);
          const actor = this.#receiver();
          if (!entry) return;
          if (!actor) return ui.notifications.warn(localize("inventory.noReceiver"));
          const count = await askQuantity(entry.item.name, quantityOf(entry));
          if (count) this.#request("inventoryTake", { entryId: entry.instanceId, quantity: count, actorUuid: actor.uuid });
        }
      },
      {
        name: `${MODULE_ID}.inventory.delete`,
        icon: '<i class="fa-solid fa-trash"></i>',
        condition: () => game.user.isGM,
        callback: async (element) => {
          const entry = entryOf(element);
          if (!entry) return;
          const confirmed = await DialogV2.confirm({
            window: { title: localize("inventory.delete") },
            content: `<p>${foundry.utils.escapeHTML(format("inventory.deleteConfirm", { item: entry.item.name, count: quantityOf(entry) }))}</p>`
          });
          if (confirmed) this.#request("inventoryDelete", { entryId: entry.instanceId });
        }
      }
    ];
  }

  async #resize(entry) {
    if (!entry) return;
    const { width, height } = footprint({ ...entry, rotated: false });
    const size = await DialogV2.prompt({
      window: { title: localize("inventory.resize") },
      content: `<div class="form-group"><label>${localize("itemSheet.inventorySize")}</label>
        <div class="form-fields">
          <input type="number" name="width" min="1" max="${INVENTORY_LIMIT}" value="${width}"> ×
          <input type="number" name="height" min="1" max="${INVENTORY_LIMIT}" value="${height}">
        </div></div>`,
      ok: { callback: (event, button) => ({ width: Number(button.form.elements.width.value), height: Number(button.form.elements.height.value) }) },
      rejectClose: false
    });
    if (size) this.#request("inventoryResize", { entryId: entry.instanceId, ...size });
  }

  /** «Новый груз»: «Добыча» в своём компендиуме грузов (создаётся в папке модуля при первом грузе). */
  static async #onNewCargo() {
    const folder = game.packs.get(localPack("compartments"))?.folder;
    let pack = game.packs.find((candidate) => candidate.metadata.name.startsWith(CUSTOM_CARGO_PREFIX) && candidate.documentName === "Item");
    if (!pack) {
      const { CompendiumCollection } = foundry.documents.collections;
      pack = await CompendiumCollection.createCompendium({
        label: localize("inventory.customPack"), name: `${CUSTOM_CARGO_PREFIX}${foundry.utils.randomID(4).toLowerCase()}`, type: "Item"
      });
      if (folder) await pack.setFolder(folder);
    }
    const item = await Item.implementation.create({ name: localize("inventory.newCargo"), type: "loot", img: "icons/svg/item-bag.svg" }, { pack: pack.collection });
    item?.sheet.render(true);
    this.render();
  }

  static async #onAddCatalogItem(event, target) {
    const element = target.closest("[data-uuid]");
    const count = await askQuantity(element.dataset.name, CATALOG_MAX, 1);
    if (count) this.#request("inventoryAddCatalog", { uuid: element.dataset.uuid, quantity: count });
  }
}
