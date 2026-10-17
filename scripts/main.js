import { MODULE_ID, SHIP_TYPE, COMPARTMENT_TYPE, localize } from "./constants.js";
import { registerSettings, applyAnimationSetting } from "./settings.js";
import { registerSocket } from "./socket.js";
import { api } from "./api.js";
import { ShipData } from "./data/ship-data-model.js";
import { CompartmentData } from "./data/compartment-data-model.js";
import { runPlayerAction, getShip, canUser } from "./documents/ship-actions.js";
import { requestAction } from "./socket.js";
import { registerSceneSync } from "./scene/scene-builder.js";
import { registerOverlay } from "./scene/scene-overlay.js";
import { registerReveal, patchVisibility } from "./scene/reveal.js";
import { ShipSheet } from "./apps/ship-sheet.js";
import { CompartmentItemSheet } from "./apps/compartment-sheet.js";
import { CompartmentWindow } from "./apps/compartment-window.js";
import { registerBattlePanel } from "./apps/battle-panel.js";
import { firstRun, migrateData } from "./setup/first-run.js";
import "./combat/ship-combat.js";
import { registerHitCards } from "./combat/hit-card.js";

// socketlib вызывает socketlib.ready на своём init — подписка нужна до него.
registerSocket(runPlayerAction);

Hooks.once("init", () => {
  CONFIG.Actor.dataModels[SHIP_TYPE] = ShipData;
  CONFIG.Item.dataModels[COMPARTMENT_TYPE] = CompartmentData;

  const { DocumentSheetConfig } = foundry.applications.apps;
  DocumentSheetConfig.registerSheet(Actor, MODULE_ID, ShipSheet, {
    types: [SHIP_TYPE], makeDefault: true, label: `${MODULE_ID}.sheet.ship`
  });
  DocumentSheetConfig.registerSheet(Item, MODULE_ID, CompartmentItemSheet, {
    types: [COMPARTMENT_TYPE], makeDefault: true, label: `${MODULE_ID}.sheet.compartment`
  });

  registerSettings();
  // Ctrl+Z в открытом конструкторе корабля; в остальных случаях клавиша достаётся Foundry.
  game.keybindings.register(MODULE_ID, "undoBuild", {
    name: `${MODULE_ID}.keybinding.undo.name`,
    hint: `${MODULE_ID}.keybinding.undo.hint`,
    editable: [{ key: "KeyZ", modifiers: ["Control"] }],
    precedence: CONST.KEYBINDING_PRECEDENCE.PRIORITY,
    onDown: () => {
      const sheet = ui.activeWindow;
      if (!(sheet instanceof ShipSheet) || sheet.tabGroups.primary !== "builder" || !canUser(game.user, sheet.actor, "build")) return false;
      requestAction("buildAction", sheet.actor, { op: "undo" });
      return true;
    }
  });
  patchVisibility();
  registerSceneSync();
  registerOverlay();
  registerReveal();
  registerBattlePanel();
  registerHitCards();

  // {{sky "params.hp"}} — локализация с корневым ключом модуля.
  Handlebars.registerHelper("sky", (key) => localize(key));
  game.modules.get(MODULE_ID).api = api;
});

Hooks.once("ready", async () => {
  applyAnimationSetting();
  await migrateData();
  firstRun();
});

// Новый корабль виден всем: право наблюдателя по умолчанию, изменения — через ГМа.
Hooks.on("preCreateActor", (actor, data) => {
  const { OBSERVER } = CONST.DOCUMENT_OWNERSHIP_LEVELS;
  if (actor.type !== SHIP_TYPE || (data.ownership?.default ?? 0) >= OBSERVER) return;
  actor.updateSource({ "ownership.default": OBSERVER });
});

// Каталог в конструкторе следует за отсеками мира: создание, правка, удаление.
for (const hook of ["createItem", "updateItem", "deleteItem"]) {
  Hooks.on(hook, (item) => {
    if (item.type !== COMPARTMENT_TYPE || item.parent) return;
    for (const application of foundry.applications.instances.values()) {
      if (application instanceof ShipSheet && application.rendered) application.render({ parts: ["builder"] });
    }
  });
}

// Новый раунд боя снимает отметку «уже стреляла» в окнах отсеков и на панели боя.
Hooks.on("updateCombat", (combat, changed) => {
  if (!("round" in changed || "turn" in changed)) return;
  for (const application of foundry.applications.instances.values()) {
    if (application instanceof CompartmentWindow || application.id === `${MODULE_ID}-battle-panel`) application.render();
  }
});

// Открытые окна отсеков перерисовываются вслед за кораблём.
Hooks.on("updateActor", (actor) => {
  if (!getShip(actor)) return;
  for (const application of foundry.applications.instances.values()) {
    if (application instanceof CompartmentWindow && application.ship === actor) application.render();
  }
});
