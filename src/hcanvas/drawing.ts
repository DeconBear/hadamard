import type { HcPoint } from './types.js';

export interface HcDragBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function shapeDragBounds(
  start: HcPoint,
  end: HcPoint,
  options: { square?: boolean; fromCenter?: boolean; defaultWidth?: number; defaultHeight?: number } = {},
): HcDragBounds {
  let dx = end.x - start.x;
  let dy = end.y - start.y;
  if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
    const width = options.defaultWidth ?? 240;
    const height = options.square ? width : options.defaultHeight ?? 160;
    return { x: start.x - width / 2, y: start.y - height / 2, w: width, h: height };
  }
  if (options.square) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * size;
    dy = (dy < 0 ? -1 : 1) * size;
  }
  if (options.fromCenter) {
    return { x: start.x - Math.abs(dx), y: start.y - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 };
  }
  return {
    x: Math.min(start.x, start.x + dx),
    y: Math.min(start.y, start.y + dy),
    w: Math.abs(dx),
    h: Math.abs(dy),
  };
}

export function constrainLinePoint(start: HcPoint, end: HcPoint): HcPoint {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (!length) return { ...end };
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
}
