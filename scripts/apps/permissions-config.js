import { MODULE_ID, TEMPLATE_PATH, PERMISSION_RIGHTS, localize } from "../constants.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Матрица «игрок × право». Право действует только на кораблях, где есть персонаж игрока. */
export class PermissionsConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-permissions`,
    tag: "form",
    classes: ["skyplane-combat-reverse", "skyplane-permissions"],
    window: { title: `${MODULE_ID}.settings.permissions.name`, icon: "fa-solid fa-user-lock" },
    position: { width: 640, height: "auto" },
    form: { handler: PermissionsConfig.#onSubmit, closeOnSubmit: true }
  };

  static PARTS = {
    body: { template: `${TEMPLATE_PATH}/permissions-config.hbs` }
  };

  async _prepareContext() {
    const stored = game.settings.get(MODULE_ID, "permissions") ?? {};
    return {
      rights: PERMISSION_RIGHTS.map((right) => ({ id: right, label: localize(`rights.${right}.label`), hint: localize(`rights.${right}.hint`) })),
      users: game.users.filter((user) => !user.isGM).map((user) => ({
        id: user.id,
        name: user.name,
        character: user.character?.name ?? "—",
        rights: PERMISSION_RIGHTS.map((right) => ({ id: right, checked: !!stored[user.id]?.[right] }))
      }))
    };
  }

  static async #onSubmit(event, form, formData) {
    const permissions = {};
    for (const [key, value] of Object.entries(formData.object)) {
      const [userId, right] = key.split(".");
      if (!PERMISSION_RIGHTS.includes(right)) continue;
      permissions[userId] ??= {};
      permissions[userId][right] = !!value;
    }
    await game.settings.set(MODULE_ID, "permissions", permissions);
  }
}
