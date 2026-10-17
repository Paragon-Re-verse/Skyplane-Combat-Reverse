import { MODULE_ID, TEMPLATE_PATH, localize, format, describeChanges } from "../constants.js";
import { isDestroyed, isDamaged, parseHpInput, isWeapon, isFunctioning, weaponRanges, shotCount } from "../rules/ship-rules.js";
import { getShip, getCompartment, canUser, setCompartmentHp, setCompartmentFlags } from "../documents/ship-actions.js";
import { getLayout, sceneSides } from "../scene/scene-builder.js";
import { isSideRevealed } from "../scene/reveal.js";
import { openRepairDialog } from "./repair-dialog.js";
import {
  startShot, startScouting, currentBattle, currentDifficulty, checkSkillLabel, hasFiredThisRound, chargeState, shipWeaponFormula, scoutDifficulty
} from "../combat/ship-combat.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** На нераскрытом корабле противника окно отсека не открывается. */
function isHiddenFromUser(ship) {
  const scene = canvas.ready ? canvas.scene : null;
  if (getLayout(scene)?.mode !== "battle") return false;
  const entry = sceneSides(scene).find((sideEntry) => sideEntry.ship === ship);
  return !!entry && !isSideRevealed(scene, entry.side);
}

export function openCompartmentWindow(shipOrUuid, instanceId) {
  const ship = getShip(shipOrUuid);
  if (!ship || !getCompartment(ship, instanceId) || isHiddenFromUser(ship)) return null;
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
      scout: CompartmentWindow.#onScout
    }
  };

  static PARTS = {
    body: { template: `${TEMPLATE_PATH}/compartment-window.hbs` }
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
      isGM: game.user.isGM,
      combat: this.#combatContext(compartment)
    };
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
      disadvantage: !!difficulty.disadvantage,
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
