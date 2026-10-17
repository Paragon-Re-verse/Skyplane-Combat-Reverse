import { MODULE_ID, CELL_SIZE } from "../constants.js";
import { buildWallSegments } from "../rules/ship-rules.js";

/** Стены по контурам отсеков: блокируют только движение, проёмы — по правилам проходов. */
export function wallDataForShip(ship, side, origin) {
  return buildWallSegments(ship.system.compartments).map((segment) => ({
    c: [
      origin.originX + segment.x1 * CELL_SIZE,
      origin.originY + segment.y1 * CELL_SIZE,
      origin.originX + segment.x2 * CELL_SIZE,
      origin.originY + segment.y2 * CELL_SIZE
    ],
    move: CONST.WALL_MOVEMENT_TYPES.NORMAL,
    sight: CONST.WALL_SENSE_TYPES.NONE,
    light: CONST.WALL_SENSE_TYPES.NONE,
    sound: CONST.WALL_SENSE_TYPES.NONE,
    flags: { [MODULE_ID]: { generated: { side, instanceId: null } } }
  }));
}
