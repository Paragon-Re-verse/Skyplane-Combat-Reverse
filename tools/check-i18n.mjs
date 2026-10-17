// npm run check — в ru и en одинаковые ключи, и все ключи, что использует код, существуют.
import fs from "node:fs";
import path from "node:path";
import { ROOT, MODULE_ID } from "./paths.mjs";

function flatten(object, prefix = "", out = new Set()) {
  for (const [key, value] of Object.entries(object)) {
    if (value && typeof value === "object") flatten(value, `${prefix}${key}.`, out);
    else out.add(`${prefix}${key}`);
  }
  return out;
}

function files(directory, extensions) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(full, extensions);
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [full] : [];
  });
}

const ru = flatten(JSON.parse(fs.readFileSync(path.join(ROOT, "lang/ru.json"), "utf8")));
const en = flatten(JSON.parse(fs.readFileSync(path.join(ROOT, "lang/en.json"), "utf8")));
const onlyRu = [...ru].filter((key) => !en.has(key));
const onlyEn = [...en].filter((key) => !ru.has(key));

const patterns = [
  /(?:localize|format)\("([a-zA-Z.]+)"/g,
  /sky "([a-zA-Z.]+)"/g,
  /key: "([a-z][a-zA-Z.]+)"/g,
  /(?:denied|refusal)\("([a-zA-Z.]+)"/g,
  /return "(combat\.[a-zA-Z]+)"/g
];
const used = new Set();
for (const file of [...files(path.join(ROOT, "scripts"), [".js"]), ...files(path.join(ROOT, "templates"), [".hbs"])]) {
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) used.add(match[1]);
}
const missing = [...used].filter((key) => !ru.has(`${MODULE_ID}.${key}`));

if (onlyRu.length || onlyEn.length || missing.length) {
  console.error({ onlyRu, onlyEn, missing });
  process.exit(1);
}
console.log(`i18n: ${ru.size} ключей, ru = en, используемые ключи на месте`);
