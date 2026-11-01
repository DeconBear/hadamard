import type { HcBlock, HcPoint } from './types.js';

export interface HcArrowGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  points: HcPoint[];
}

function expandedContains(block: HcBlock, x: number, y: number, padding: number): boolean {
  return x >= block.x - padding && x <= block.x + block.w + padding && y >= block.y - padding && y <= block.y + block.h + padding;
}

export function findBindingTarget(blocks: HcBlock[], x: number, y: number, options: { excludeId?: string; padding?: number } = {}): HcBlock | null {
  const padding = options.padding ?? 14;
  return [...blocks]
    .filter(block => block.id !== options.excludeId && block.type !== 'arrow' && !block.locked)
    .filter(block => expandedContains(block, x, y, padding))
    .sort((left, right) => right.z - left.z)[0] || null;
}

/** Intersection of the center→toward ray with the block's bounding box. */
export function anchorOnBlock(block: HcBlock, towardX: number, towardY: number): HcPoint {
  const centerX = block.x + block.w / 2;
  const centerY = block.y + block.h / 2;
  const dx = towardX - centerX;
  const dy = towardY - centerY;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return { x: centerX, y: centerY };
  const scaleX = Math.abs(dx) > 0.001 ? (block.w / 2) / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const scaleY = Math.abs(dy) > 0.001 ? (block.h / 2) / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleX, scaleY);
  return { x: centerX + dx * scale, y: centerY + dy * scale };
}

export function arrowEndpoints(arrow: HcBlock): { start: HcPoint; end: HcPoint } {
  const points = arrow.points?.length ? arrow.points : [{ x: 0, y: 0 }, { x: arrow.w, y: arrow.h }];
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return { start: { x: arrow.x + first.x, y: arrow.y + first.y }, end: { x: arrow.x + last.x, y: arrow.y + last.y } };
}

export function boundArrowGeometry(arrow: HcBlock, blocks: HcBlock[]): (HcArrowGeometry & { clearStart: boolean; clearEnd: boolean }) | null {
  if (!arrow.startBinding && !arrow.endBinding) return null;
  const targets = new Map(blocks.filter(block => block.type !== 'arrow').map(block => [block.id, block]));
  const startTarget = arrow.startBinding ? targets.get(arrow.startBinding) : undefined;
  const endTarget = arrow.endBinding ? targets.get(arrow.endBinding) : undefined;
  const endpoints = arrowEndpoints(arrow);
  let start = { ...endpoints.start };
  let end = { ...endpoints.end };
  for (let iteration = 0; iteration < 2; iteration += 1) {
    if (startTarget) start = anchorOnBlock(startTarget, end.x, end.y);
    if (endTarget) end = anchorOnBlock(endTarget, start.x, start.y);
  }
  const padding = 18;
  const minX = Math.min(start.x, end.x) - padding;
  const minY = Math.min(start.y, end.y) - padding;
  const maxX = Math.max(start.x, end.x) + padding;
  const maxY = Math.max(start.y, end.y) + padding;
  return {
    x: Math.round(minX), y: Math.round(minY),
    w: Math.max(8, Math.round(maxX - minX)), h: Math.max(8, Math.round(maxY - minY)),
    points: [
      { x: Math.round((start.x - Math.round(minX)) * 100) / 100, y: Math.round((start.y - Math.round(minY)) * 100) / 100 },
      { x: Math.round((end.x - Math.round(minX)) * 100) / 100, y: Math.round((end.y - Math.round(minY)) * 100) / 100 },
    ],
    clearStart: Boolean(arrow.startBinding) && !startTarget,
    clearEnd: Boolean(arrow.endBinding) && !endTarget,
  };
}
