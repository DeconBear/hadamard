import type { HcBlock, HcPage } from './types.js';

export interface GuideLine {
  axis: 'x' | 'y';
  value: number;
}

export interface MoveSnap {
  dx: number;
  dy: number;
  guides: GuideLine[];
}

export interface MoveBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.map(value => Math.round(value * 10) / 10))].sort((a, b) => a - b);
}

function nearestDelta(values: number[], targets: number[], threshold: number): { delta: number; guide: number } | null {
  let best: { delta: number; guide: number } | null = null;
  for (const value of values) {
    for (const target of targets) {
      const delta = target - value;
      if (Math.abs(delta) > threshold) continue;
      if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, guide: target };
    }
  }
  return best;
}

/**
 * Figma-style edge/center snapping for moving blocks. Candidates are page
 * bounds/centers and every other block's edges/centers on the same page.
 */
export function snapMove(page: HcPage, moving: MoveBox[], dx: number, dy: number, zoom: number, gridSnap: boolean): MoveSnap {
  if (!moving.length) return { dx, dy, guides: [] };
  const left = Math.min(...moving.map(item => item.x + dx));
  const right = Math.max(...moving.map(item => item.x + item.w + dx));
  const top = Math.min(...moving.map(item => item.y + dy));
  const bottom = Math.max(...moving.map(item => item.y + item.h + dy));
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const ids = new Set(moving.map(item => item.id));
  const others = (page.blocks || []).filter(item => !ids.has(item.id)).map(item => ({
    left: item.x,
    right: item.x + item.w,
    centerX: item.x + item.w / 2,
    top: item.y,
    bottom: item.y + item.h,
    centerY: item.y + item.h / 2,
  }));
  const xTargets = uniqueSorted([
    0, page.width / 2, page.width,
    ...others.flatMap(item => [item.left, item.centerX, item.right]),
  ]);
  const yTargets = uniqueSorted([
    0, page.height / 2, page.height,
    ...others.flatMap(item => [item.top, item.centerY, item.bottom]),
  ]);
  const threshold = 6 / Math.max(0.1, zoom);
  const xSnap = nearestDelta([left, centerX, right], xTargets, threshold);
  const ySnap = nearestDelta([top, centerY, bottom], yTargets, threshold);
  let nextDx = dx;
  let nextDy = dy;
  const guides: GuideLine[] = [];
  if (xSnap) { nextDx += xSnap.delta; guides.push({ axis: 'x', value: xSnap.guide }); }
  if (ySnap) { nextDy += ySnap.delta; guides.push({ axis: 'y', value: ySnap.guide }); }
  if (gridSnap) {
    if (!xSnap) { const rawLeft = left; nextDx = dx + Math.round(rawLeft / 8) * 8 - rawLeft; }
    if (!ySnap) { const rawTop = top; nextDy = dy + Math.round(rawTop / 8) * 8 - rawTop; }
  }
  return { dx: nextDx, dy: nextDy, guides };
}