import { MODULE_ID, localize, format } from "../constants.js";
import { getCompartment, ownedCrewActors } from "../documents/ship-actions.js";
import { requestAction } from "../socket.js";

/** Расходники с флагом repair у персонажей игрока из экипажа корабля (ГМ видит всех). */
function repairOptions(ship) {
  const actors = game.user.isGM
    ? ship.system.crew.map((member) => fromUuidSync(member.actorUuid)).filter(Boolean)
    : ownedCrewActors(game.user, ship);
  return actors.flatMap((actor) => actor.items
    .filter((item) => Number(item.getFlag(MODULE_ID, "repair")?.amount) > 0 && (item.system.quantity ?? 1) > 0)
    .map((item) => ({ actor, item, amount: Number(item.getFlag(MODULE_ID, "repair").amount), quantity: item.system.quantity ?? 1 })));
}

export async function openRepairDialog(ship, instanceId) {
  const compartment = getCompartment(ship, instanceId);
  if (!compartment) return;
  if (!game.users.activeGM) return ui.notifications.warn(localize("notify.noGm"));
  const options = repairOptions(ship);
  if (!options.length) return ui.notifications.warn(localize("repair.none"));

  const rows = options.map((option, index) => `
    <label class="skyplane-repair-option">
      <input type="radio" name="itemUuid" value="${option.item.uuid}" ${index === 0 ? "checked" : ""}>
      <img src="${foundry.utils.escapeHTML(option.item.img ?? "")}" alt="">
      <span class="name">${foundry.utils.escapeHTML(option.item.name)} <small>(${foundry.utils.escapeHTML(option.actor.name)})</small></span>
      <span class="quantity">×${option.quantity}</span>
      <span class="amount">+${option.amount} HP</span>
    </label>`).join("");

  const itemUuid = await foundry.applications.api.DialogV2.prompt({
    window: { title: format("repair.title", { name: compartment.name }), icon: "fa-solid fa-screwdriver-wrench" },
    classes: ["skyplane-combat-reverse", "skyplane-repair-dialog"],
    content: `<p>${format("repair.hint", { value: compartment.currentHp, max: compartment.maxHp })}</p><div class="skyplane-repair-list">${rows}</div>`,
    ok: {
      label: localize("repair.confirm"),
      icon: "fa-solid fa-wrench",
      callback: (event, button) => button.form.elements.itemUuid.value
    },
    rejectClose: false
  });
  if (!itemUuid) return;
  const result = await requestAction("repairCompartment", ship, { instanceId, itemUuid });
  if (result?.ok) ui.notifications.info(format("repair.done", { name: result.name ?? compartment.name, amount: result.amount }));
}
