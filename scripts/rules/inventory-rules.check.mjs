// Самопроверка правил инвентаря: node scripts/rules/inventory-rules.check.mjs
import assert from "node:assert/strict";
import {
  itemSize, footprint, canPlace, findSlot, stackKey, findStack, fitsGrid, ammoCount, takeAmmo, parseQuantity
} from "./inventory-rules.js";

let counter = 0;
function entry({ x = 1, y = 1, rotated = false, ...item } = {}) {
  counter++;
  return { instanceId: `e${counter}`, x, y, rotated, item: { name: `Item ${counter}`, type: "loot", system: { quantity: 1 }, ...item } };
}

// Размер: флаг предмета, иначе по типу dnd5e, иначе 1×1.
assert.deepEqual(itemSize({ type: "weapon" }), { width: 1, height: 3 });
assert.deepEqual(itemSize({ type: "weapon", flags: { "skyplane-combat-reverse": { size: { width: 2, height: 2 } } } }), { width: 2, height: 2 });
assert.deepEqual(itemSize({ type: "spell" }), { width: 1, height: 1 });
assert.deepEqual(footprint(entry({ type: "weapon", rotated: true })), { width: 3, height: 1 });

// Размещение: за краем, поверх другого, на своём месте.
const sword = entry({ type: "weapon" });
assert.deepEqual(canPlace([], { ...sword, y: 2 }, 3, 3), { ok: false, reason: "outside" });
const potion = entry({ type: "consumable" });
assert.deepEqual(canPlace([sword], { ...potion, x: 1, y: 2 }, 3, 3), { ok: false, reason: "occupied" });
assert.equal(canPlace([sword], sword, 3, 3).ok, true);

// Свободное место: полная сетка, поворот, точка под курсором.
const full = [entry({ x: 1, y: 1 }), entry({ x: 2, y: 1 }), entry({ x: 1, y: 2 }), entry({ x: 2, y: 2 })];
assert.equal(findSlot(full, { type: "loot" }, 2, 2), null);
assert.deepEqual(findSlot([], { type: "weapon" }, 3, 1), { x: 1, y: 1, rotated: true });
assert.deepEqual(findSlot([], { type: "loot" }, 3, 3, { x: 2, y: 1 }), { x: 2, y: 1, rotated: false });
assert.deepEqual(findSlot([entry({ x: 2, y: 1 })], { type: "loot" }, 3, 3, { x: 2, y: 1 }), { x: 1, y: 1, rotated: false });

// Стопки: по источнику; имя — только без источника.
const source = (uuid, name) => ({ name, type: "consumable", _stats: { compendiumSource: uuid } });
assert.equal(stackKey(source("Compendium.a.b.Item.x", "Зелье")), stackKey(source("Compendium.a.b.Item.x", "Зелье")));
// Переименованный предмет того же источника («Клык» из длинного меча) — отдельная стопка.
assert.notEqual(stackKey(source("Compendium.a.b.Item.x", "Длинный меч")), stackKey(source("Compendium.a.b.Item.x", "Клык")));
assert.notEqual(stackKey(source("Compendium.a.b.Item.x", "Меч")), stackKey(source("Compendium.a.b.Item.y", "Меч")));
assert.equal(stackKey({ name: "Верёвка", type: "loot" }), stackKey({ name: "Верёвка", type: "loot" }));
assert.notEqual(stackKey({ name: "Верёвка", type: "loot" }), stackKey({ name: "Верёвка", type: "tool" }));
const rope = entry({ name: "Верёвка" });
assert.equal(findStack([rope], { name: "Верёвка", type: "loot" }), rope);
assert.equal(findStack([rope], { name: "Верёвка", type: "loot", _stats: { compendiumSource: "Compendium.x" } }), null);

// Сетка вмещает всё содержимое — для «Обновить на кораблях» при уменьшении сетки.
assert.equal(fitsGrid([entry({ flags: { "skyplane-combat-reverse": { size: { width: 3, height: 3 } } } })], 2, 2), false);
assert.equal(fitsGrid([entry({}), entry({ x: 2 })], 2, 1), true);

// Снаряды: подходят предметы из того же источника; списание не трогает исходный массив.
const ammo = { uuid: "Compendium.skyplane-combat-reverse.cargo.Item.torpedo", source: "" };
const torpedo = (quantity, x) => entry({ x, name: "Торпеда", system: { quantity }, _stats: { compendiumSource: ammo.uuid } });
const stock = [torpedo(3, 1), torpedo(2, 2), entry({ x: 3, name: "Торпеда", system: { quantity: 7 } })];
assert.equal(ammoCount(stock, ammo), 5);
const partial = takeAmmo(stock, ammo, 4);
assert.equal(partial.taken, 4);
assert.deepEqual(partial.entries.filter((item) => item.item.name === "Торпеда" && item.item._stats).map((item) => item.item.system.quantity), [1]);
const all = takeAmmo(stock, ammo, 9);
assert.equal(all.taken, 5);
assert.equal(all.entries.length, 1);
assert.equal(stock[0].item.system.quantity, 3);
// Источник поля «Снаряды» тоже подходит (предмет мира, импортированный из компендиума).
assert.equal(ammoCount([torpedo(2, 1)], { uuid: "Item.world", source: ammo.uuid }), 2);

// Количество из запроса: целое от 1 до имеющегося; 0, отрицательное и мусор — отказ (null).
assert.equal(parseQuantity(3, 5), 3);
assert.equal(parseQuantity("2", 5), 2);
assert.equal(parseQuantity(9, 5), 5);
assert.equal(parseQuantity(2.6, 5), 3);
assert.equal(parseQuantity(0, 5), null);
assert.equal(parseQuantity(-1, 5), null);
assert.equal(parseQuantity("abc", 5), null);
assert.equal(parseQuantity(undefined, 5), null);
assert.equal(parseQuantity(1, 0), null);

// Точка под курсором из запроса: не целые числа — как будто точки нет; запись с мусорными координатами не ставится.
assert.deepEqual(findSlot([], { type: "loot" }, 3, 3, { x: "a", y: {} }), { x: 1, y: 1, rotated: false });
assert.deepEqual(findSlot([], { type: "loot" }, 3, 3, { x: "2", y: 1 }), { x: 1, y: 1, rotated: false });
assert.equal(canPlace([], { instanceId: "z", item: { type: "loot" }, x: "a", y: 1 }, 3, 3).ok, false);

console.log("inventory-rules: все проверки пройдены");
