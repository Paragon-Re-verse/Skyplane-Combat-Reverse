import { MODULE_ID, TEMPLATE_PATH, DISTANCES, SIDES, localize, format } from "../constants.js";
import { isDestroyed, parseHpInput, isWeapon, isFunctioning, weaponRanges, shotCount } from "../rules/ship-rules.js";
import { getShip, setShipHp } from "../documents/ship-actions.js";
import { getLayout, sceneSides } from "../scene/scene-builder.js";
import { setReveal, revealState } from "../scene/reveal.js";
import { requestAction } from "../socket.js";
import { openCompartmentWindow } from "./compartment-window.js";
import { startShot, hasFiredThisRound, chargeState, shipWeaponFormula } from "../combat/ship-combat.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function battleScene() {
  const scene = canvas.ready ? canvas.scene : null;
  return getLayout(scene)?.mode === "battle" ? scene : null;
}

/** Статус пушки на панели: разрушена, заряжается, стреляла, заряжена / не заряжена (зарядка), готова. */
function gunStatus(ship, compartment, scene) {
  if (!isFunctioning(compartment)) return "destroyed";
  const charge = compartment.special === "charge" ? chargeState(ship, compartment.instanceId, scene) : null;
  if (charge === "charging") return "charging";
  if (hasFiredThisRound(ship, compartment.instanceId, scene)) return "fired";
  if (compartment.special === "charge") return charge ? "charged" : "uncharged";
  return "ready";
}

/** Компактная панель боя ГМа: оба корабля, общая дистанция, разведка. Игроки её не видят. */
export class BattlePanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-battle-panel`,
    classes: ["skyplane-combat-reverse", "skyplane-battle-panel"],
    window: { title: `${MODULE_ID}.battle.panelTitle`, icon: "fa-solid fa-crosshairs", resizable: true },
    position: { width: 640, height: "auto", top: 80, left: 120 },
    actions: {
      setDistance: BattlePanel.#onSetDistance,
      setPhlogiston: BattlePanel.#onSetPhlogiston,
      applyHp: BattlePanel.#onApplyHp,
      toggleReveal: BattlePanel.#onToggleReveal,
      openSheet: BattlePanel.#onOpenSheet,
      openCompartment: BattlePanel.#onOpenCompartment,
      fireGun: BattlePanel.#onFireGun
    }
  };

  static PARTS = {
    body: { template: `${TEMPLATE_PATH}/battle-panel.hbs`, scrollable: [""] }
  };

  async _prepareContext() {
    const scene = battleScene();
    if (!scene) return { noBattle: true };
    const layout = getLayout(scene);
    const sides = sceneSides(scene).map(({ side, ship }) => ({
      side,
      ship,
      system: ship.system,
      reveal: revealState(layout, side),
      guns: ship.system.compartments.filter(isWeapon).map((compartment) => {
        const status = gunStatus(ship, compartment, scene);
        const count = shotCount(compartment);
        return {
          instanceId: compartment.instanceId,
          name: compartment.name,
          formula: shipWeaponFormula(ship, compartment) + (count > 1 ? ` (${format("combat.volleyCount", { count })})` : ""),
          range: weaponRanges(compartment).map((range) => localize(`range.${range}`)).join(", "),
          special: compartment.special ? localize(`special.${compartment.special}`) : "",
          status,
          statusLabel: localize(`battle.gun.${status}`),
          canAct: status === "ready" || status === "charged" || status === "uncharged",
          actionLabel: localize(status === "uncharged" ? "battle.chargeAsCrew" : "battle.fireAsCrew"),
          actionIcon: status === "uncharged" ? "fa-bolt" : "fa-burst"
        };
      }),
      phlogistonSlots: [5, 4, 3, 2, 1, 0].map((value) => ({ value, label: value === 0 ? "!" : value, active: value === ship.system.phlogiston })),
      compartments: ship.system.compartments
        .filter((compartment) => !compartment.isNoHp)
        .map((compartment) => ({ ...compartment, destroyed: isDestroyed(compartment) }))
    }));
    const distance = sides[0]?.system.combatDistance;
    return {
      sides,
      distances: DISTANCES.map((id) => ({ id, label: localize(`distance.${id}.label`), active: id === distance }))
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    for (const input of this.element.querySelectorAll("input[name=hpDelta]")) {
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        BattlePanel.#onApplyHp.call(this, event, input);
      });
    }
  }

  #ship(target) {
    return getShip(target.closest("[data-ship-uuid]")?.dataset.shipUuid);
  }

  static #onSetDistance(event, target) {
    const ship = sceneSides(battleScene())[0]?.ship;
    if (ship) requestAction("setDistance", ship, { value: target.dataset.value });
  }

  static #onSetPhlogiston(event, target) {
    requestAction("setPhlogiston", this.#ship(target), { value: Number(target.dataset.value) });
  }

  static async #onApplyHp(event, target) {
    const ship = this.#ship(target);
    const input = target.closest("[data-ship-uuid]").querySelector("input[name=hpDelta]");
    const value = parseHpInput(input.value, ship.system.currentHp);
    if (value === null) return ui.notifications.warn(localize("notify.invalidNumber"));
    await setShipHp(ship, value);
  }

  /** «Раскрыть» / «Скрыть» — решение ГМа поверх разведки, «Авто» — снова по разведке. */
  static #onToggleReveal(event, target) {
    const scene = battleScene();
    const side = target.dataset.side;
    if (!scene || !SIDES.includes(side)) return;
    const modes = { reveal: true, hide: false, auto: null };
    setReveal(scene, side, modes[target.dataset.mode]);
  }

  static #onOpenSheet(event, target) {
    this.#ship(target)?.sheet.render(true);
  }

  /** Выстрел за экипаж: стреляет токен в пушке, если он есть, иначе капитан или экипаж корабля. */
  static #onFireGun(event, target) {
    startShot(this.#ship(target), target.dataset.instanceId);
  }

  static #onOpenCompartment(event, target) {
    openCompartmentWindow(this.#ship(target), target.dataset.instanceId);
  }
}

export function openBattlePanel() {
  if (!game.user.isGM) return ui.notifications.warn(localize("notify.gmOnly"));
  const panel = foundry.applications.instances.get(`${MODULE_ID}-battle-panel`) ?? new BattlePanel();
  return panel.render({ force: true });
}

export function registerBattlePanel() {
  Hooks.on("canvasReady", () => {
    if (!game.user.isGM) return;
    const panel = foundry.applications.instances.get(`${MODULE_ID}-battle-panel`);
    if (battleScene()) openBattlePanel();
    else panel?.close();
  });
  const rerender = () => foundry.applications.instances.get(`${MODULE_ID}-battle-panel`)?.render();
  Hooks.on("updateActor", (actor) => {
    const scene = battleScene();
    if (scene && sceneSides(scene).some((entry) => entry.ship === actor)) rerender();
  });
  Hooks.on("updateScene", (scene, changed) => {
    if (scene === battleScene() && foundry.utils.hasProperty(changed, `flags.${MODULE_ID}`)) rerender();
  });
}
