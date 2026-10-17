import { isDestroyed, isDamaged } from "../../rules/ship-rules.js";
import { placeholderFor } from "../../scene/scene-builder.js";

/** Контекст DOM-сетки конструктора: пустые клетки и отсеки, размещённые через CSS Grid. */
export function buildGridContext(ship, canBuild) {
  const { gridWidth, gridHeight, compartments } = ship.system;
  const cells = [];
  for (let y = 1; y <= gridHeight; y++) {
    for (let x = 1; x <= gridWidth; x++) cells.push({ x, y, style: `grid-column: ${x}; grid-row: ${y};` });
  }
  return {
    width: gridWidth,
    height: gridHeight,
    canBuild,
    columns: Array.from({ length: gridWidth }, (_, index) => index + 1),
    rows: Array.from({ length: gridHeight }, (_, index) => index + 1),
    cells,
    compartments: compartments.map((compartment) => ({
      ...compartment,
      destroyed: isDestroyed(compartment),
      damaged: isDamaged(compartment),
      image: compartment.img || placeholderFor(compartment.systemCategory, compartment.width, compartment.height),
      style: `grid-column: ${compartment.x} / span ${compartment.width}; grid-row: ${compartment.y} / span ${compartment.height};`
    }))
  };
}

/** Клетка сетки под курсором (от 1), с поправкой на точку захвата отсека. */
export function cellFromEvent(gridElement, event, width, height, offset = { x: 0, y: 0 }) {
  const rect = gridElement.getBoundingClientRect();
  const cellWidth = rect.width / width;
  const cellHeight = rect.height / height;
  return {
    x: Math.floor((event.clientX - rect.left) / cellWidth) + 1 - offset.x,
    y: Math.floor((event.clientY - rect.top) / cellHeight) + 1 - offset.y
  };
}

/** Какой квадрат отсека схватили: смещение от его левого верхнего угла. */
export function grabOffset(compartmentElement, event, compartment) {
  const rect = compartmentElement.getBoundingClientRect();
  return {
    x: Math.min(compartment.width - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * compartment.width))),
    y: Math.min(compartment.height - 1, Math.max(0, Math.floor(((event.clientY - rect.top) / rect.height) * compartment.height)))
  };
}
