// npm run english — английские компендиумы (packs/_source/<имя>-en) из русских исходников и tools/translations/en.json.
// Идентификаторы документов те же, что у русских: компендиумы разные, а ссылки шаблонов на отсеки меняют только имя компендиума.
// Отсутствующий перевод роняет сборку — русский текст в английский компендиум не попадает.
import fs from "node:fs";
import path from "node:path";
import { ROOT, SOURCE, MODULE_ID } from "./paths.mjs";

const T = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "translations", "en.json"), "utf8"));
const SUFFIX = "-en";
const CATALOG_PACKS = ["compartments", "starcraft-compartments"];

function readPack(name) {
  const directory = path.join(SOURCE, name);
  return fs.readdirSync(directory).filter((file) => file.endsWith(".json"))
    .map((file) => ({ file, document: JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")) }));
}

function writePack(name, file, document) {
  const directory = path.join(SOURCE, `${name}${SUFFIX}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, file), JSON.stringify(document, null, 2) + "\n");
}

function need(value, what) {
  if (value === undefined) throw new Error(`нет перевода: ${what}`);
  return value;
}

/** Перевод полей отсека — и у предмета каталога, и у отсека, поставленного в шаблон. */
function translateCompartment(target, catalogId) {
  const translation = need(T.compartments[catalogId], `отсек ${catalogId}`);
  target.effect = translation.effect;
  target.description = translation.description;
  target.keywords = target.keywords.map((keyword) => need(T.keywords[keyword], `ключевое слово ${keyword}`));
  return translation.name;
}

function translateEffects(effects) {
  for (const effect of effects) effect.name = need(T.effects[effect.name], `эффект ${effect.name}`);
}

for (const name of Object.keys(T.packs)) fs.rmSync(path.join(SOURCE, `${name}${SUFFIX}`), { recursive: true, force: true });

for (const pack of CATALOG_PACKS) {
  for (const { file, document } of readPack(pack)) {
    document.name = translateCompartment(document.system, document.system.catalogId);
    translateEffects(document.effects);
    writePack(pack, file, document);
  }
}

for (const { file, document } of readPack("ship-templates")) {
  const key = path.basename(file, ".json");
  const translation = need(T.templates[key], `шаблон ${key}`);
  document.name = translation.name;
  document.system.shipClass = translation.shipClass;
  document.system.description = translation.description;
  for (const compartment of document.system.compartments) {
    compartment.name = translateCompartment(compartment, compartment.catalogId);
    translateEffects(compartment.effects);
    for (const pack of CATALOG_PACKS) {
      compartment.sourceUuid = compartment.sourceUuid.replace(`Compendium.${MODULE_ID}.${pack}.`, `Compendium.${MODULE_ID}.${pack}${SUFFIX}.`);
    }
  }
  writePack("ship-templates", file, document);
}

for (const { file, document } of readPack("repair-items")) {
  const translation = need(T.repair[document._id], `расходник ${document.name}`);
  document.name = translation.name;
  document.system.description.value = translation.description;
  writePack("repair-items", file, document);
}

for (const { file, document } of readPack("macros")) {
  const translation = need(T.macros[document._id], `макрос ${document.name}`);
  document.name = translation.name;
  document.command = translation.command;
  writePack("macros", file, document);
}

for (const { file, document } of readPack("help")) {
  document.name = T.help.name;
  for (const page of document.pages) {
    const translation = need(T.help.pages[page._id], `страница справки ${page.name}`);
    page.name = translation.name;
    page.text.content = translation.content;
  }
  writePack("help", file, document);
}

console.log(`english: ${Object.keys(T.packs).map((name) => `${name}${SUFFIX}`).join(", ")}`);
