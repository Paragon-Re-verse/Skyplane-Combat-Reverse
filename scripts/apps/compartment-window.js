import { MODULE_ID, TEMPLATE_PATH, CONDITIONS, localize, format, describeChanges } from "../constants.js";
import { isDestroyed, isDamaged, parseHpInput, isWeapon, isFunctioning, weaponRanges, shotCount, ammoLeft, hasCondition, shotsAvailable } from "../rules/ship-rules.js";
import { ammoCount } from "../rules/inventory-rules.js";
import { isPresent } from "../documents/inventory-actions.js";
import { openInventoryWindow } from "./inventory-window.js";
import { requestAction } from "../socket.js";
import {
  getShip, getCompartment, canUser, setCompartmentHp, setCompartmentFlags, setCompartmentConditions, setCompartmentAmmo, ownedCrewActors
} from "../documents/ship-actions.js";
import { getLayout, sceneSides } from "../scene/scene-builder.js";
import { isSideRevealed } from "../scene/reveal.js";
import { openRepairDialog } from "./repair-dialog.js";
import {
  startShot, startScouting, startExtinguish, currentBattle, currentDifficulty, checkSkillLabel, hasFiredThisRound, chargeState, shipWeaponFormula, scoutDifficulty,
  tokenInCompartment
} from "../combat/ship-combat.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** На нераскрытом корабле противника окно отсека не открывается. */
function isHiddenFromUser(ship) {
  const scene = canvas.ready ? canvas.scene : null;
  if (getLayout(scene)?.mode !== "battle") return false;
  const entry = sceneSides(scene).find((sideEntry) => sideEntry.ship === ship);
  return !!entry && !isSideRevealed(scene, entry.side);
}

/** Абордаж: токен пользователя стоит в этом отсеке — окно открывается и у нераскрытого противника. */
function isBoarding(ship, instanceId) {
  const scene = canvas.ready ? canvas.scene : null;
  return !!scene && !!tokenInCompartment(scene, ship, instanceId);
}

export function openCompartmentWindow(shipOrUuid, instanceId) {
  const ship = getShip(shipOrUuid);
  if (!ship || !getCompartment(ship, instanceId) || (isHiddenFromUser(ship) && !isBoarding(ship, instanceId))) return null;
  const id = `${MODULE_ID}-compartment-${ship.id}-${instanceId}`;
  const existing = foundry.applications.instances.get(id);
  if (existing) return existing.render({ force: true });
  return new CompartmentWindow({ id, ship, instanceId }).render({ force: true });
}

export class CompartmentWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options) {
    super(options);
    this.ship = options.ship;
    this.instanceId = options.instanceId;
  }

  static DEFAULT_OPTIONS = {
    classes: ["skyplane-combat-reverse", "skyplane-compartment-window"],
    position: { width: 460, height: "auto" },
    window: { icon: "fa-solid fa-cube", resizable: true },
    actions: {
      repair: CompartmentWindow.#onRepair,
      applyHp: CompartmentWindow.#onApplyHp,
      fire: CompartmentWindow.#onFire,
      scout: CompartmentWindow.#onScout,
      extinguish: CompartmentWindow.#onExtinguish,
      reloadAmmo: CompartmentWindow.#onReloadAmmo,
      openInventory: CompartmentWindow.#onOpenInventory,
      reloadFromInventory: CompartmentWindow.#onReloadFromInventory
    }
  };

  static PARTS = {
    body: { template: `${TEMPLATE_PATH}/compartment-window.hbs`, scrollable: [""] }
  };

  get title() {
    return getCompartment(this.ship, this.instanceId)?.name ?? localize("compartment.title");
  }

  async _prepareContext() {
    const compartment = getCompartment(this.ship, this.instanceId);
    if (!compartment) return { missing: true };
    const percent = compartment.maxHp > 0 ? Math.round((compartment.currentHp / compartment.maxHp) * 100) : 0;
    return {
      compartment,
      categoryLabel: localize(`system.${compartment.systemCategory}`),
      sizeLabel: `${compartment.height}×${compartment.width}`,
      keywords: compartment.keywords.join(", "),
      hpPercent: percent,
      destroyed: isDestroyed(compartment),
      damaged: isDamaged(compartment),
      description: await foundry.applications.ux.TextEditor.implementation.enrichHTML(compartment.description ?? ""),
      canRepair: !compartment.isNoHp && canUser(game.user, this.ship, "repair"),
      effects: compartment.effects.map((effect) => ({ ...effect, summary: describeChanges(effect.changes) })),
      hasEffects: !!compartment.effectStat || compartment.effects.length > 0,
      conditions: CONDITIONS.map((id) => ({
        id, label: localize(`condition.${id}.label`), hint: localize(`condition.${id}.hint`), active: hasCondition(compartment, id)
      })),
      canExtinguish: hasCondition(compartment, "burning") && canUser(game.user, this.ship, "repair"),
      ammo: compartment.ammo ? { left: ammoLeft(compartment), max: compartment.ammo } : null,
      isGM: game.user.isGM,
      combat: this.#combatContext(compartment),
      inventory: this.#inventoryContext(compartment)
    };
  }

  /**
   * Кнопка «Инвентарь»: у своего корабля видна всегда и активна, пока токен в отсеке;
   * у чужого — только когда токен в отсеке (абордаж), чтобы не выдавать, где у противника инвентарь.
   */
  #inventoryContext(compartment) {
    if (!compartment.inventoryWidth) return null;
    const scene = canvas.ready ? canvas.scene : null;
    const present = isPresent(game.user, scene, this.ship, this.instanceId);
    const own = game.user.isGM || ownedCrewActors(game.user, this.ship).length > 0;
    if (!own && !present) return null;
    return { present, count: compartment.inventory.length };
  }

  /** Блок «Бой»: огневая мощь, дальность, сложность при текущей дистанции и кнопки действий. */
  #combatContext(compartment) {
    const weapon = isWeapon(compartment);
    const recon = compartment.systemCategory === "recon";
    if (!weapon && !recon) return null;
    const battle = currentBattle(this.ship);
    const allowed = !!battle && isFunctioning(compartment) && canUser(game.user, this.ship, "combat");
    const difficulty = weapon ? currentDifficulty(this.ship, compartment) : { dc: scoutDifficulty(this.ship, compartment) };
    const charge = compartment.special === "charge" && battle ? chargeState(this.ship, compartment.instanceId, battle.scene) : null;
    const count = shotCount(compartment);
    return {
      weapon,
      recon,
      formula: shipWeaponFormula(this.ship, compartment) + (count > 1 ? ` (${format("combat.volleyCount", { count })})` : ""),
      rangeLabel: weaponRanges(compartment).map((range) => localize(`range.${range}`)).join(", ") || "—",
      specialLabel: compartment.special ? localize(`special.${compartment.special}`) : "",
      specialHint: compartment.special ? localize(`specialHint.${compartment.special}`) : "",
      skillLabel: checkSkillLabel(compartment),
      dc: difficulty.dc,
      modifier: difficulty.modifier ? format("combat.effectModifier", { value: difficulty.modifier > 0 ? `+${difficulty.modifier}` : difficulty.modifier }) : "",
      penalized: !!difficulty.penalized,
      disadvantage: !!difficulty.disadvantage && !difficulty.smoky,
      smoky: !!difficulty.smoky,
      noAmmo: weapon && shotsAvailable(compartment) <= 0,
      ammoItem: weapon && compartment.ammoItem?.uuid ? {
        name: compartment.ammoItem.name,
        img: compartment.ammoItem.img,
        stock: ammoCount(compartment.inventory, compartment.ammoItem),
        canReload: !!compartment.ammo && ammoLeft(compartment) < compartment.ammo
          && isPresent(game.user, canvas.ready ? canvas.scene : null, this.ship, this.instanceId)
      } : null,
      canFire: weapon && allowed,
      fired: weapon && !!battle && hasFiredThisRound(this.ship, compartment.instanceId, battle.scene),
      needsCharge: compartment.special === "charge" && !charge,
      charging: charge === "charging",
      canScout: recon && allowed
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    for (const checkbox of this.element.querySelectorAll("input[data-flag]")) {
      checkbox.addEventListener("change", (event) => {
        setCompartmentFlags(this.ship, this.instanceId, { [event.currentTarget.dataset.flag]: event.currentTarget.checked });
      });
    }
    for (const checkbox of this.element.querySelectorAll("input[data-condition]")) {
      checkbox.addEventListener("change", (event) => {
        setCompartmentConditions(this.ship, this.instanceId, { [event.currentTarget.dataset.condition]: event.currentTarget.checked });
      });
    }
    this.element.querySelector("input[name=ammo]")?.addEventListener("change", (event) => {
      setCompartmentAmmo(this.ship, this.instanceId, event.currentTarget.value);
    });
    this.element.querySelector("input[name=hpDelta]")?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      CompartmentWindow.#onApplyHp.call(this);
    });
  }

  static #onFire() {
    startShot(this.ship, this.instanceId);
  }

  static #onScout() {
    startScouting(this.ship, this.instanceId);
  }

  static #onExtinguish() {
    startExtinguish(this.ship, this.instanceId);
  }

  static #onReloadAmmo() {
    setCompartmentAmmo(this.ship, this.instanceId);
  }

  static #onOpenInventory() {
    openInventoryWindow(this.ship, this.instanceId);
  }

  /** «Перезарядить»: магазин из снарядов в инвентаре отсека; перезаряжает тот, кто стоит в отсеке. */
  static #onReloadFromInventory() {
    requestAction("reloadFromInventory", this.ship, { instanceId: this.instanceId, sceneId: canvas.ready ? canvas.scene?.id : null });
  }

  static #onRepair() {
    openRepairDialog(this.ship, this.instanceId);
  }

  static async #onApplyHp() {
    const input = this.element.querySelector("input[name=hpDelta]");
    const compartment = getCompartment(this.ship, this.instanceId);
    const value = parseHpInput(input?.value, compartment.currentHp);
    if (value === null) return ui.notifications.warn(localize("notify.invalidNumber"));
    await setCompartmentHp(this.ship, this.instanceId, value);
  }
}
