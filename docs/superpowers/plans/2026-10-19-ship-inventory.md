# Инвентарь отсеков корабля — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** У отсеков корабля появляется инвентарь-сетка (как в Tarkov): игроки, стоящие токеном в отсеке, кладут и забирают предметы dnd5e и грузы, пушки перезаряжаются снарядами из инвентаря своего отсека.

**Architecture:** Содержимое хранится в самом поставленном отсеке (`system.compartments[].inventory`). Расчёты сетки — чистые функции в новом `scripts/rules/inventory-rules.js` с проверками на node. Все изменения выполняет клиент ГМа через существующие `requestAction` → `runPlayerAction` → очередь `serialized`; новые действия проверяют присутствие токена, а не матрицу прав. Окно инвентаря — ApplicationV2 с сеткой на pointer-событиях; входящий перенос с листа персонажа — нативный drop.

**Tech Stack:** Foundry VTT v13 (ApplicationV2, DialogV2, ContextMenu, keybindings), dnd5e 5.3.3, socketlib, Handlebars, SCSS (`npm run build:css`), node-проверки без фреймворков.

**Spec:** `docs/superpowers/specs/2026-10-19-ship-inventory-design.md`

## Global Constraints

- Не коммитить и не поднимать версию: пользователь коммитит и выпускает сам. Каждая задача дописывает строку в `CHANGELOG.md` → «## Не выпущено».
- Все тексты — ключами `skyplane-combat-reverse.*` в `lang/ru.json` и `lang/en.json` одновременно (`npm run check` сверяет ключи и ищет ключи из кода).
- Компендиумы — русские исходники в `packs/_source/<имя>/`, английские генерирует `npm run english` из `tools/translations/en.json`; без перевода сборка падает.
- Изменение корабля — одна запись (`writeShip` / `ship.update`) на действие; перенос с персонажем — запись корабля плюс изменение предмета персонажа в одном действии ГМа.
- Размеры по умолчанию: расходник 1×1, добыча 1×1, снаряжение 1×2, инструмент 1×2, оружие 1×3, контейнер 2×2; прочие типы 1×1. Сетки: «Трюм» 10×6, «Мастерская» 6×4, «Каюта» 3×3; наибольшая сетка 12×12.
- Поворот — клавиша по умолчанию `KeyF`, переназначается (keybinding модуля).
- Стопка без предела; перенос стопки больше 1 — окошко с ползунком.
- Присутствие — единственное условие доступа игрока (свой или вражеский корабль, сцена корабля или боя); ГМ — всегда.
- Новые компендиумы в `module.json` Foundry видит только после перезапуска мира; собранные паки копировать в `%LOCALAPPDATA%/FoundryVTT/Data/modules/skyplane-combat-reverse` только при остановленном мире (`/api/status` → `active:false`).
- Стиль — как в модуле: полные имена переменных, JSDoc-комментарии по-русски, правила без Foundry в `scripts/rules/`.

## Review Focus

1. **Перенос с листа в полную сетку.** Ожидание: отказ «Нет места», предмет остаётся у персонажа, ничего не удалено. → тест в Task 1 (`findSlot` → `null`) и шаг проверки в Task 4 (сначала проверка места, потом изменение персонажа).
2. **Два игрока одновременно забирают одну стопку.** Ожидание: второй получает отказ или остаток; суммарно не больше, чем было. → Task 4: действия идут через `serialized`, количество перечитывается внутри действия; живая проверка в Task 9.
3. **Токен ушёл из отсека, окно открыто, игрок шлёт действие из консоли.** Ожидание: ГМ отказывает (`inventory.notPresent`). → Task 4: проверка присутствия на стороне ГМа в каждом действии игрока.
4. **Одноимённые предметы из разных источников** («Длинный меч» и «Длинный меч +1» после переименования, два разных компендиума). Ожидание: разные стопки. → тест в Task 1 (`stackKey` по источнику, имя — только без источника).
5. **ГМ уменьшил сетку в каталоге, а на кораблях там лежат вещи.** Ожидание: «Обновить на кораблях» оставляет старый размер и называет такие отсеки в отчёте. → тест в Task 1 (`fitsGrid`) и шаг в Task 2.

---

### Task 1: Правила сетки инвентаря

**Files:**
- Create: `scripts/rules/inventory-rules.js`
- Create: `scripts/rules/inventory-rules.check.mjs`
- Modify: `package.json` (скрипт `check`: добавить `node scripts/rules/inventory-rules.check.mjs`)

**Interfaces:**
- Produces (все чистые, без Foundry; «запись» = `{ instanceId: string, item: object /* данные предмета как toObject() */, x: number, y: number, rotated: boolean }`, координаты от 1):
  - `INVENTORY_LIMIT = 12`
  - `DEFAULT_ITEM_SIZES: Record<string, {width, height}>` — значения из Global Constraints.
  - `itemSize(item) -> {width, height}` — `item.flags["skyplane-combat-reverse"].size`, иначе по `item.type`, иначе 1×1.
  - `footprint(entry) -> {width, height}` — с учётом `rotated` (меняет местами).
  - `canPlace(entries, candidate, gridWidth, gridHeight) -> {ok: boolean, reason?: "outside"|"occupied"}` — запись с тем же `instanceId` в `entries` не мешает сама себе.
  - `findSlot(entries, item, gridWidth, gridHeight, {x, y} = {}) -> {x, y, rotated} | null` — сначала точка (x, y) без поворота, потом с поворотом, потом первый свободный слот сверху-слева (без поворота, затем с поворотом).
  - `sourceIds(item) -> string[]` — непустые из `_stats.compendiumSource`, `_stats.duplicateSource`, `flags["skyplane-combat-reverse"].origin`.
  - `stackKey(item) -> string` — `${type}|${sourceIds[0]}`, без источника `${type}|name:${name}`.
  - `findStack(entries, item) -> entry | null`
  - `fitsGrid(entries, gridWidth, gridHeight) -> boolean` — все записи внутри и без наложений.
  - `isAmmoFor(item, ammo) -> boolean`, где `ammo = {uuid, source}`; истина, если `sourceIds(item)` содержит `ammo.uuid` или `ammo.source`.
  - `ammoCount(entries, ammo) -> number` — сумма `system.quantity` подходящих.
  - `takeAmmo(entries, ammo, count) -> {entries, taken}` — новые записи (исходные не меняются), стопки с нулём удаляются.

- [ ] **Step 1: Write the failing checks** в `inventory-rules.check.mjs` (`node:assert/strict`, вспомогательная `entry(overrides)`):
  - `itemSize({type:"weapon"})` → `{width:1,height:3}`; с флагом size 2×2 → 2×2; `{type:"spell"}` → 1×1.
  - `footprint({...оружие, rotated:true})` → 3×1.
  - `canPlace`: за краем сетки 3×3 → `{ok:false, reason:"outside"}`; поверх другой записи → `"occupied"`; на своём же месте (тот же instanceId) → ok.
  - `findSlot` в полной сетке 2×2 из четырёх 1×1 → `null`; оружие 1×3 в сетке 3×1 → `{x:1,y:1,rotated:true}`; с точкой `{x:2,y:1}` в пустой 3×3 → `{x:2,y:1,rotated:false}`.
  - `stackKey`: два предмета с одним `compendiumSource` и разными именами → равны; одно имя, разные источники → не равны; без источников, одно имя и тип → равны.
  - `fitsGrid` записей 3×3 в сетке 2×2 → false.
  - `ammoCount` по стопкам 3 и 2 с `compendiumSource === ammo.uuid` плюс чужая стопка → 5; `takeAmmo(..., 4)` → `taken 4`, остаётся одна запись с quantity 1; `takeAmmo(..., 9)` → `taken 5`, подходящих записей не остаётся; исходный массив не изменился.
- [ ] **Step 2:** `node scripts/rules/inventory-rules.check.mjs` → падает на импорте.
- [ ] **Step 3:** Реализовать функции из Interfaces в `inventory-rules.js` (карта занятости как в `nebolet-tactics-another-version/scripts/rules/ship-rules.js: buildCargoOccupancy` — можно проще, перебором прямоугольников).
- [ ] **Step 4:** `npm run check` → `inventory-rules: все проверки пройдены` и строки ship-rules и i18n.

### Task 2: Данные — сетка отсека, снаряды, содержимое

**Files:**
- Modify: `scripts/data/compartment-data-model.js` (`compartmentFields`)
- Modify: `scripts/data/ship-data-model.js` (`placedCompartmentSchema`)
- Modify: `scripts/documents/ship-actions.js` (`buildPlacedCompartment`, `syncCatalogItem`)
- Modify: `scripts/setup/first-run.js` (миграция, `DATA_VERSION` → `"1.3"`)
- Modify: `packs/_source/compartments/{cargo_hold,workshop_repair,cabin_crew,cabin_captain}.json`, `packs/_source/starcraft-compartments/{sc2p_vault,sc2t_armory,sc2p_cells,sc2t_barracks}.json`, затем `npm run templates`
- Test: `scripts/rules/inventory-rules.check.mjs` (не требуется — логика в Task 1), проверка в живом мире

**Interfaces:**
- Consumes: `fitsGrid` (Task 1).
- Produces:
  - Поля отсека (каталог и поставленный): `inventoryWidth`, `inventoryHeight` — `NumberField` integer 0…12, initial 0; `ammoItem` — `SchemaField({ uuid, source, name, img })`, все `StringField` blank, initial "".
  - Поле поставленного отсека: `inventory` — `ArrayField(SchemaField({ instanceId: StringField, item: ObjectField, x: NumberField≥1, y: NumberField≥1, rotated: BooleanField }))`.
  - `INVENTORY_DEFAULTS` в `first-run.js`: `{ cargo_hold:[10,6], sc2p_vault:[10,6], workshop_repair:[6,4], sc2t_armory:[6,4], cabin_crew:[3,3], cabin_captain:[3,3], sc2p_cells:[3,3], sc2t_barracks:[3,3] }` (SC2-аналоги — решение исполнителя из спеки).
  - `syncCatalogItem` возвращает дополнительно `keptInventory: string[]` («Корабль: Отсек»), лист каталога показывает их предупреждением, как `keptSize`.

- [ ] **Step 1:** Добавить поля; `buildPlacedCompartment` ставит `inventory: []`.
- [ ] **Step 2:** `syncCatalogItem`: сохранять `inventory` поставленного отсека; новый размер сетки — только если `fitsGrid(inventory, w, h)`, иначе прежний и запись в `keptInventory`; `ammoItem` — из каталога.
- [ ] **Step 3:** Миграция `migrateInventory()` в `first-run.js`: мировые предметы-отсеки и поставленные отсеки всех кораблей с `inventoryWidth === 0` и `catalogId` из `INVENTORY_DEFAULTS` получают размер; одна запись на корабль; вызвать из `migrateData` при `older("1.3")`.
- [ ] **Step 4:** Задать размеры в исходниках компендиумов (по `INVENTORY_DEFAULTS`), `npm run templates`, `npm run build` → проверки проходят.
- [ ] **Step 5:** CHANGELOG: строка о сетке инвентаря у отсеков.

### Task 3: Лист отсека — вкладки, «Инвентарь», «Снаряды»

**Files:**
- Modify: `scripts/apps/compartment-sheet.js`
- Modify: `templates/compartment-sheet.hbs` → разбить на `templates/compartment-sheet/{description,details,combat,inventory,effects}.hbs` и навигацию вкладок
- Modify: `styles/skyplane-combat-reverse.scss` (+ `npm run build:css`), `lang/*.json`

**Interfaces:**
- Consumes: поля Task 2.
- Produces: вкладки листа `description` | `details` | `combat` | `inventory` | `effects` (группа `primary`, по умолчанию `description`); действия `clearAmmoItem`; drop предмета на `[data-drop-zone="ammo"]` пишет `system.ammoItem = { uuid, source: doc._stats.compendiumSource ?? "", name, img }`.

- [ ] **Step 1:** `static TABS = { primary: { tabs: [...], initial: "description", labelPrefix: "skyplane-combat-reverse.itemSheet.tab" } }`, `PARTS` по вкладкам (каждая `scrollable: [""]`), поля распределить по спеке («Описание»: картинка, название, ключевые слова, эффект, описание; «Детали»: категория, размер, HP, тайл, скорость, экономия; «Бой»: нынешний блок + «Снаряды»; «Инвентарь»: X × Y; «Эффекты»: активные эффекты).
- [ ] **Step 2:** «Снаряды»: зона с картинкой и названием или подсказкой «Перетащите предмет»; `_onDrop` берёт данные через `foundry.applications.ux.TextEditor.implementation.getDragEventData`, принимает только `type === "Item"`.
- [ ] **Step 3:** Живая проверка: лист «Трюм» — вкладки переключаются, «Инвентарь» 10 × 6; в «Торпедный аппарат» перетащить предмет — поле заполнилось, крестик очищает. Лист не длиннее одного экрана на вкладке.

### Task 4: Действия инвентаря на клиенте ГМа

**Files:**
- Create: `scripts/documents/inventory-actions.js`
- Modify: `scripts/documents/ship-actions.js` (`runPlayerAction`: `right: null` пропускает `canUser`; экспорт `writeShip` не нужен — инвентарь пишет `ship.update(appendLog(...))`)
- Modify: `scripts/combat/ship-combat.js` (экспортировать `tokenInCompartment`)
- Modify: `scripts/apps/ship-sheet.js` (`LOG_TYPES` + `"inventory"`), `lang/*.json` (`logType.inventory`, `log.inventory.*`, `inventory.*` отказы)
- Modify: `scripts/main.js` (импорт `inventory-actions.js`, чтобы действия зарегистрировались)

**Interfaces:**
- Consumes: Task 1 (`canPlace`, `findSlot`, `findStack`, `takeAmmo`, `ammoCount`), Task 2 (поля), `registerPlayerAction`, `serialized`, `appendLog`, `logEntry`, `getCompartment`, `tokenInCompartment(scene, ship, instanceId, user)`.
- Produces (имена действий для `requestAction(name, ship, payload)`; у всех `right: null`, ответ `{ok}` или отказ `{ok:false, reason:{key}}`):
  - `inventoryStore {instanceId, sceneId, actorUuid, itemId, quantity, x?, y?}` — с листа персонажа в отсек.
  - `inventoryTake {instanceId, sceneId, entryId, quantity, actorUuid}` — из отсека персонажу.
  - `inventoryMove {instanceId, sceneId, entryId, x, y, rotated}` — внутри сетки.
  - `inventoryTransfer {instanceId, sceneId, entryId, quantity, targetShipUuid, targetInstanceId, x?, y?, rotated?}` — в другой отсек/корабль.
  - `inventoryResize {instanceId, sceneId, entryId, width, height}`, `inventorySplit {instanceId, sceneId, entryId, quantity}`.
  - `inventoryAddCatalog {instanceId, uuid, quantity, x?, y?}` и `inventoryDelete {instanceId, entryId}` — только ГМ.
  - `reloadFromInventory {instanceId, sceneId}` — до `ammo` из инвентаря отсека пушки по `ammoItem`.
  - Экспорт `isPresent(user, scene, ship, instanceId) -> boolean` (ГМ → true; иначе `tokenInCompartment` не null) — для окон.
  - Журнал: тип `inventory`, тексты `log.inventory.store|take|transfer|reload|add|delete`, например «Proverka: «Зелье лечения» ×3 — из инвентаря «Борин» в «Трюм».».

- [ ] **Step 1:** В каждом действии игрока — `isPresent` на стороне ГМа (для `inventoryTransfer` — в обоих отсеках, для `inventoryStore`/`inventoryTake` — ещё и владение актёром); отказ `inventory.notPresent`.
- [ ] **Step 2:** `inventoryStore`: количество ограничить `system.quantity` предмета; сначала посчитать место (`findStack` → в ту же запись, иначе `findSlot`), при `null` — отказ `inventory.noSpace` без изменений; затем изменить предмет персонажа (уменьшить или удалить; контейнер — вместе с содержимым, `item.system.contents`), затем одна запись корабля; если запись корабля бросила — вернуть предмет персонажу. В данных записи ставить `flags["skyplane-combat-reverse"].origin = item.uuid`, если у предмета нет `compendiumSource`.
- [ ] **Step 3:** `inventoryTake`: перечитать запись внутри действия; создать/увеличить предмет у персонажа (стопка — по `stackKey` среди предметов актёра; контейнер — вместе с сохранённым содержимым), затем одна запись корабля.
- [ ] **Step 4:** Остальные действия — по Interfaces, каждое одной записью корабля (`inventoryTransfer` между кораблями — две записи, сначала цель).
- [ ] **Step 5:** Живая проверка в консоли ГМа: тестовый корабль «Т-…», `requestAction("inventoryAddCatalog", ...)`, `inventoryMove`, `inventorySplit`, два параллельных `inventoryTake` одной стопки (Review Focus 2) — сумма не больше исходной; журнал и фильтр «Инвентарь».

### Task 5: Окно инвентаря

**Files:**
- Create: `scripts/apps/inventory-window.js`, `scripts/apps/parts/inventory-grid.js`, `scripts/apps/quantity-dialog.js`, `templates/inventory-window.hbs`
- Modify: `scripts/main.js` (keybinding `rotateInventoryItem`, перерисовка окон на `updateActor` и `updateToken`), `styles/*.scss`, `lang/*.json`

**Interfaces:**
- Consumes: действия Task 4, `isPresent`, Task 1 (`footprint`, `canPlace`).
- Produces:
  - `openInventoryWindow(ship, instanceId) -> InventoryWindow` (одно окно на отсек, id `${MODULE_ID}-inventory-${ship.id}-${instanceId}`).
  - `askQuantity(name, max) -> Promise<number|null>` — DialogV2 с `<input type="range">` и числом рядом; при `max === 1` сразу 1.
  - `InventoryGrid.activeDrag` — текущее перетаскивание (keybinding поворота меняет его `rotated` и перерисовывает «призрак»).

- [ ] **Step 1:** Сетка: клетки, предметы (картинка, имя, значок `×N`), «призрак» места при перетаскивании pointer-событиями; отпускание внутри своей сетки → `inventoryMove`; над другим окном инвентаря (`document.elementFromPoint` → `[data-inventory-grid]`) → `askQuantity` → `inventoryTransfer`; над листом актёра (`.application` с актёром-персонажем) → `askQuantity` → `inventoryTake`.
- [ ] **Step 2:** Нативный drop на сетку (`type === "Item"` с родителем-актёром) → `askQuantity` → `inventoryStore` с клеткой под курсором.
- [ ] **Step 3:** Правый клик (`foundry.applications.ux.ContextMenu.implementation`, `jQuery: false`): «Повернуть», «Размер…» (DialogV2 с двумя числами 1…12), «Разделить стопку…» (`askQuantity`), «Забрать себе», «Удалить» (ГМ).
- [ ] **Step 4:** ГМ: слева каталог — паки грузов (`localPack("cargo")` + свои компендиумы предметов в папке модуля, как `compartmentCatalogs()` в `ship-sheet.js`), строка поиска по названию, фильтр по типу, перетаскивание в сетку или «+» → `askQuantity` → `inventoryAddCatalog`; кнопка «Новый груз» — создать «Добычу» в компендиуме «Свои грузы» в папке «SkyPlane Combat Re:verse» (создать при отсутствии) и открыть её лист.
- [ ] **Step 5:** Только просмотр, если `!isPresent(...)` (перетаскивание и меню выключены, надпись «Встаньте токеном в отсек»); пересчёт на `updateToken`.
- [ ] **Step 6:** Keybinding `rotateInventoryItem` (`KeyF`, `precedence: PRIORITY`): во время `InventoryGrid.activeDrag` переключает поворот и возвращает `true`, иначе `false`.

### Task 6: Окно отсека и конструктор

**Files:**
- Modify: `scripts/apps/compartment-window.js`, `templates/compartment-window.hbs`, `scripts/apps/ship-sheet.js` (удаление отсека в конструкторе), `lang/*.json`

**Interfaces:**
- Consumes: `openInventoryWindow`, `isPresent`, `ammoCount`, действие `reloadFromInventory`.

- [ ] **Step 1:** Кнопка «Инвентарь» сбоку окна отсека, если у отсека `inventoryWidth > 0`: активна при `isPresent`, иначе неактивна с подсказкой; на вражеском корабле кнопка только при `isPresent`.
- [ ] **Step 2:** `openCompartmentWindow`: на нераскрытом вражеском корабле окно открывается, если токен пользователя стоит в этом отсеке (абордаж); иначе как сейчас.
- [ ] **Step 3:** У пушки с `ammoItem`: строка «Снаряды: <название> — в отсеке N» и кнопка «Перезарядить» для присутствующего (→ `reloadFromInventory`).
- [ ] **Step 4:** Удаление отсека с непустым `inventory` в конструкторе — подтверждение «В отсеке N предметов — они пропадут» (Ctrl+Z возвращает вместе с содержимым — проверить).

### Task 7: Выстрел тратит снаряды

**Files:**
- Modify: `scripts/combat/ship-combat.js` (`shotBlocker`, GM-`fireWeapon`), `scripts/apps/battle-panel.js` (`gunStatus`), `scripts/rules/ship-rules.js` при необходимости

**Interfaces:**
- Consumes: `ammoCount`, `takeAmmo` (Task 1).

- [ ] **Step 1:** Пушка с `ammo === 0` и `ammoItem.uuid`: выстрел/залп запрещён при `ammoCount(inventory, ammoItem) === 0` (отказ `noAmmo`, статус «пусто» на панели); GM-`fireWeapon` в той же записи корабля снимает один снаряд `takeAmmo(..., 1)`.
- [ ] **Step 2:** Пушка с `ammo > 0` — без изменений (магазин); пополнение — только `reloadFromInventory` или «Пополнить» ГМа.
- [ ] **Step 3:** Живая проверка на тестовой паре кораблей: торпеда со снарядами в отсеке — выстрел снимает 1; пусто — отказ.

### Task 8: Компендиум грузов, справка, перевод

**Files:**
- Create: `packs/_source/cargo/*.json` (9 предметов `type: "loot"` с `flags.skyplane-combat-reverse.size`)
- Modify: `module.json` (паки `cargo` «SkyPlane: грузы неболёта» и `cargo-en`, оба в `packFolders`), `tools/make-english.mjs` (обработка `cargo` по `_id`, как `repair-items`), `tools/translations/en.json` (`packs.cargo`, `cargo.<_id>`), `packs/_source/help/help.json` + перевод (страница «Инвентарь», раздел о снарядах), `packs/_source/compartments/weapon_torpedo.json` и `packs/_source/starcraft-compartments/sc2t_yamato.json` (`ammoItem` на торпеду и заряд), `CHANGELOG.md`, `README.md`

- [ ] **Step 1:** Грузы (имя, размер): ящик боеприпасов 2×1, канистра флогистона 1×2, бочка пресной воды 1×2, ящик провизии 2×1, медицинский ящик 1×1, набор запчастей 2×1, торпеда «Шмель» 1×2, заряд Ямато 1×2, контрабанда 1×1.
- [ ] **Step 2:** `npm run build` → английские паки созданы, проверки проходят, кириллицы в `packs/_source/*-en` нет.
- [ ] **Step 3:** Остановить мир, скопировать модуль в копию Foundry, запустить мир; RU-клиент видит «грузы», EN-клиент — «cargo».

### Task 9: Живая проверка целиком

- [ ] Два клиента (ГМ `localhost:30000`, игрок `127.0.0.1:30000`), тестовые копии кораблей «Т-…» на сцене корабля и сцене боя.
- [ ] Игрок: без токена в «Трюме» кнопка неактивна; встал — открыл; перетащил 3 из 5 зелий с листа (ползунок) — у персонажа 2, в сетке ×3; повернул F при перетаскивании; «Размер…»; «Забрать себе».
- [ ] Ушёл из отсека — окно только для просмотра, действие из консоли отклонено (Review Focus 3).
- [ ] Абордаж: токен в отсеке нераскрытого врага — окно и инвентарь открываются, вещи забираются.
- [ ] Полная сетка — отказ, предмет остался у персонажа (Review Focus 1).
- [ ] ГМ: каталог с поиском, «Новый груз», перенос между кораблями, «Обновить на кораблях» с уменьшенной сеткой (Review Focus 5).
- [ ] Перезарядка торпедного аппарата из трюмного ящика в отсеке пушки; журнал «Инвентарь»; экспорт журнала в .txt содержит записи.
- [ ] Консоль — только известные фоновые ошибки мира; тестовые данные удалить, активную сцену вернуть.
