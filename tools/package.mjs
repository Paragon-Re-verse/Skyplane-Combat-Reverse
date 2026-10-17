// npm run package — ../skyplane-combat-reverse.zip с папкой модуля внутри (без инструментов сборки и исходников компендиумов).
// Небольшой упаковщик ZIP на zlib из стандартной библиотеки Node (нужен Node 22+ ради zlib.crc32).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { ROOT, MODULE_ID } from "./paths.mjs";

const SKIP = new Set(["node_modules", "tools", "_source", ".git", ".gitignore", "package.json", "package-lock.json", "LOCK", ".DS_Store"]);

function collect(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name) || entry.name.endsWith(".zip")) return [];
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? collect(full) : [full];
  });
}

const entries = [];
const central = [];
let offset = 0;
for (const file of collect(ROOT)) {
  const name = Buffer.from(`${MODULE_ID}/${path.relative(ROOT, file).split(path.sep).join("/")}`, "utf8");
  const data = fs.readFileSync(file);
  const packed = zlib.deflateRawSync(data);
  const crc = zlib.crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6); // имена в UTF-8
  header.writeUInt16LE(8, 8); // deflate
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(packed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  entries.push(header, name, packed);

  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(20, 4);
  record.writeUInt16LE(20, 6);
  record.writeUInt16LE(0x0800, 8);
  record.writeUInt16LE(8, 10);
  record.writeUInt32LE(crc, 16);
  record.writeUInt32LE(packed.length, 20);
  record.writeUInt32LE(data.length, 24);
  record.writeUInt16LE(name.length, 28);
  record.writeUInt32LE(offset, 42);
  central.push(record, name);
  offset += header.length + name.length + packed.length;
}
const centralSize = central.reduce((sum, buffer) => sum + buffer.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(central.length / 2, 8);
end.writeUInt16LE(central.length / 2, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const target = path.join(ROOT, "..", `${MODULE_ID}.zip`);
fs.writeFileSync(target, Buffer.concat([...entries, ...central, end]));
console.log(`${target}: ${central.length / 2} файлов`);
