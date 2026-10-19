/**
 * Правила инвентаря отсеков без зависимостей от Foundry.
 * Запись инвентаря: { instanceId, item (данные предмета, как toObject()), x, y, rotated }; координаты клеток — от 1.
 * Предметы — данные dnd5e: тип (consumable, weapon…), system.quantity, _stats с источником.
 */

const FLAG_SCOPE = "skyplane-combat-reverse";

export const INVENTORY_LIMIT = 12;

/** Размер в клетках по типу предмета dnd5e (ширина × высота). */
export const DEFAULT_ITEM_SIZES = Object.freeze({
  consumable: { width: 1, height: 1 },
  loot: { width: 1, height: 1 },
  equipment: { width: 1, height: 2 },
  tool: { width: 1, height: 2 },
  weapon: { width: 1, height: 3 },
  container: { width: 2, height: 2 }
});

/** Размер предмета: свой (флаг модуля), иначе по типу, иначе 1×1. */
export function itemSize(item) {
  const own = item?.flags?.[FLAG_SCOPE]?.size;
  if (own?.width > 0 && own?.height > 0) return { width: own.width, height: own.height };
  return { ...(DEFAULT_ITEM_SIZES[item?.type] ?? { width: 1, height: 1 }) };
}

/** Занимаемый прямоугольник записи: поворот меняет ширину и высоту местами. */
export function footprint(entry) {
  const { width, height } = itemSize(entry.item);
  return entry.rotated ? { width: height, height: width } : { width, height };
}

function overlaps(first, second) {
  const a = footprint(first);
  const b = footprint(second);
  return first.x < second.x + b.width && second.x < first.x + a.width && first.y < second.y + b.height && second.y < first.y + a.height;
}

/** Можно ли поставить запись: внутри сетки и без наложений (запись не мешает сама себе). */
export function canPlace(entries, candidate, gridWidth, gridHeight) {
  const { width, height } = footprint(candidate);
  if (!Number.isInteger(candidate.x) || !Number.isInteger(candidate.y) || candidate.x < 1 || candidate.y < 1 || candidate.x + width - 1 > gridWidth || candidate.y + height - 1 > gridHeight) {
    return { ok: false, reason: "outside" };
  }
  const blocked = entries.some((other) => other.instanceId !== candidate.instanceId && overlaps(candidate, other));
  return blocked ? { ok: false, reason: "occupied" } : { ok: true };
}

/**
 * Место для предмета: сначала точка под курсором (без поворота, затем с поворотом),
 * затем первый свободный слот сверху-слева (без поворота, затем с поворотом). Нет места — null.
 */
export function findSlot(entries, item, gridWidth, gridHeight, { x, y } = {}) {
  const fits = (slotX, slotY, rotated) => canPlace(entries, { instanceId: null, item, x: slotX, y: slotY, rotated }, gridWidth, gridHeight).ok;
  if (Number.isInteger(x) && Number.isInteger(y)) {
    for (const rotated of [false, true]) if (fits(x, y, rotated)) return { x, y, rotated };
  }
  for (const rotated of [false, true]) {
    for (let slotY = 1; slotY <= gridHeight; slotY++) {
      for (let slotX = 1; slotX <= gridWidth; slotX++) if (fits(slotX, slotY, rotated)) return { x: slotX, y: slotY, rotated };
    }
  }
  return null;
}

/** Источники предмета: компендиум, дубликат предмета мира, исходный предмет при переносе модулем. */
export function sourceIds(item) {
  return [item?._stats?.compendiumSource, item?._stats?.duplicateSource, item?.flags?.[FLAG_SCOPE]?.origin].filter(Boolean);
}

/** Ключ стопки: тип, источник и название — переименованный предмет того же источника лежит отдельно. */
export function stackKey(item) {
  const [source] = sourceIds(item);
  return `${item.type}|${source ?? ""}|${item.name}`;
}

export function findStack(entries, item) {
  const key = stackKey(item);
  return entries.find((entry) => stackKey(entry.item) === key) ?? null;
}

/** Вмещает ли сетка всё содержимое: каждая запись внутри и ни одна не накладывается на другую. */
export function fitsGrid(entries, gridWidth, gridHeight) {
  return entries.every((entry) => canPlace(entries, entry, gridWidth, gridHeight).ok);
}

/** Подходит ли предмет пушке: тот же источник, что у предмета в поле «Снаряды» ({ uuid, source }). */
export function isAmmoFor(item, ammo) {
  const wanted = [ammo?.uuid, ammo?.source].filter(Boolean);
  return wanted.length > 0 && sourceIds(item).some((id) => wanted.includes(id));
}

export function ammoCount(entries, ammo) {
  return entries.filter((entry) => isAmmoFor(entry.item, ammo)).reduce((sum, entry) => sum + (entry.item.system?.quantity ?? 1), 0);
}

/** Списывает до count снарядов из подходящих стопок; пустые стопки уходят. Исходные записи не меняются. */
export function takeAmmo(entries, ammo, count) {
  let taken = 0;
  const next = [];
  for (const entry of entries) {
    if (taken >= count || !isAmmoFor(entry.item, ammo)) {
      next.push(entry);
      continue;
    }
    const quantity = entry.item.system?.quantity ?? 1;
    const used = Math.min(quantity, count - taken);
    taken += used;
    if (used < quantity) next.push({ ...entry, item: { ...entry.item, system: { ...entry.item.system, quantity: quantity - used } } });
  }
  return { entries: next, taken };
}

/** Количество из запроса: целое от 1 до max; ноль, отрицательное и не число — null (отказ). */
export function parseQuantity(value, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number < 1 || max < 1) return null;
  return Math.min(number, max);
}
