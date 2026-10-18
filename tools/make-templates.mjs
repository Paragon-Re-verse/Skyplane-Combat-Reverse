// npm run templates — отсеки StarCraft II и шаблоны кораблей в packs/_source.
// Каждая раскладка проверяется правилами модуля: ошибка или предупреждение роняют сборку.
// Отсеки основного каталога берутся из packs/_source/compartments.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT as root } from "./paths.mjs";
import * as rules from "../scripts/rules/ship-rules.js";

const MOD = "skyplane-combat-reverse";
const STATS = { coreVersion: "13.351", systemId: "dnd5e", systemVersion: "5.3.3", createdTime: 1792108800000, modifiedTime: 1792108800000 };

function id(seed) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.createHash("sha256").update(`${MOD}:${seed}`).digest();
  return Array.from(bytes.subarray(0, 16), (byte) => alphabet[byte % alphabet.length]).join("");
}

function write(pack, name, document) {
  const directory = path.join(root, "packs", "_source", pack);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(document, null, 2) + "\n");
}

/* ---------- Каталог: стимпанк из компендиума + отсеки StarCraft II ---------- */

const catalog = new Map();
for (const file of fs.readdirSync(path.join(root, "packs/_source/compartments"))) {
  const item = JSON.parse(fs.readFileSync(path.join(root, "packs/_source/compartments", file), "utf8"));
  catalog.set(item.system.catalogId, { item, pack: "compartments" });
}

const base = {
  img: "", keywords: [], isResidential: false, isNoHp: false, ignoresPassage: false, isOutsideOnly: false,
  isStairs: false, isNarrow: false, speed: null, fuelEconomy: null, effect: "",
  checkSkill: "", checkDc: 12, ranges: ["close", "medium", "far"], special: "", damageDice: 0, damageDie: 6, damageBonus: 0, ammo: 0,
  effectStat: "", effectValue: 0, worksWhenDestroyed: false
};

// [catalogId, name, systemCategory, width, height, hp, extra, description]
const STARCRAFT = [
  // Терраны
  ["sc2t_bridge", "Мостик линкора", "control", 3, 2, 20, { keywords: ["Управление"], effect: "Командование: раз в раунд капитан даёт +1 к одной проверке экипажа." }, "Голографический стол, кресло капитана и вечно недовольный адъютант."],
  ["sc2t_yamato", "Ямато-пушка", "weapons", 3, 2, 25, { keywords: ["Вооружение", "Только снаружи"], isOutsideOnly: true, checkSkill: "prc", checkDc: 15, ranges: ["medium", "far"], special: "charge", ammo: 3, damageDice: 6, damageDie: 10, effect: "Раунд зарядки, затем один выстрел по отсеку цели." }, "Плазменное орудие главного калибра. Экипаж зовёт его «последним аргументом»."],
  ["sc2t_ats", "Батарея ATS-лазеров", "weapons", 2, 1, 12, { keywords: ["Вооружение"], checkSkill: "prc", checkDc: 12, ranges: ["close", "medium"], damageDice: 2, damageDie: 8, effect: "Против кораблей." }, "Лазеры «воздух — поверхность»: бьют по корпусу и надстройкам."],
  ["sc2t_ata", "Батарея ATA-лазеров", "weapons", 2, 1, 10, { keywords: ["Вооружение"], checkSkill: "prc", checkDc: 10, ranges: ["close", "medium"], special: "volley", damageDice: 3, damageDie: 4, effect: "Против истребителей и перехватчиков: каждая кость — отдельная цель." }, "Скорострельные лазеры «воздух — воздух»."],
  ["sc2t_reactor", "Термоядерный реактор", "engine", 3, 3, 24, { keywords: ["Машинное отделение"], speed: 4, fuelEconomy: 2, effect: "" }, "Гудит так, что в кантине дребезжат стаканы."],
  ["sc2t_warp", "Ядро тактического прыжка", "equipment", 2, 2, 16, { keywords: ["Оборудование"], effect: "Раз в бой: корабль выходит из боя или меняет дистанцию на любую." }, "Тактический варп-прыжок. Отсчёт идёт под гробовое молчание мостика."],
  ["sc2t_barracks", "Казарма морпехов", "equipment", 3, 1, 10, { keywords: ["Жилой"], isResidential: true, effects: [["Вместимость экипажа +2", "system.maxCrew", 2]], effect: "Жилой отсек на отделение: +3 к вместимости вместо +1. Морпехи готовы к абордажу за 30 секунд." }, "Шкафчики, скафандры CMC-300 и запах стимуляторов."],
  ["sc2t_cantina", "Кантина", "equipment", 2, 1, 8, { keywords: ["Оборудование"], effect: "Музыкальный автомат и бармен: +1 к боевому духу экипажа после отдыха." }, "Здесь всегда пахнет виски и чьими-то заговорами."],
  ["sc2t_armory", "Оружейная Свона", "equipment", 2, 1, 12, { keywords: ["Оборудование"], effect: "Ремонтные расходники в этом отсеке чинят на 2 HP больше (по решению ГМа)." }, "«Не трогай ничего, что искрит», — табличка на двери."],
  ["sc2t_sensor", "Сенсорная башня", "recon", 1, 2, 10, { keywords: ["Разведка", "Только снаружи"], isOutsideOnly: true, checkSkill: "prc", checkDc: 12, effect: "Обнаруживает корабли противника на любой дистанции." }, "Радар дальнего обнаружения на выносной мачте."],
  ["sc2t_vikings", "Ангар «Викингов»", "weapons", 2, 2, 14, { keywords: ["Вооружение"], checkSkill: "prc", checkDc: 12, damageDice: 2, damageDie: 6, effect: "Звено истребителей: атака по кораблю или перехват вражеских истребителей." }, "Трансформирующиеся истребители на магнитных захватах."],
  ["sc2t_matrix", "Защитная матрица", "equipment", 1, 1, 8, { keywords: ["Оборудование"], effects: [["Прочность +100", "system.maxHp", 100]], effect: "+100 к прочности корабля, пока отсек цел." }, "Генератор поля, поглощающего попадания."],
  ["sc2t_lift", "Турболифт", "equipment", 1, 1, 0, { keywords: ["Лестница", "Без прочности"], isStairs: true, isNoHp: true, effect: "Вертикальный проход: соединён с турболифтом выше и ниже." }, "Музыка в лифте не менялась с Гильдийских войн."],
  ["sc2t_crawl", "Технический лаз", "equipment", 1, 1, 0, { keywords: ["Без прочности", "Узкий"], isNoHp: true, isNarrow: true, effect: "Узкий: движение стоит вдвое дороже." }, "Кабели, трубы и SCV, который здесь живёт."],
  // Протоссы
  ["sc2p_bridge", "Мостик-матрица Кхалы", "control", 2, 2, 18, { keywords: ["Управление"], effect: "Псионическая связь: экипаж всегда знает, где находятся его члены." }, "Кристаллический трон, откуда экзекутор слышит корабль как живое существо."],
  ["sc2p_engine", "Варп-двигатель на кхайдарине", "engine", 3, 2, 22, { keywords: ["Машинное отделение"], speed: 3, fuelEconomy: 3, effect: "" }, "Кристаллы кхайдарина поют, когда корабль разгоняется."],
  ["sc2p_hangar", "Ангар перехватчиков", "weapons", 2, 1, 10, { keywords: ["Вооружение", "Только снаружи"], isOutsideOnly: true, checkSkill: "prc", checkDc: 12, special: "volley", damageDice: 4, damageDie: 4, effect: "Четыре перехватчика: каждая кость — отдельная атака. Без фабрики перехватчики не восстанавливаются." }, "Стартовые порты вдоль золотого корпуса."],
  ["sc2p_factory", "Фабрика перехватчиков", "equipment", 2, 1, 12, { keywords: ["Оборудование"], effect: "Каждый раунд восстанавливает 1 перехватчик в повреждённом ангаре." }, "Автоматические кузни собирают перехватчики из света и металла."],
  ["sc2p_shields", "Генератор щитов", "equipment", 2, 2, 16, { keywords: ["Оборудование"], effects: [["Щиты: прочность +200", "system.maxHp", 200]], effect: "Щиты: +200 к прочности корабля, пока генератор цел." }, "Синее мерцание вокруг корпуса — первое, что видят враги."],
  ["sc2p_catapult", "Гравитационная катапульта", "equipment", 1, 1, 8, { keywords: ["Оборудование"], effect: "Перехватчики вылетают уже в первом раунде боя." }, "Улучшение, за которое воздушная флотилия молится на Совет."],
  ["sc2p_lift", "Гравитационный лифт", "equipment", 1, 1, 0, { keywords: ["Лестница", "Без прочности"], isStairs: true, isNoHp: true, effect: "Вертикальный проход: соединён с лифтом выше и ниже." }, "Столб мягкого света между палубами."],
  ["sc2p_cells", "Зал медитации", "equipment", 2, 1, 8, { keywords: ["Жилой"], isResidential: true, effect: "Жилой отсек для тамплиеров экипажа." }, "Тихие кельи, где слышно Кхалу."],
  ["sc2p_oracle", "Сенсор-пророк", "recon", 1, 1, 8, { keywords: ["Разведка"], checkSkill: "prc", checkDc: 10, effect: "Пророческое зрение: раскрывает корабль противника." }, "Кристалл, видящий на несколько мгновений вперёд."],
  ["sc2p_vault", "Кристаллическое хранилище", "equipment", 3, 1, 0, { keywords: ["Без прочности"], isNoHp: true, effect: "Груз и запасные кристаллы. Не учитывается в прочности." }, "Ряды кхайдариновых кристаллов в стазисе."]
];

/** Активный эффект предмета каталога: одно изменение «Прибавить». */
function effectDocument(itemId, catalogId, [name, key, value]) {
  const _id = id(`effect:${catalogId}:${key}`);
  return {
    _id, _key: `!items.effects!${itemId}.${_id}`, name, img: "icons/svg/aura.svg", type: "base", system: {},
    changes: [{ key, mode: 2, value: String(value), priority: null }],
    disabled: false, duration: {}, description: "", origin: null, tint: "#ffffff", transfer: true, statuses: [], sort: 0, flags: {}, _stats: STATS
  };
}

STARCRAFT.forEach(([catalogId, name, systemCategory, width, height, hp, extra, description], index) => {
  const _id = id(`sc2:${catalogId}`);
  const { effects = [], ...system } = extra;
  const item = {
    _id,
    _key: `!items!${_id}`,
    name,
    type: `${MOD}.compartment`,
    img: `modules/${MOD}/assets/placeholders/${systemCategory}.svg`,
    system: { ...base, ...system, catalogId, systemCategory, width, height, hp, description: `<p>${description}</p>` },
    effects: effects.map((spec) => effectDocument(_id, catalogId, spec)),
    folder: null, sort: (index + 1) * 100, ownership: { default: 0 }, flags: {}, _stats: STATS
  };
  write("starcraft-compartments", catalogId, item);
  catalog.set(catalogId, { item, pack: "starcraft-compartments" });
});

/* ---------- Шаблоны ---------- */

function placed(catalogId, x, y, extra = {}, seed) {
  const entry = catalog.get(catalogId);
  if (!entry) throw new Error(`нет отсека ${catalogId}`);
  const { item, pack } = entry;
  const { description, ...system } = item.system;
  return {
    ...system,
    effects: item.effects.map(({ name: effectName, img, disabled, changes }) => ({ name: effectName, img, disabled, changes })),
    instanceId: id(`inst:${seed}`),
    sourceUuid: `Compendium.${MOD}.${pack}.Item.${item._id}`,
    name: item.name,
    description,
    x, y,
    currentHp: system.hp,
    maxHp: system.hp,
    passageUp: false,
    passageDown: false,
    effectActive: true,
    ...extra
  };
}

const TEMPLATES = [
  {
    key: "swift", name: "Стриж", shipClass: "Курьер", gridWidth: 9, gridHeight: 3, distance: "far",
    description: "Лёгкий курьер: почта, дипломаты и всё, что нужно доставить вчера. Одна палуба, две каюты, пушка на корме.",
    layout: [
      ["bridge_leather", 1, 2], ["radar_station", 3, 2], ["crows_nest", 3, 1],
      ["stairs_vert", 4, 2], ["stairs_vert", 4, 3], ["cabin_crew", 5, 2], ["cabin_crew", 5, 3],
      ["engine_steam_compact", 7, 2], ["weapon_falconet", 9, 3]
    ]
  },
  {
    key: "grumbler", name: "Ворчун", shipClass: "Грузовой барк", gridWidth: 12, gridHeight: 5, distance: "medium",
    description: "Пузатый торговец с тремя трюмами. Медленный, но доживает до порта — на корме «Хобгоблин», на носу пара пушек от пиратов.",
    layout: [
      ["crows_nest", 5, 1], ["bridge_leather", 5, 2], ["cabin_captain", 7, 2], ["radar_station", 10, 2],
      ["engine_hobgoblin", 11, 2], ["weapon_carbolin", 3, 3],
      ["stairs_vert", 4, 3], ["stairs_vert", 4, 4], ["stairs_vert", 4, 5],
      ["weapon_falconet", 3, 4], ["cabin_crew", 5, 4], ["cabin_crew", 7, 4], ["mess_hall", 9, 4],
      ["cargo_hold", 1, 5], ["cargo_hold", 5, 5], ["cargo_hold", 8, 5]
    ]
  },
  {
    key: "harpy", name: "Гарпия", shipClass: "Канонерка", gridWidth: 10, gridHeight: 4, distance: "close",
    description: "Рейдер для коротких злых стычек: огнемёт на носу, торпеды на корме и пушки на каждой палубе.",
    layout: [
      ["radar_station", 5, 1], ["engine_hobgoblin", 7, 1],
      ["weapon_carbolin", 1, 2], ["stairs_vert", 2, 2], ["bridge_compact", 3, 2], ["weapon_carbolin", 6, 2],
      ["stairs_vert", 2, 3], ["workshop_repair", 3, 3], ["weapon_falconet", 5, 3], ["weapon_falconet", 6, 3], ["crows_nest", 9, 3],
      ["weapon_flamethrower", 1, 4], ["stairs_vert", 2, 4], ["cabin_crew", 3, 4], ["cabin_crew", 5, 4], ["weapon_torpedo", 9, 4]
    ]
  },
  {
    key: "leviathan", name: "Левиафан", shipClass: "Тяжёлый крейсер", gridWidth: 14, gridHeight: 7, distance: "medium",
    description: "Флагман эскадры: «Тихоокеанский титан» в корме, медотсек и мастерская на нижней палубе, торпеды и пушки по всему борту.",
    layout: [
      ["weapon_falconet", 3, 1], ["stairs_vert", 4, 1], ["crows_nest", 5, 1],
      ["weapon_carbolin", 3, 2], ["stairs_vert", 4, 2], ["bridge_leather", 5, 2], ["radar_station", 7, 2],
      ["weapon_torpedo", 8, 3], ["weapon_carbolin", 10, 3], ["weapon_carbolin", 11, 3], ["engine_titan", 12, 3],
      ["weapon_flamethrower", 3, 3], ["stairs_vert", 4, 3],
      ["weapon_torpedo", 2, 4], ["stairs_vert", 4, 4], ["cabin_captain", 5, 4],
      ["weapon_carbolin", 3, 5], ["stairs_vert", 4, 5], ["mess_hall", 8, 5], ["cabin_crew", 10, 5],
      ["weapon_falconet", 3, 6], ["stairs_vert", 4, 6], ["cabin_crew", 5, 6], ["cabin_crew", 7, 6], ["cabin_crew", 9, 6], ["weapon_falconet", 11, 6],
      ["cargo_hold", 1, 7], ["stairs_vert", 4, 7], ["cargo_hold", 5, 7], ["medbay_auto", 8, 7], ["workshop_repair", 10, 7]
    ]
  },
  {
    key: "hyperion", name: "Гиперион", shipClass: "Линейный крейсер типа «Бегемот»", gridWidth: 14, gridHeight: 5, distance: "far",
    description: "Флагман Рейдеров Рейнора, неболёт по документам. Ямато-пушка на носу, кантина с музыкальным автоматом, оружейная Свона и тактический прыжок на случай, если всё пошло по сценарию. Батареи ATS на верхней палубе связаны с нижними отсеками люками — это галочки «Проход вниз».",
    layout: [
      ["sc2t_ats", 9, 1, { passageDown: true }], ["sc2t_ats", 12, 1, { passageDown: true }],
      ["sc2t_warp", 4, 2], ["sc2t_sensor", 6, 2], ["sc2t_lift", 7, 3], ["sc2t_bridge", 8, 2], ["sc2t_yamato", 11, 2],
      ["sc2t_reactor", 1, 3], ["sc2t_matrix", 4, 4], ["sc2t_cantina", 5, 4], ["sc2t_lift", 7, 4], ["sc2t_armory", 8, 4], ["sc2t_ata", 10, 4],
      ["sc2t_vikings", 12, 4],
      ["sc2t_barracks", 4, 5], ["sc2t_lift", 7, 5], ["sc2t_crawl", 8, 5], ["cargo_hold", 9, 5]
    ]
  },
  {
    key: "carrier", name: "Гнев Айура", shipClass: "Авианосец протоссов", gridWidth: 14, gridHeight: 4, distance: "far",
    description: "En Taro Adun! Длинный золотой корпус, четыре ангара перехватчиков по левому борту и генератор щитов, который сам по себе стоит целого корабля. Пока щиты целы, прочность выше на 200 — разбейте генератор, и авианосец станет заметно мягче.",
    layout: [
      ["sc2p_hangar", 2, 1], ["sc2p_lift", 4, 1], ["sc2p_hangar", 5, 1],
      ["sc2p_hangar", 2, 2], ["sc2p_lift", 4, 2], ["sc2p_shields", 5, 2], ["sc2p_bridge", 7, 2],
      ["sc2p_hangar", 2, 3], ["sc2p_lift", 4, 3], ["sc2p_oracle", 9, 3], ["sc2p_engine", 11, 3],
      ["sc2p_vault", 1, 4], ["sc2p_lift", 4, 4], ["sc2p_cells", 5, 4], ["sc2p_cells", 7, 4], ["sc2p_factory", 9, 4], ["sc2p_catapult", 14, 4]
    ]
  }
];

TEMPLATES.forEach((template, index) => {
  const compartments = template.layout.map(([catalogId, x, y, extra], position) => placed(catalogId, x, y, extra, `${template.key}:${position}`));
  const result = rules.validateShip({ compartments, gridWidth: template.gridWidth, gridHeight: template.gridHeight, crew: [], maxCrew: 99 });
  const placementErrors = compartments
    .map((compartment) => [compartment.name, rules.checkPlacement(compartment, compartments, template.gridWidth, template.gridHeight)])
    .filter(([, check]) => !check.ok);
  if (result.errors.length || result.warnings.length || placementErrors.length) {
    console.error(template.name, JSON.stringify({ result, placementErrors }, null, 1));
    process.exit(1);
  }
  const stats = rules.computeStats(compartments);
  const _id = id(`template:${template.key}`);
  write("ship-templates", template.key, {
    _id,
    _key: `!actors!${_id}`,
    name: template.name,
    type: `${MOD}.ship`,
    img: "icons/svg/wing.svg",
    system: {
      shipClass: template.shipClass,
      captainUuid: "",
      crew: [],
      ...stats,
      currentHp: stats.maxHp,
      phlogiston: 5,
      combatDistance: template.distance,
      gridWidth: template.gridWidth,
      gridHeight: template.gridHeight,
      compartments,
      description: `<p>${template.description}</p>`
    },
    items: [], effects: [], folder: null, sort: (index + 1) * 100,
    ownership: { default: 2 }, flags: {}, _stats: STATS
  });
  console.log(`${template.name.padEnd(12)} ${template.gridWidth}×${template.gridHeight}  отсеков ${compartments.length}  HP ${stats.maxHp}  экипаж ${stats.maxCrew}  скорость ${stats.speed}  экономия ${stats.fuelEconomy}`);
});
