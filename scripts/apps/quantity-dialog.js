import { localize } from "../constants.js";

/** «Сколько?» с ползунком (по умолчанию — всё); стопка из одного предмета — без окошка. Отмена — null. */
export async function askQuantity(name, max, value = max) {
  if (max <= 1) return 1;
  const escape = foundry.utils.escapeHTML;
  return foundry.applications.api.DialogV2.prompt({
    window: { title: localize("inventory.quantityTitle"), icon: "fa-solid fa-boxes-stacked" },
    content: `<p>${escape(name)}</p>
      <div class="skyplane-quantity">
        <input type="range" name="quantity" min="1" max="${max}" step="1" value="${value}" autofocus>
        <output>${value}</output>
      </div>`,
    ok: { label: localize("inventory.quantityOk"), callback: (event, button) => Number(button.form.elements.quantity.value) },
    render: (event, dialog) => {
      const range = dialog.element.querySelector('input[name="quantity"]');
      range.addEventListener("input", () => { range.nextElementSibling.value = range.value; });
    },
    rejectClose: false
  });
}
