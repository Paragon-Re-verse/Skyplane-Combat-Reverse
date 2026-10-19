/**
 * Перетаскивание предметов сетки инвентаря мышью (pointer-события, не нативный drag-and-drop:
 * при нативном перетаскивании браузер не передаёт нажатия клавиш, а поворот — клавиша).
 * Куда отпустили, решает окно: в сетку (эту или другую) или на лист актёра.
 */
import { footprint, canPlace } from "../../rules/inventory-rules.js";

export const CELL_SIZE = 48;
const DRAG_THRESHOLD = 4;

let activeDrag = null;

/** Поворот на лету (клавиша модуля, по умолчанию F); вне перетаскивания — false, клавиша не съедается. */
export function rotateActiveDrag() {
  if (!activeDrag) return false;
  activeDrag.rotated = !activeDrag.rotated;
  activeDrag.offset = { x: 0, y: 0 };
  updateGhost();
  return true;
}

export function isDragging() {
  return !!activeDrag;
}

/** Сетка под указателем и клетка (с учётом того, за какую клетку предмета взяли). */
function gridUnderPointer() {
  const element = document.elementFromPoint(activeDrag.pointer.x, activeDrag.pointer.y);
  const grid = element?.closest("[data-inventory-grid]");
  if (!grid) return { element };
  const rect = grid.getBoundingClientRect();
  const x = Math.floor((activeDrag.pointer.x - rect.left) / CELL_SIZE) + 1 - activeDrag.offset.x;
  const y = Math.floor((activeDrag.pointer.y - rect.top) / CELL_SIZE) + 1 - activeDrag.offset.y;
  return { element, grid, rect, x, y };
}

function updateGhost() {
  const { ghost, entry, rotated } = activeDrag;
  const { width, height } = footprint({ ...entry, rotated });
  ghost.style.width = `${width * CELL_SIZE}px`;
  ghost.style.height = `${height * CELL_SIZE}px`;
  const { grid, rect, x, y } = gridUnderPointer();
  if (!grid) {
    ghost.style.left = `${activeDrag.pointer.x - CELL_SIZE / 2}px`;
    ghost.style.top = `${activeDrag.pointer.y - CELL_SIZE / 2}px`;
    ghost.classList.remove("invalid");
    return;
  }
  ghost.style.left = `${rect.left + (x - 1) * CELL_SIZE}px`;
  ghost.style.top = `${rect.top + (y - 1) * CELL_SIZE}px`;
  // Наложение видно только в своей сетке; в чужой место подбирает ГМ при переносе.
  const own = grid === activeDrag.source;
  const placed = { ...entry, x, y, rotated };
  const valid = !own || canPlace(activeDrag.entries, placed, Number(grid.dataset.width), Number(grid.dataset.height)).ok;
  ghost.classList.toggle("invalid", !valid);
}

/** Окно или лист актёра под точкой (ApplicationV2 или старый Application). */
function actorUnder(element) {
  const appElement = element?.closest(".application, .app");
  if (!appElement) return null;
  const application = foundry.applications.instances.get(appElement.id)
    ?? Object.values(ui.windows).find((window) => window.element?.[0] === appElement);
  const document = application?.document ?? application?.actor;
  return document?.documentName === "Actor" ? document : null;
}

/**
 * Подключает перетаскивание к сетке. entries — записи отсека; onDrop(entry, target) получает
 * { kind: "grid", shipUuid, instanceId, x, y, rotated } | { kind: "actor", actor }.
 */
export function attachGrid(grid, { entries, onDrop }) {
  for (const itemElement of grid.querySelectorAll("[data-entry-id]")) {
    itemElement.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const entry = entries.find((candidate) => candidate.instanceId === itemElement.dataset.entryId);
      if (!entry) return;
      const rect = itemElement.getBoundingClientRect();
      const start = { x: event.clientX, y: event.clientY };
      const offset = { x: Math.floor((event.clientX - rect.left) / CELL_SIZE), y: Math.floor((event.clientY - rect.top) / CELL_SIZE) };

      const onMove = (moveEvent) => {
        if (!activeDrag) {
          if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < DRAG_THRESHOLD) return;
          const ghost = document.createElement("div");
          ghost.className = "skyplane-inventory-ghost";
          ghost.innerHTML = itemElement.innerHTML;
          document.body.append(ghost);
          activeDrag = { entry, entries, rotated: entry.rotated, offset, ghost, source: grid, pointer: start };
          itemElement.classList.add("dragging");
        }
        activeDrag.pointer = { x: moveEvent.clientX, y: moveEvent.clientY };
        updateGhost();
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (!activeDrag) return;
        const { grid: target, element, x, y } = gridUnderPointer();
        const { rotated } = activeDrag;
        activeDrag.ghost.remove();
        activeDrag = null;
        itemElement.classList.remove("dragging");
        if (target) onDrop(entry, { kind: "grid", shipUuid: target.dataset.ship, instanceId: target.dataset.compartment, x, y, rotated });
        else {
          const actor = actorUnder(element);
          if (actor) onDrop(entry, { kind: "actor", actor });
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }
}
