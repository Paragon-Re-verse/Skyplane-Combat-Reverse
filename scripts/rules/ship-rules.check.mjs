// Самопроверка правил: node scripts/rules/ship-rules.check.mjs
import assert from "node:assert/strict";
import {
  checkPlacement, findFreePosition, computeStats, validateShip, findPassages,
  buildWallSegments, parseHpInput, groupSystems, planStarterKit, isDifficultTerrain,
  isWeapon, weaponFormula, attackDifficulty, shipBonuses, adjacentCompartments, shotCount, ammoLeft, isSmoky,
  resolveHit, resolveUndoHit
} from "./ship-rules.js";

let counter = 0;
function room(overrides) {
  counter++;
  return {
    instanceId: `r${counter}`, name: `R${counter}`, x: 1, y: 1, width: 1, height: 1,
    systemCategory: "equipment", currentHp: 10, maxHp: 10, ...overrides
  };
}

// 10 отсеков без «Без прочности» = 400 HP; «Без прочности» не считается.
const ten = Array.from({ length: 10 }, (_, index) => room({ x: index + 1 }));
assert.equal(computeStats(ten).maxHp, 400);
assert.equal(computeStats([...ten, room({ x: 11, isNoHp: true })]).maxHp, 400);
assert.equal(computeStats([]).maxHp, 0);

// Скорость — максимум, экономия — минимум среди целых машинных; разрушенный не считается.
const engines = [
  room({ systemCategory: "engine", speed: 3, fuelEconomy: 2 }),
  room({ x: 2, systemCategory: "engine", speed: 5, fuelEconomy: 1 }),
  room({ x: 3, systemCategory: "engine", speed: 9, fuelEconomy: 0, currentHp: 0 })
];
assert.deepEqual(
  { speed: computeStats(engines).speed, fuelEconomy: computeStats(engines).fuelEconomy },
  { speed: 5, fuelEconomy: 1 }
);

// Вместимость — целые «Жилые» + модификатор эффекта.
const cabins = [
  room({ isResidential: true }),
  room({ x: 2, isResidential: true, currentHp: 0 }),
  room({ x: 3, effectStat: "maxCrew", effectValue: 2, effectActive: true })
];
assert.equal(computeStats(cabins).maxCrew, 3);

// Размещение: граница, пересечение, «Только снаружи».
const base = [room({ x: 2, y: 2, width: 2, height: 1 })];
assert.equal(checkPlacement(room({ x: 4, y: 1, width: 2 }), base, 4, 3).ok, false);
assert.equal(checkPlacement(room({ x: 3, y: 2 }), base, 4, 3).reason.key, "rules.overlap");
assert.equal(checkPlacement(room({ x: 4, y: 2 }), base, 4, 3).ok, true);
const outside = room({ x: 2, y: 2, isOutsideOnly: true });
const ring = [
  room({ x: 1, y: 1, width: 3 }), room({ x: 1, y: 2 }), room({ x: 3, y: 2 })
];
assert.equal(checkPlacement(room({ x: 1, y: 3, width: 3 }), [...ring, outside], 5, 5).reason.key, "rules.outsideOnly");
assert.equal(checkPlacement(outside, ring, 5, 5).ok, true);
assert.deepEqual(findFreePosition({ width: 2, height: 1 }, base, 4, 3), { x: 1, y: 1 });

// Обязательные категории.
const keys = (result) => result.errors.map((error) => error.key);
assert.deepEqual(keys(validateShip({ compartments: [], gridWidth: 11, gridHeight: 6 })), ["rules.noControl", "rules.noEngine"]);
const control = room({ systemCategory: "control", x: 1, y: 2 });
const engine = room({ systemCategory: "engine", x: 2, y: 2 });
assert.deepEqual(keys(validateShip({ compartments: [control, engine], gridWidth: 11, gridHeight: 6 })), []);

// Проходы: нижние ряды на одной высоте соединены, верхний этаж без лестницы — нет.
const tall = room({ x: 1, y: 1, height: 2, systemCategory: "control" });
const low = room({ x: 2, y: 2, systemCategory: "engine" });
const high = room({ x: 2, y: 1 });
assert.equal(findPassages([tall, low]).length, 1);
assert.equal(findPassages([tall, high]).length, 0);
const warnings = (result) => result.warnings.map((warning) => warning.key);
assert.ok(warnings(validateShip({ compartments: [tall, low, high], gridWidth: 4, gridHeight: 3 })).includes("rules.disconnected"));

// Лестница соединяется только с лестницей; галочка ГМа открывает проход.
const stairsTop = room({ x: 3, y: 1, isStairs: true });
const stairsBottom = room({ x: 3, y: 2, isStairs: true });
const plainBottom = room({ x: 3, y: 2 });
assert.equal(findPassages([stairsTop, stairsBottom]).length, 1);
assert.equal(findPassages([stairsTop, plainBottom]).length, 0);
assert.equal(findPassages([stairsTop, { ...plainBottom, passageUp: true }]).length, 1);
assert.equal(findPassages([{ ...high, passageDown: true }, low]).length, 1);

// Стены: два соседних 1×1 на одном ряду — проём в общей грани, контур склеен в 4 отрезка.
const pair = [room({ x: 1, y: 1 }), room({ x: 2, y: 1 })];
const walls = buildWallSegments(pair);
assert.equal(walls.length, 4);
assert.ok(walls.some((wall) => wall.y1 === 0 && wall.y2 === 0 && wall.x1 === 0 && wall.x2 === 2));
assert.ok(!walls.some((wall) => wall.x1 === 1 && wall.x2 === 1));
// Высокий отсек рядом с низким: проём только на нижний квадрат.
const tallWalls = buildWallSegments([tall, low]);
assert.ok(tallWalls.some((wall) => wall.x1 === 1 && wall.x2 === 1 && wall.y1 === 0 && wall.y2 === 1));
assert.ok(!tallWalls.some((wall) => wall.x1 === 1 && wall.x2 === 1 && wall.y2 === 2));

// Ввод HP.
assert.equal(parseHpInput("−5", 10), 5);
assert.equal(parseHpInput("+3", 10), 13);
assert.equal(parseHpInput("7", 10), 7);
assert.equal(parseHpInput("abc", 10), null);

// Таблицы систем группируют одинаковые.
const stairsList = Array.from({ length: 5 }, (_, index) => room({ name: "Лестница", x: index + 1, isNoHp: true }));
assert.equal(groupSystems(stairsList, ["equipment"]).equipment[0].count, 5);

// Стартовый набор и труднопроходимость.
const kit = planStarterKit(
  { stairs: { name: "Л", width: 1, height: 1 }, cargo: { name: "Т", width: 3, height: 1 }, cabin: { name: "К", width: 2, height: 1 } },
  3, [], 11, 6
);
assert.equal(kit.placed.length, 10);
assert.equal(isDifficultTerrain(room({ currentHp: 5 })), true);
assert.equal(isDifficultTerrain(room({ isNarrow: true })), true);
assert.equal(isDifficultTerrain(room({})), false);

// Пушки: формула урона и сложность по дистанции.
const cannon = room({ damageDice: 2, damageDie: 8, damageBonus: 1, checkDc: 12, range: "far" });
assert.equal(isWeapon(cannon), true);
assert.equal(isWeapon(room({})), false);
assert.equal(weaponFormula(cannon), "2d8+1");
assert.equal(weaponFormula({ ...cannon, damageBonus: -2 }), "2d8-2");
const difficulty = (gun, distance, modifier) => {
  const { dc, penalized, disadvantage } = attackDifficulty(gun, distance, 5, modifier);
  return { dc, penalized, disadvantage };
};
// Старый класс дальности «far» = средняя и дальняя без штрафа.
assert.deepEqual(difficulty(cannon, "medium"), { dc: 12, penalized: false, disadvantage: false });
assert.deepEqual(difficulty(cannon, "close"), { dc: 17, penalized: true, disadvantage: false });
assert.deepEqual(difficulty(cannon, "far"), { dc: 12, penalized: false, disadvantage: false });
assert.deepEqual(difficulty({ ...cannon, range: "close" }, "far"), { dc: 17, penalized: true, disadvantage: false });
assert.deepEqual(difficulty({ ...cannon, range: "medium" }, "melee"), { dc: 12, penalized: false, disadvantage: true });
// Набор дистанций: только дальняя — штраф и на средней; модификатор эффектов складывается.
assert.deepEqual(difficulty({ ...cannon, ranges: ["far"] }, "medium"), { dc: 17, penalized: true, disadvantage: false });
assert.deepEqual(difficulty({ ...cannon, ranges: ["close", "far"] }, "close", -2), { dc: 10, penalized: false, disadvantage: false });
assert.equal(groupSystems([{ ...cannon, systemCategory: "weapons" }], ["weapons"]).weapons[0].firepower, "2d8+1");
assert.equal(weaponFormula(cannon, 2), "2d8+3");
// Залп: выстрелов столько, сколько костей, у каждого одна кость.
const volley = { ...cannon, special: "volley", damageDice: 3 };
assert.equal(shotCount(volley), 3);
assert.equal(shotCount(cannon), 1);
assert.equal(weaponFormula(volley, 0, { perShot: true }), "1d8+1");

// Активные эффекты отсеков: действуют, пока отсек цел и эффект включён.
const shield = (overrides) => room({
  x: 4,
  effects: [{ name: "Щиты", disabled: false, changes: [{ key: "system.maxHp", mode: 2, value: "200" }, { key: "system.bonuses.defense", mode: 2, value: "2" }] }],
  ...overrides
});
const hull = [room({}), room({ x: 2 }), room({ x: 3 })];
assert.equal(computeStats([...hull, shield({})]).maxHp, 400);
assert.equal(computeStats([...hull, shield({ currentHp: 0 })]).maxHp, 200);
assert.equal(computeStats([...hull, shield({ effectActive: false })]).maxHp, 200);
assert.equal(shipBonuses([shield({})]).defense, 2);
assert.equal(shipBonuses([shield({ currentHp: 0 })]).defense, 0);
assert.equal(shipBonuses([room({ effects: [{ disabled: true, changes: [{ key: "system.bonuses.damage", mode: 2, value: "1" }] }] })]).damage, 0);
const upgrade = room({ x: 5, effects: [{ changes: [{ key: "system.speed", mode: 4, value: "6" }] }] });
assert.equal(computeStats([...engines, upgrade]).speed, 6);

// Боезапас: 0 — без ограничения; null — полный; не больше максимума.
assert.equal(ammoLeft(room({ ammo: 0 })), Infinity);
assert.equal(ammoLeft(room({ ammo: 4, currentAmmo: null })), 4);
assert.equal(ammoLeft(room({ ammo: 4, currentAmmo: 1 })), 1);
assert.equal(ammoLeft(room({ ammo: 2, currentAmmo: 5 })), 2);

// Состояния: пробоина — труднопроходимо и −1 к скорости; огонь и дым — помеха.
assert.equal(isDifficultTerrain(room({ conditions: ["breach"] })), true);
assert.equal(computeStats([...engines, room({ x: 6, conditions: ["breach"] })]).speed, 4);
assert.equal(isSmoky(room({ conditions: ["smoke"] })), true);
assert.equal(isSmoky(room({ conditions: ["breach"] })), false);

// Соседи по стороне — для брызг огнемёта.
const middle = room({ x: 2, y: 2 });
const around = [room({ x: 1, y: 2 }), room({ x: 3, y: 2 }), room({ x: 2, y: 1 }), room({ x: 3, y: 3 })];
assert.equal(adjacentCompartments([middle, ...around], middle).length, 3);

// Попадание: урон в прочность и в отсек, исходные данные не меняются, отмена возвращает ровно снятое.
{
  const ship = [room({}), room({ x: 2 }), room({ x: 3 }), room({ x: 4 })];
  const hit = resolveHit({ compartments: ship, hull: 200 }, ship[0].instanceId, 4);
  assert.equal(hit.compartments[0].currentHp, 6);
  assert.equal(ship[0].currentHp, 10);
  assert.equal(hit.hull, 196);
  assert.deepEqual(hit.lost, { hull: 4, compartment: 4, splash: [], conditions: [] });
  assert.equal(hit.stats, null);
  const undo = resolveUndoHit({ compartments: hit.compartments, hull: hit.hull, maxHull: 200 }, ship[0].instanceId, hit.lost);
  assert.equal(undo.compartments[0].currentHp, 10);
  assert.equal(undo.hull, 200);

  // Отсек не уходит ниже 0; разрушенный отсек не получает пробоину; разрушение — пересчёт характеристик.
  const kill = resolveHit({ compartments: ship, hull: 200 }, ship[1].instanceId, 15, { conditions: ["breach"] });
  assert.equal(kill.compartments[1].currentHp, 0);
  assert.equal(kill.lost.compartment, 10);
  assert.equal(kill.lost.hull, 15);
  assert.deepEqual(kill.lost.conditions, []);
  assert.ok(kill.stats);

  // «Без прочности» — урон только в прочность корабля.
  const noHp = room({ x: 5, isNoHp: true });
  const glancing = resolveHit({ compartments: [...ship, noHp], hull: 200 }, noHp.instanceId, 30);
  assert.equal(glancing.lost.compartment, 0);
  assert.equal(glancing.hull, 170);
}

// Щиты: разрушение снимает 200 максимума, прочность ложится на новый потолок; отмена возвращает и то и другое.
{
  const ship = [...hull, shield({})];
  const hit = resolveHit({ compartments: ship, hull: 400 }, ship[3].instanceId, 15);
  assert.equal(hit.stats.maxHp, 200);
  assert.equal(hit.hull, 200);
  assert.equal(hit.lost.hull, 200);
  const undo = resolveUndoHit({ compartments: hit.compartments, hull: hit.hull, maxHull: 200 }, ship[3].instanceId, hit.lost);
  assert.equal(undo.stats.maxHp, 400);
  assert.equal(undo.hull, 400);
}

// Брызги огнемёта: соседям половина урона, только в HP; разрушенный сосед не задевается; отмена возвращает брызги.
{
  const center = room({ x: 2, y: 2 });
  const left = room({ x: 1, y: 2 });
  const weak = room({ x: 3, y: 2, currentHp: 2 });
  const wreck = room({ x: 2, y: 1, currentHp: 0 });
  const ship = [center, left, weak, wreck];
  const hit = resolveHit({ compartments: ship, hull: 200 }, center.instanceId, 7, { splash: true, conditions: ["burning"] });
  assert.deepEqual(hit.lost.splash, [{ instanceId: left.instanceId, amount: 3 }, { instanceId: weak.instanceId, amount: 2 }]);
  assert.equal(hit.lost.hull, 7);
  assert.deepEqual(hit.lost.conditions, ["burning"]);
  assert.deepEqual(hit.compartments[0].conditions, ["burning"]);
  const undo = resolveUndoHit({ compartments: hit.compartments, hull: hit.hull, maxHull: 200 }, center.instanceId, hit.lost);
  assert.deepEqual(undo.compartments.map((compartment) => compartment.currentHp), [10, 10, 2, 0]);
  assert.deepEqual(undo.compartments[0].conditions, []);
}

// Состояние, что уже было до попадания, не добавляется повторно и не снимается отменой; пробоина — пересчёт скорости.
{
  const burning = room({ conditions: ["burning"] });
  const hit = resolveHit({ compartments: [burning], hull: 100 }, burning.instanceId, 1, { conditions: ["burning", "breach"] });
  assert.deepEqual(hit.lost.conditions, ["breach"]);
  assert.ok(hit.stats);
  const undo = resolveUndoHit({ compartments: hit.compartments, hull: hit.hull, maxHull: 100 }, burning.instanceId, hit.lost);
  assert.deepEqual(undo.compartments[0].conditions, ["burning"]);
}

console.log("ship-rules: все проверки пройдены");
