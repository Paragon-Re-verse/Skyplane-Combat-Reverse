// npm run build:packs — собирает packs/_source/* в LevelDB packs/* (официальный @foundryvtt/foundryvtt-cli).
// Пока мир с модулем запущен, Foundry держит базы открытыми: собирайте при остановленном мире.
import fs from "node:fs";
import path from "node:path";
import { compilePack } from "@foundryvtt/foundryvtt-cli";
import { ROOT, SOURCE } from "./paths.mjs";

for (const name of fs.readdirSync(SOURCE)) {
  const destination = path.join(ROOT, "packs", name);
  fs.rmSync(destination, { recursive: true, force: true });
  await compilePack(path.join(SOURCE, name), destination, { log: false });
  console.log(`packed ${name}`);
}
