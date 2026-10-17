import { MODULE_ID, HOOK_PREFIX, format, localize } from "./constants.js";

let socket = null;
let playerActionRunner = null;

/** Регистрация должна произойти до init socketlib, поэтому вызывается при загрузке модуля. */
export function registerSocket(runner) {
  playerActionRunner = runner;
  Hooks.once("socketlib.ready", () => {
    socket = socketlib.registerModule(MODULE_ID);
    socket.register("playerAction", handlePlayerAction);
    socket.register("hook", handleHook);
  });
}

async function handlePlayerAction(name, shipUuid, payload) {
  const user = game.users.get(this.socketdata.userId);
  if (!user) return { ok: false, reason: { key: "notify.denied" } };
  return playerActionRunner(name, shipUuid, payload, user);
}

/** Показ результата действия: причина отказа приходит ключом, локализуется на стороне игрока. */
export function notifyResult(result) {
  if (result?.ok || !result?.reason) return;
  ui.notifications.warn(format(result.reason.key, result.reason.data ?? {}));
}

/**
 * Именованное действие от игрока уходит клиенту ГМа; ГМ выполняет сразу.
 * Сырые данные актора от игрока не принимаются — только имя действия и его параметры.
 */
export async function requestAction(name, ship, payload = {}) {
  let result;
  if (game.user.isGM) {
    result = await playerActionRunner(name, ship.uuid, payload, game.user);
  } else if (!game.users.activeGM || !socket) {
    ui.notifications.warn(localize("notify.noGm"));
    return { ok: false };
  } else {
    result = await socket.executeAsGM("playerAction", name, ship.uuid, payload);
  }
  notifyResult(result);
  return result;
}

function serialize(value) {
  if (value instanceof foundry.abstract.Document) return { __uuid: value.uuid };
  if (Array.isArray(value)) return value.map(serialize);
  return value;
}

function deserialize(value) {
  if (Array.isArray(value)) return value.map(deserialize);
  if (value && typeof value === "object" && "__uuid" in value) return fromUuidSync(value.__uuid);
  return value;
}

function handleHook(name, args) {
  Hooks.callAll(`${HOOK_PREFIX}.${name}`, ...deserialize(args));
}

/** Хуки модуля вызываются на всех клиентах: ГМ рассылает их после записи. */
export function emitHook(name, ...args) {
  const serialized = args.map(serialize);
  if (socket) socket.executeForEveryone("hook", name, serialized);
  else handleHook(name, serialized);
}
