import path from "node:path";
import { fileURLToPath } from "node:url";

/** Корень модуля: папка над tools/. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE = path.join(ROOT, "packs", "_source");
export const MODULE_ID = "skyplane-combat-reverse";
