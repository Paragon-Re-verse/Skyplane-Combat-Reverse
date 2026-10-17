// npm run placeholders — SVG-заглушки отсеков по категориям в assets/placeholders.
// Квадратная <категория>.svg — иконка предмета; <категория>/<w>x<h>.svg — тайл под соотношение сторон отсека до 6×5,
// чтобы fit «fill» не искажал иконку (выбор файла — placeholderFor в scripts/scene/scene-builder.js).
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.mjs";

const BRASS = "#b08d57";
const ICONS = {
  equipment: ["#5a4026", `
      <rect x="-30" y="-26" width="60" height="52" fill="#6e5032" stroke="${BRASS}" stroke-width="4"/>
      <path d="M-30 -26 L30 26 M30 -26 L-30 26" stroke="${BRASS}" stroke-width="3"/>
      <rect x="-30" y="-6" width="60" height="12" fill="none" stroke="${BRASS}" stroke-width="3"/>`],
  recon: ["#24484a", `
      <path d="M-30 10 A34 34 0 0 1 20 -30 Z" fill="#2f6b6d" stroke="${BRASS}" stroke-width="4"/>
      <path d="M-6 -8 L18 -32" stroke="${BRASS}" stroke-width="3"/>
      <circle cx="20" cy="-34" r="5" fill="${BRASS}"/>
      <path d="M-10 10 L-18 30 L18 30 L6 10" fill="none" stroke="${BRASS}" stroke-width="4"/>`],
  control: ["#1e3550", `
      <circle r="28" fill="none" stroke="${BRASS}" stroke-width="6"/>
      <circle r="8" fill="${BRASS}"/>
      <g stroke="${BRASS}" stroke-width="5">
        <path d="M0 -38 L0 38"/><path d="M-38 0 L38 0"/>
        <path d="M-27 -27 L27 27"/><path d="M27 -27 L-27 27"/>
      </g>`],
  engine: ["#4a2c18", `
      <g fill="${BRASS}">
        ${[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => `<rect x="-6" y="-38" width="12" height="16" transform="rotate(${angle})"/>`).join("")}
      </g>
      <circle r="26" fill="#7a4626" stroke="${BRASS}" stroke-width="6"/>
      <circle r="9" fill="${BRASS}"/>`],
  weapons: ["#3e1612", `
      <rect x="-34" y="-12" width="58" height="18" rx="6" fill="#5b5550" stroke="${BRASS}" stroke-width="4" transform="rotate(-15)"/>
      <circle cx="-14" cy="16" r="14" fill="none" stroke="${BRASS}" stroke-width="5"/>
      <circle cx="-14" cy="16" r="4" fill="${BRASS}"/>
      <rect x="-30" y="26" width="44" height="6" fill="${BRASS}"/>`]
};

function render(color, icon, width, height, pixels) {
  const viewWidth = width * 200;
  const viewHeight = height * 200;
  const longest = Math.max(width, height);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(pixels * width / longest)}" height="${Math.round(pixels * height / longest)}" viewBox="0 0 ${viewWidth} ${viewHeight}" preserveAspectRatio="none">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}"/>
      <stop offset="1" stop-color="#140d08"/>
    </linearGradient>
    <pattern id="p" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M0 20 L20 20 M20 0 L20 20" stroke="#000" stroke-opacity="0.25" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${viewWidth}" height="${viewHeight}" fill="url(#g)"/>
  <rect width="${viewWidth}" height="${viewHeight}" fill="url(#p)"/>
  <g transform="translate(${viewWidth / 2} ${viewHeight / 2}) scale(${Math.min(width, height)})" opacity="0.9">${icon}
  </g>
</svg>
`;
}

const greatestCommonDivisor = (first, second) => (second ? greatestCommonDivisor(second, first % second) : first);
const ratios = new Map();
for (let width = 1; width <= 6; width++) {
  for (let height = 1; height <= 5; height++) {
    const divisor = greatestCommonDivisor(width, height);
    ratios.set(`${width / divisor}x${height / divisor}`, [width / divisor, height / divisor]);
  }
}

const out = path.join(ROOT, "assets", "placeholders");
let count = 0;
for (const [category, [color, icon]] of Object.entries(ICONS)) {
  fs.mkdirSync(path.join(out, category), { recursive: true });
  fs.writeFileSync(path.join(out, `${category}.svg`), render(color, icon, 1, 1, 400));
  for (const [key, [width, height]] of ratios) {
    fs.writeFileSync(path.join(out, category, `${key}.svg`), render(color, icon, width, height, 800));
    count++;
  }
}
console.log(`placeholders: ${ratios.size} соотношений, ${count} тайлов`);
