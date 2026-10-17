import { MODULE_ID, PERMISSION_RIGHTS } from "./constants.js";
import { PermissionsConfig } from "./apps/permissions-config.js";

export function registerSettings() {
  game.settings.register(MODULE_ID, "permissions", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.registerMenu(MODULE_ID, "permissionsMenu", {
    name: `${MODULE_ID}.settings.permissions.name`,
    label: `${MODULE_ID}.settings.permissions.label`,
    hint: `${MODULE_ID}.settings.permissions.hint`,
    icon: "fa-solid fa-user-lock",
    type: PermissionsConfig,
    restricted: true
  });

  game.settings.register(MODULE_ID, "animations", {
    name: `${MODULE_ID}.settings.animations.name`,
    hint: `${MODULE_ID}.settings.animations.hint`,
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: applyAnimationSetting
  });

  game.settings.register(MODULE_ID, "rangePenalty", {
    name: `${MODULE_ID}.settings.rangePenalty.name`,
    hint: `${MODULE_ID}.settings.rangePenalty.hint`,
    scope: "world",
    config: true,
    type: Number,
    default: 5
  });

  game.settings.register(MODULE_ID, "gmConfirmsDamage", {
    name: `${MODULE_ID}.settings.gmConfirmsDamage.name`,
    hint: `${MODULE_ID}.settings.gmConfirmsDamage.hint`,
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "dataVersion", {
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, "setupVersion", {
    scope: "world",
    config: false,
    type: String,
    default: ""
  });
}

export function applyAnimationSetting() {
  document.body.classList.toggle("skyplane-no-animations", !game.settings.get(MODULE_ID, "animations"));
}

/** Галочка матрицы прав: есть ли у игрока право вообще (без учёта корабля). */
export function userHasRight(user, right) {
  if (user.isGM) return true;
  if (!PERMISSION_RIGHTS.includes(right)) return false;
  return !!game.settings.get(MODULE_ID, "permissions")?.[user.id]?.[right];
}
