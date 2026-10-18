/**
 * Карточка попадания в чате. Режимы (галочка «Урон применяет ГМ» в настройках):
 * - урон применён сразу — у ГМа кнопка «Отменить»;
 * - урон ждёт ГМа — кнопки «Применить» и «Отклонить», после применения — «Отменить».
 * Отмена возвращает ровно то, что попадание сняло с прочности и с отсека.
 */
import { MODULE_ID, localize, format } from "../constants.js";
import { getShip, getCompartment, applyHit, undoHit, serialized } from "../documents/ship-actions.js";

const FLAG = "hit";
const BUTTONS = {
  pending: [["apply", "fa-check"], ["reject", "fa-xmark"]],
  applied: [["undo", "fa-rotate-left"]]
};

function cardContent(data) {
  const escape = foundry.utils.escapeHTML;
  const targetShip = getShip(data.targetUuid)?.name ?? "—";
  const buttons = (BUTTONS[data.status] ?? []).map(([action, icon]) =>
    `<button type="button" data-skyplane-hit="${action}"><i class="fa-solid ${icon}"></i> ${escape(localize(`card.${action}`))}</button>`).join("");
  return `<div class="skyplane-hit-card status-${data.status}">
    <h4><i class="fa-solid fa-burst"></i> ${escape(format("card.title", { amount: data.amount }))}</h4>
    <p>${escape(format("card.body", { shooter: data.shooter, weapon: data.weapon, target: data.targetName, ship: targetShip }))}</p>
    ${data.splash ? `<p class="skyplane-hint">${escape(format("card.splash", { amount: Math.floor(data.amount / 2) }))}</p>` : ""}
    ${data.conditions?.length ? `<p class="skyplane-hint">${escape(format("card.conditions", { list: data.conditions.map((condition) => localize(`condition.${condition}.label`)).join(", ") }))}</p>` : ""}
    <p class="skyplane-hit-status">${escape(localize(`card.status.${data.status}`))}</p>
    ${buttons ? `<div class="skyplane-hit-buttons">${buttons}</div>` : ""}
  </div>`;
}

export async function createHitCard(data) {
  await ChatMessage.create({
    content: cardContent(data),
    speaker: { alias: getShip(data.attackerUuid)?.name ?? "SkyPlane" },
    flags: { [MODULE_ID]: { [FLAG]: data } }
  });
}

/** Кнопки карточки — в общей очереди изменений: двойной клик не применит попадание дважды. */
function onCardButton(message, action) {
  return serialized(() => cardButton(message, action));
}

async function cardButton(message, action) {
  const data = foundry.utils.deepClone(message.getFlag(MODULE_ID, FLAG));
  const target = getShip(data.targetUuid);
  if (!target) return ui.notifications.warn(localize("notify.shipMissing"));
  const names = {
    attacker: getShip(data.attackerUuid)?.name ?? "—",
    weapon: data.weapon,
    target: getCompartment(target, data.instanceId)?.name ?? "—",
    amount: data.amount
  };
  if (action === "apply" && data.status === "pending") {
    data.lost = await applyHit(target, data.instanceId, data.amount, game.user, format("log.combat.taken", names), { splash: !!data.splash, conditions: data.conditions ?? [] });
    data.status = "applied";
  } else if (action === "reject" && data.status === "pending") {
    data.status = "rejected";
  } else if (action === "undo" && data.status === "applied") {
    await undoHit(target, data.instanceId, data.lost ?? { hull: data.amount, compartment: data.amount }, format("log.combat.undone", names));
    data.status = "undone";
  } else {
    return;
  }
  await message.update({ content: cardContent(data), [`flags.${MODULE_ID}.${FLAG}`]: data });
}

export function registerHitCards() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (!message.getFlag(MODULE_ID, FLAG)) return;
    if (!game.user.isGM) return html.querySelector(".skyplane-hit-buttons")?.remove();
    for (const button of html.querySelectorAll("[data-skyplane-hit]")) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        for (const other of html.querySelectorAll("[data-skyplane-hit]")) other.disabled = true;
        onCardButton(message, button.dataset.skyplaneHit);
      });
    }
  });
}
