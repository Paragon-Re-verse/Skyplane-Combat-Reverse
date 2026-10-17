// npm run unpack — выгружает LevelDB packs/* обратно в JSON packs/_source/*.
// Так правки, сделанные в компендиумах внутри Foundry, попадают в исходники.
import fs from "node:fs";
import path from "node:path";
import { extractPack } from "@foundryvtt/foundryvtt-cli";
import { ROOT, SOURCE } from "./paths.mjs";

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "module.json"), "utf8"));
for (const pack of manifest.packs) {
  const source = path.join(ROOT, pack.path);
  if (!fs.existsSync(source)) continue;
  await extractPack(source, path.join(SOURCE, pack.name), { clean: true, log: false });
  console.log(`unpacked ${pack.name}`);
}
