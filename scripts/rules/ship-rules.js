/**
 * Правила неболёта без зависимостей от Foundry.
 * Координаты отсеков — в квадратах корабля, от 1. Координаты стен и проёмов —
 * в линиях сетки корабля, от 0: отсек {x, y, width, height} занимает
 * прямоугольник [x-1, x-1+width] × [y-1, y-1+height].
 * Тексты ошибок не формируются здесь: возвращаются ключи i18n и данные для format.
 */

export const GRID_LIMITS = Object.freeze({
  minWidth: 4,
  minHeight: 3,
  maxWidth: 14,
  maxHeight: 8,
  defaultWidth: 11,
  defaultHeight: 6
});

export function clampGridSize(width, height) {
  return {
    width: Math.max(GRID_LIMITS.minWidth, Math.min(GRID_LIMITS.maxWidth, Math.round(width))),
    height: Math.max(GRID_LIMITS.minHeight, Math.min(GRID_LIMITS.maxHeight, Math.round(height)))
  };
}

/* ---------------- Состояние отсека ---------------- */

export function isDestroyed(compartment) {
  return !compartment.isNoHp && compartment.currentHp <= 0;
}

export function isDamaged(compartment) {
  return !compartment.isNoHp && compartment.currentHp < compartment.maxHp;
}

export function isFunctioning(compartment) {
  return !isDestroyed(compartment) || !!compartment.worksWhenDestroyed;
}

/** Труднопроходимая местность: «Узкий», повреждённый отсек или пробоина. */
export function isDifficultTerrain(compartment) {
  return !!compartment.isNarrow || isDamaged(compartment) || hasCondition(compartment, "breach");
}

/* ---------------- Состояния и боезапас ---------------- */

export function hasCondition(compartment, condition) {
  return (compartment.conditions ?? []).includes(condition);
}

/** Огонь и дым: проверки в отсеке (обстрел, разведка, тушение) — с помехой. */
export function isSmoky(compartment) {
  return hasCondition(compartment, "burning") || hasCondition(compartment, "smoke");
}

/** Осталось выстрелов; Infinity — боезапас не ограничен. */
export function ammoLeft(compartment) {
  if (!compartment.ammo) return Infinity;
  return Math.min(compartment.ammo, compartment.currentAmmo ?? compartment.ammo);
}

/* ---------------- Геометрия ---------------- */

export function rectsOverlap(first, second) {
  return !(
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}

function bottomRow(compartment) {
  return compartment.y + compartment.height - 1;
}

function cellKey(x, y) {
  return `${x},${y}`;
}

function occupiedCells(compartments) {
  const occupied = new Set();
  for (const compartment of compartments) {
    for (let dx = 0; dx < compartment.width; dx++) {
      for (let dy = 0; dy < compartment.height; dy++) occupied.add(cellKey(compartment.x + dx, compartment.y + dy));
    }
  }
  return occupied;
}

function neighbourCells(compartment) {
  const cells = [];
  for (let dx = 0; dx < compartment.width; dx++) {
    cells.push([compartment.x + dx, compartment.y - 1], [compartment.x + dx, compartment.y + compartment.height]);
  }
  for (let dy = 0; dy < compartment.height; dy++) {
    cells.push([compartment.x - 1, compartment.y + dy], [compartment.x + compartment.width, compartment.y + dy]);
  }
  return cells;
}

/** Клетка за пределами карты считается свободной: там уже «снаружи». */
function hasFreeNeighbour(compartment, occupied) {
  return neighbourCells(compartment).some(([x, y]) => !occupied.has(cellKey(x, y)));
}

function touchesBySide(first, second) {
  const verticalOverlap = first.y < second.y + second.height && second.y < first.y + first.height;
  const horizontalOverlap = first.x < second.x + second.width && second.x < first.x + first.width;
  const sideBySide = first.x + first.width === second.x || second.x + second.width === first.x;
  const stacked = first.y + first.height === second.y || second.y + second.height === first.y;
  return (sideBySide && verticalOverlap) || (stacked && horizontalOverlap);
}

/** Отсеки, соприкасающиеся с этим по стороне. */
export function adjacentCompartments(compartments, target) {
  return compartments.filter((compartment) => compartment.instanceId !== target.instanceId && touchesBySide(compartment, target));
}

export function compartmentAtCell(compartments, x, y) {
  return compartments.find((compartment) =>
    x >= compartment.x && x < compartment.x + compartment.width &&
    y >= compartment.y && y < compartment.y + compartment.height
  ) ?? null;
}

/* ---------------- Размещение ---------------- */

/**
 * Можно ли поставить отсек: внутри карты, без пересечений, без поворота,
 * и ни один отсек «Только снаружи» не оказывается полностью закрыт.
 * @returns {{ok: boolean, reason?: {key: string, data: object}}}
 */
export function checkPlacement(candidate, compartments, gridWidth, gridHeight) {
  const others = compartments.filter((compartment) => compartment.instanceId !== candidate.instanceId || !candidate.instanceId);
  if (candidate.x < 1 || candidate.y < 1 || candidate.x + candidate.width - 1 > gridWidth || candidate.y + candidate.height - 1 > gridHeight) {
    return { ok: false, reason: { key: "rules.outOfBounds", data: { width: gridWidth, height: gridHeight } } };
  }
  const overlapping = others.find((other) => rectsOverlap(candidate, other));
  if (overlapping) return { ok: false, reason: { key: "rules.overlap", data: { name: overlapping.name } } };

  const all = [...others, candidate];
  const occupied = occupiedCells(all);
  const enclosed = all.find((compartment) => compartment.isOutsideOnly && !hasFreeNeighbour(compartment, occupied));
  if (enclosed) return { ok: false, reason: { key: "rules.outsideOnly", data: { name: enclosed.name } } };
  return { ok: true };
}

/** Первая свободная позиция построчно сверху вниз; null — места нет. */
export function findFreePosition(definition, compartments, gridWidth, gridHeight) {
  for (let y = 1; y <= gridHeight - definition.height + 1; y++) {
    for (let x = 1; x <= gridWidth - definition.width + 1; x++) {
      const candidate = { ...definition, instanceId: null, x, y };
      if (checkPlacement(candidate, compartments, gridWidth, gridHeight).ok) return { x, y };
    }
  }
  return null;
}

/** Стартовый набор: 6 лестниц, 1 трюм и по каюте на игрока в первые свободные клетки. */
export function planStarterKit({ stairs, cargo, cabin }, playerCount, compartments, gridWidth, gridHeight) {
  const placed = [];
  const skipped = [];
  const working = [...compartments];
  const plan = [...Array(6).fill(stairs), cargo, ...Array(Math.max(0, playerCount)).fill(cabin)];
  for (const definition of plan) {
    const position = findFreePosition(definition, working, gridWidth, gridHeight);
    if (!position) {
      skipped.push(definition.name);
      continue;
    }
    const compartment = { ...definition, instanceId: `kit${placed.length}`, ...position };
    working.push(compartment);
    placed.push({ definition, ...position });
  }
  return { placed, skipped };
}

/* ---------------- Характеристики ---------------- */

/** Эффекты отсека действуют, пока он работает и ГМ не выключил их галочкой. */
function effectsWork(compartment) {
  return compartment.effectActive !== false && isFunctioning(compartment);
}

/** Старый модификатор характеристики (effectStat) — до перехода на активные эффекты. */
export function effectBonuses(compartments) {
  const bonuses = { maxHp: 0, maxCrew: 0, speed: 0, fuelEconomy: 0 };
  for (const compartment of compartments) {
    if (!(compartment.effectStat in bonuses) || !compartment.effectValue) continue;
    if (!effectsWork(compartment)) continue;
    bonuses[compartment.effectStat] += compartment.effectValue;
  }
  return bonuses;
}

/* ---------------- Активные эффекты отсеков ---------------- */

/** Режимы как CONST.ACTIVE_EFFECT_MODES: 1 умножить, 2 прибавить, 3 понизить до, 4 повысить до, 5 заменить. */
const EFFECT_MODES = {
  1: (value, delta) => value * delta,
  2: (value, delta) => value + delta,
  3: Math.min,
  4: Math.max,
  5: (value, delta) => delta
};

/** Изменения всех действующих эффектов корабля. */
export function effectChanges(compartments) {
  const changes = [];
  for (const compartment of compartments) {
    if (!effectsWork(compartment)) continue;
    for (const effect of compartment.effects ?? []) {
      if (effect.disabled) continue;
      for (const change of effect.changes ?? []) {
        const value = Number(change.value);
        if (!Number.isFinite(value) || !(change.mode in EFFECT_MODES)) continue;
        changes.push({ key: change.key, mode: Number(change.mode), value, priority: change.priority ?? change.mode * 10 });
      }
    }
  }
  return changes;
}

/** Применяет изменения одного ключа к базовому значению в порядке приоритета, как Foundry. */
export function applyChanges(base, changes, key) {
  return changes
    .filter((change) => change.key === key)
    .sort((first, second) => first.priority - second.priority)
    .reduce((value, change) => EFFECT_MODES[change.mode](value, change.value), base);
}

/** Боевые бонусы корабля от эффектов отсеков. */
export const SHIP_BONUSES = ["attack", "damage", "defense", "repair", "scout"];

export function shipBonuses(compartments) {
  const changes = effectChanges(compartments);
  return Object.fromEntries(SHIP_BONUSES.map((bonus) => [bonus, Math.round(applyChanges(0, changes, `system.bonuses.${bonus}`))]));
}

/**
 * Прочность = ⌈отсеки без «Без прочности» ÷ 3⌉ × 100 (от разрушения не зависит);
 * вместимость = целые «Жилые»; скорость = максимум, экономия = минимум среди целых машинных.
 */
export function computeStats(compartments) {
  const bonuses = effectBonuses(compartments);
  const hpCount = compartments.filter((compartment) => !compartment.isNoHp).length;
  const residential = compartments.filter((compartment) => compartment.isResidential && isFunctioning(compartment)).length;
  const engines = compartments.filter((compartment) => compartment.systemCategory === "engine" && isFunctioning(compartment));
  let speed = 0;
  let fuelEconomy = 0;
  if (engines.length) {
    speed = Math.max(...engines.map((engine) => engine.speed ?? 0));
    fuelEconomy = Math.min(...engines.map((engine) => engine.fuelEconomy ?? 0));
  }
  // Каждая пробоина в целом отсеке — −1 к скорости корабля.
  speed -= compartments.filter((compartment) => hasCondition(compartment, "breach")).length;
  const changes = effectChanges(compartments);
  const stat = (key, value) => Math.max(0, Math.round(applyChanges(value + bonuses[key], changes, `system.${key}`)));
  return {
    maxHp: stat("maxHp", Math.ceil(hpCount / 3) * 100),
    maxCrew: stat("maxCrew", residential),
    speed: stat("speed", speed),
    fuelEconomy: stat("fuelEconomy", fuelEconomy)
  };
}

export function crewUsed(crew) {
  return crew.reduce((sum, member) => sum + (member.capacityCost ?? 1), 0);
}

/* ---------------- Проходы ---------------- */

/**
 * Проёмы между отсеками:
 * - горизонтальный — соседи по стороне с нижними рядами на одной высоте, проём на высоту нижнего квадрата;
 * - вертикальный — лестница над лестницей или галочка ГМа (passageDown сверху / passageUp снизу), проём по общей границе.
 * orientation "v" — вертикальный отрезок на линии x = line от from до to; "h" — горизонтальный на линии y = line.
 */
export function findPassages(compartments) {
  const passages = [];
  for (let i = 0; i < compartments.length; i++) {
    for (let j = i + 1; j < compartments.length; j++) {
      const first = compartments[i];
      const second = compartments[j];

      let left = null;
      if (first.x + first.width === second.x) left = first;
      else if (second.x + second.width === first.x) left = second;
      if (left && bottomRow(first) === bottomRow(second)) {
        const bottom = bottomRow(first);
        passages.push({ a: first.instanceId, b: second.instanceId, orientation: "v", line: left.x - 1 + left.width, from: bottom - 1, to: bottom });
        continue;
      }

      let upper = null;
      let lower = null;
      if (first.y + first.height === second.y) [upper, lower] = [first, second];
      else if (second.y + second.height === first.y) [upper, lower] = [second, first];
      if (!upper) continue;
      const from = Math.max(first.x, second.x) - 1;
      const to = Math.min(first.x + first.width, second.x + second.width) - 1;
      if (to <= from) continue;
      const stairs = upper.isStairs && lower.isStairs;
      if (stairs || upper.passageDown || lower.passageUp) {
        passages.push({ a: first.instanceId, b: second.instanceId, orientation: "h", line: upper.y - 1 + upper.height, from, to });
      }
    }
  }
  return passages;
}

/* ---------------- Проверка конструкции ---------------- */

export function validateShip({ compartments, gridWidth, gridHeight, crew = [], maxCrew = 0 }) {
  const errors = [];
  const warnings = [];

  if (!compartments.some((compartment) => compartment.systemCategory === "control")) errors.push({ key: "rules.noControl", data: {} });
  if (!compartments.some((compartment) => compartment.systemCategory === "engine")) errors.push({ key: "rules.noEngine", data: {} });

  for (const compartment of compartments) {
    const outside = compartment.x < 1 || compartment.y < 1 ||
      compartment.x + compartment.width - 1 > gridWidth || compartment.y + compartment.height - 1 > gridHeight;
    if (outside) errors.push({ key: "rules.outOfBoundsNamed", data: { name: compartment.name } });
  }
  for (let i = 0; i < compartments.length; i++) {
    for (let j = i + 1; j < compartments.length; j++) {
      if (rectsOverlap(compartments[i], compartments[j])) {
        errors.push({ key: "rules.overlapNamed", data: { name: compartments[i].name, other: compartments[j].name } });
      }
    }
  }

  if (compartments.length > 1) {
    for (const compartment of compartments) {
      const touches = compartments.some((other) => other !== compartment && touchesBySide(compartment, other));
      if (!touches) warnings.push({ key: "rules.notAdjacent", data: { name: compartment.name } });
    }
  }

  const testable = compartments.filter((compartment) => !compartment.ignoresPassage);
  if (testable.length > 1) {
    const neighbours = new Map(testable.map((compartment) => [compartment.instanceId, new Set()]));
    for (const passage of findPassages(testable)) {
      neighbours.get(passage.a).add(passage.b);
      neighbours.get(passage.b).add(passage.a);
    }
    const reached = new Set([testable[0].instanceId]);
    const queue = [testable[0].instanceId];
    while (queue.length) {
      for (const next of neighbours.get(queue.shift())) {
        if (reached.has(next)) continue;
        reached.add(next);
        queue.push(next);
      }
    }
    const disconnected = testable.filter((compartment) => !reached.has(compartment.instanceId));
    if (disconnected.length) {
      warnings.push({ key: "rules.disconnected", data: { names: disconnected.map((compartment) => `«${compartment.name}»`).join(", ") } });
    }
  }

  const used = crewUsed(crew);
  if (used > maxCrew) warnings.push({ key: "rules.overloaded", data: { used, max: maxCrew } });

  return { errors, warnings };
}

/* ---------------- Стены ---------------- */

/**
 * Отрезки стен по контурам отсеков без проёмов, общие грани — одна стена,
 * соседние отрезки на одной прямой склеены. Единицы — линии сетки корабля.
 */
export function buildWallSegments(compartments) {
  const units = new Set();
  for (const compartment of compartments) {
    const left = compartment.x - 1;
    const top = compartment.y - 1;
    const right = left + compartment.width;
    const bottom = top + compartment.height;
    for (let x = left; x < right; x++) units.add(`h|${x}|${top}`).add(`h|${x}|${bottom}`);
    for (let y = top; y < bottom; y++) units.add(`v|${left}|${y}`).add(`v|${right}|${y}`);
  }
  for (const passage of findPassages(compartments)) {
    for (let k = passage.from; k < passage.to; k++) {
      if (passage.orientation === "v") units.delete(`v|${passage.line}|${k}`);
      else units.delete(`h|${k}|${passage.line}`);
    }
  }

  const lines = new Map();
  for (const unit of units) {
    const [orientation, x, y] = unit.split("|");
    const lineKey = orientation === "h" ? `h|${y}` : `v|${x}`;
    if (!lines.has(lineKey)) lines.set(lineKey, []);
    lines.get(lineKey).push(Number(orientation === "h" ? x : y));
  }

  const segments = [];
  for (const [lineKey, positions] of lines) {
    const [orientation, lineValue] = lineKey.split("|");
    const line = Number(lineValue);
    positions.sort((first, second) => first - second);
    let start = positions[0];
    let previous = positions[0];
    const flush = (end) => {
      if (orientation === "h") segments.push({ x1: start, y1: line, x2: end, y2: line });
      else segments.push({ x1: line, y1: start, x2: line, y2: end });
    };
    for (const position of positions.slice(1)) {
      if (position === previous + 1) {
        previous = position;
        continue;
      }
      flush(previous + 1);
      start = previous = position;
    }
    flush(previous + 1);
  }
  return segments;
}

/* ---------------- Таблицы систем ---------------- */

/** Пять таблиц систем из отсеков с группировкой одинаковых («Лестница ×5»). */
export function groupSystems(compartments, categories) {
  const tables = Object.fromEntries(categories.map((category) => [category, []]));
  for (const compartment of compartments) {
    const rows = tables[compartment.systemCategory];
    if (!rows) continue;
    const destroyed = isDestroyed(compartment) && !compartment.worksWhenDestroyed;
    let row = rows.find((existing) => existing.name === compartment.name && existing.destroyed === destroyed);
    if (!row) {
      row = {
        name: compartment.name,
        effect: compartment.effect ?? "",
        firepower: weaponFormula(compartment),
        speed: compartment.speed ?? null,
        fuelEconomy: compartment.fuelEconomy ?? null,
        destroyed,
        count: 0,
        instanceIds: []
      };
      rows.push(row);
    }
    row.count++;
    row.instanceIds.push(compartment.instanceId);
  }
  return tables;
}

/* ---------------- Бой ---------------- */

/** Пушка — отсек с огневой мощью: хотя бы одна кость урона. */
export function isWeapon(compartment) {
  return (compartment.damageDice ?? 0) > 0;
}

/** Залп: каждая кость — отдельный выстрел со своей целью и проверкой. */
export function shotCount(compartment) {
  return compartment.special === "volley" ? Math.max(1, compartment.damageDice ?? 1) : 1;
}

/** Огневая мощь как формула броска урона: «2d6+1»; perShot — одна кость на выстрел залпа. extraBonus — урон от эффектов. */
export function weaponFormula(compartment, extraBonus = 0, { perShot = false } = {}) {
  if (!isWeapon(compartment)) return "";
  const bonus = (compartment.damageBonus ?? 0) + extraBonus;
  const tail = bonus > 0 ? `+${bonus}` : bonus < 0 ? `${bonus}` : "";
  const dice = perShot && compartment.special === "volley" ? 1 : compartment.damageDice;
  return `${dice}d${compartment.damageDie ?? 6}${tail}`;
}

/** Дистанции без штрафа из старого класса дальности: до 1.2 у пушки был один класс. */
export const LEGACY_RANGES = { close: ["close", "medium"], medium: ["close", "medium", "far"], far: ["medium", "far"] };

export function weaponRanges(compartment) {
  return compartment.ranges ?? LEGACY_RANGES[compartment.range] ?? LEGACY_RANGES.medium;
}

/**
 * Сложность попадания: штраф, если дистанции нет среди дистанций пушки; схватка — помеха всем пушкам.
 * modifier — защита цели минус точность стрелка от эффектов.
 */
export function attackDifficulty(compartment, distance, penalty, modifier = 0) {
  const offRange = distance !== "melee" && !weaponRanges(compartment).includes(distance);
  return {
    dc: Math.max(0, (compartment.checkDc ?? 0) + (offRange ? penalty : 0) + modifier),
    penalized: offRange,
    modifier,
    disadvantage: distance === "melee"
  };
}

/* ---------------- Ввод чисел ---------------- */

/** «−5» / «+3» — изменение от текущего, «7» — новое значение; иначе null. */
export function parseHpInput(input, current) {
  const text = String(input ?? "").trim().replace(/[−–—]/g, "-");
  if (/^[+-]\d+$/.test(text)) return current + Number(text);
  if (/^\d+$/.test(text)) return Number(text);
  return null;
}

/* ---------------- Признак устаревшей сцены ---------------- */

/** Всё, что меняет тайлы, регионы и стены по форме: при расхождении сцена устарела. */
export function structureSignature(system) {
  const parts = (system.compartments ?? []).map((compartment) => [
    compartment.instanceId, compartment.x, compartment.y, compartment.width, compartment.height,
    !!compartment.passageUp, !!compartment.passageDown, !!compartment.isStairs, compartment.img ?? ""
  ].join(":"));
  return `${system.gridWidth}x${system.gridHeight};${parts.sort().join(";")}`;
}

/* ---------------- Попадание и его отмена ---------------- */

/** Меняет HP отсека в пределах [0, максимум]; возвращает фактическое изменение. */
function changeHp(compartment, delta) {
  const before = compartment.currentHp;
  compartment.currentHp = Math.max(0, Math.min(compartment.maxHp, Math.round(before + delta)));
  return compartment.currentHp - before;
}

function cloneCompartments(compartments) {
  return compartments.map((compartment) => ({ ...compartment, conditions: [...(compartment.conditions ?? [])] }));
}

/**
 * Нужен ли пересчёт характеристик: отсек перестал или снова начал работать либо сменились его состояния
 * (пробоина отнимает скорость). Ручные правки параметров без этого не затираются.
 */
export function needsRecalc(before, after) {
  return after.some((compartment) => {
    const old = before.find((entry) => entry.instanceId === compartment.instanceId);
    return !old || isFunctioning(old) !== isFunctioning(compartment) || String(old.conditions ?? []) !== String(compartment.conditions ?? []);
  });
}

/**
 * Попадание без записи: урон уходит в прочность и в HP отсека («Без прочности» — только в прочность);
 * splash — соседям по стороне половина урона, только в их HP. Состояния ложатся на неразрушенный отсек с HP.
 * Если отсек давал прочность (щиты), новый потолок ложится на уже сниженную прочность.
 * Возвращает новые отсеки и прочность, а в lost — что снято (для отмены).
 */
export function resolveHit({ compartments, hull }, instanceId, amount, { splash = false, conditions = [] } = {}) {
  const next = cloneCompartments(compartments);
  const target = next.find((compartment) => compartment.instanceId === instanceId);
  const lost = { hull: 0, compartment: 0, splash: [], conditions: [] };
  if (target && !target.isNoHp) {
    lost.compartment = -changeHp(target, -amount);
    if (!isDestroyed(target)) {
      lost.conditions = [...new Set(conditions)].filter((condition) => !target.conditions.includes(condition));
      target.conditions.push(...lost.conditions);
    }
  }
  const half = Math.floor(amount / 2);
  if (splash && target && half > 0) {
    for (const neighbour of adjacentCompartments(next, target)) {
      if (neighbour.isNoHp || neighbour.currentHp <= 0) continue;
      lost.splash.push({ instanceId: neighbour.instanceId, amount: -changeHp(neighbour, -half) });
    }
  }
  let newHull = Math.max(0, Math.round(hull - amount));
  const stats = needsRecalc(compartments, next) ? computeStats(next) : null;
  if (stats) newHull = Math.min(newHull, stats.maxHp);
  lost.hull = hull - newHull;
  return { compartments: next, hull: newHull, stats, lost };
}

/** Отмена попадания: возвращает ровно то, что сняло resolveHit; прочность — не выше максимума после пересчёта. */
export function resolveUndoHit({ compartments, hull, maxHull }, instanceId, lost) {
  const next = cloneCompartments(compartments);
  const restore = (id, amount) => {
    const compartment = next.find((entry) => entry.instanceId === id);
    if (compartment && amount > 0) changeHp(compartment, amount);
  };
  restore(instanceId, lost.compartment);
  const target = next.find((compartment) => compartment.instanceId === instanceId);
  if (target) target.conditions = target.conditions.filter((condition) => !(lost.conditions ?? []).includes(condition));
  for (const { instanceId: neighbourId, amount } of lost.splash ?? []) restore(neighbourId, amount);
  const stats = needsRecalc(compartments, next) ? computeStats(next) : null;
  const newHull = Math.min(stats?.maxHp ?? maxHull, hull + Math.max(0, lost.hull ?? 0));
  return { compartments: next, hull: newHull, stats };
}
