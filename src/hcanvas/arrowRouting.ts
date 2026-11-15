import type { HcBlock, HcConnectorPort, HcPoint } from './types.js';

export interface ArrowRouteGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  points: HcPoint[];
}

export interface BoundArrowRouteGeometry extends ArrowRouteGeometry {
  clearStart: boolean;
  clearEnd: boolean;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function center(block: HcBlock): HcPoint {
  return { x: block.x + block.w / 2, y: block.y + block.h / 2 };
}

function anchorForPort(block: HcBlock, port: HcConnectorPort): HcPoint {
  switch (port) {
    case 'top': return { x: block.x + block.w / 2, y: block.y };
    case 'right': return { x: block.x + block.w, y: block.y + block.h / 2 };
    case 'bottom': return { x: block.x + block.w / 2, y: block.y + block.h };
    case 'left': return { x: block.x, y: block.y + block.h / 2 };
    default: return center(block);
  }
}

function autoPorts(from: HcBlock, to: HcBlock): { start: HcConnectorPort; end: HcConnectorPort } {
  const a = center(from);
  const b = center(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { start: 'right', end: 'left' } : { start: 'left', end: 'right' };
  }
  return dy >= 0 ? { start: 'bottom', end: 'top' } : { start: 'top', end: 'bottom' };
}

function segmentHitsRect(a: HcPoint, b: HcPoint, rect: Rect, padding: number): boolean {
  const left = rect.x - padding;
  const right = rect.x + rect.w + padding;
  const top = rect.y - padding;
  const bottom = rect.y + rect.h + padding;
  if (a.x === b.x) {
    return a.x >= left && a.x <= right && Math.max(a.y, b.y) >= top && Math.min(a.y, b.y) <= bottom;
  }
  if (a.y === b.y) {
    return a.y >= top && a.y <= bottom && Math.max(a.x, b.x) >= left && Math.min(a.x, b.x) <= right;
  }
  return false;
}

function routeScore(points: HcPoint[], obstacles: Rect[]): number {
  let collisions = 0;
  let length = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    length += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    for (const obstacle of obstacles) if (segmentHitsRect(a, b, obstacle, 8)) collisions += 1;
  }
  return collisions * 10000 + length + Math.max(0, points.length - 2) * 4;
}

function simplify(points: HcPoint[]): HcPoint[] {
  const out: HcPoint[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - point.x) < 0.01 && Math.abs(last.y - point.y) < 0.01) continue;
    out.push(point);
  }
  for (let i = 1; i < out.length - 1;) {
    const a = out[i - 1]!;
    const b = out[i]!;
    const c = out[i + 1]!;
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(i, 1);
    else i += 1;
  }
  return out;
}

function orthogonalCandidates(start: HcPoint, end: HcPoint, obstacles: Rect[]): HcPoint[][] {
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const left = Math.min(start.x, end.x) - 46;
  const right = Math.max(start.x, end.x) + 46;
  const top = Math.min(start.y, end.y) - 46;
  const bottom = Math.max(start.y, end.y) + 46;
  const candidates: HcPoint[][] = [
    [start, { x: end.x, y: start.y }, end],
    [start, { x: start.x, y: end.y }, end],
    [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end],
    [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end],
    [start, { x: left, y: start.y }, { x: left, y: end.y }, end],
    [start, { x: right, y: start.y }, { x: right, y: end.y }, end],
    [start, { x: start.x, y: top }, { x: end.x, y: top }, end],
    [start, { x: start.x, y: bottom }, { x: end.x, y: bottom }, end],
  ];
  return candidates.map(candidate => simplify(candidate.filter((point, index, all) => index === 0 || index === all.length - 1 || Number.isFinite(point.x))));
}

export function routeArrowGeometry(arrow: HcBlock, blocks: HcBlock[]): BoundArrowRouteGeometry | null {
  if (!arrow.startBinding && !arrow.endBinding) return null;
  const targets = new Map(blocks.filter(block => block.type !== 'arrow').map(block => [block.id, block]));
  const from = arrow.startBinding ? targets.get(arrow.startBinding) : undefined;
  const to = arrow.endBinding ? targets.get(arrow.endBinding) : undefined;
  const fallbackPoints = arrow.points?.length ? arrow.points : [{ x: 0, y: 0 }, { x: arrow.w, y: arrow.h }];
  const fallbackStart = { x: arrow.x + fallbackPoints[0]!.x, y: arrow.y + fallbackPoints[0]!.y };
  const fallbackEnd = { x: arrow.x + fallbackPoints[fallbackPoints.length - 1]!.x, y: arrow.y + fallbackPoints[fallbackPoints.length - 1]!.y };
  const ports = from && to ? autoPorts(from, to) : null;
  const startPort = arrow.startPort && arrow.startPort !== 'auto' ? arrow.startPort : ports?.start;
  const endPort = arrow.endPort && arrow.endPort !== 'auto' ? arrow.endPort : ports?.end;
  const start = from && startPort && startPort !== 'center' ? anchorForPort(from, startPort) : (from ? { x: fallbackStart.x, y: fallbackStart.y } : fallbackStart);
  const end = to && endPort && endPort !== 'center' ? anchorForPort(to, endPort) : (to ? { x: fallbackEnd.x, y: fallbackEnd.y } : fallbackEnd);
  const route = arrow.connectorRoute || 'straight';
  let points: HcPoint[] = [start, end];
  if (route === 'orthogonal') {
    const obstacles: Rect[] = blocks
      .filter(block => block.type !== 'arrow' && block.id !== from?.id && block.id !== to?.id)
      .map(block => ({ x: block.x, y: block.y, w: block.w, h: block.h }));
    const candidates = orthogonalCandidates(start, end, obstacles);
    points = candidates.sort((a, b) => routeScore(a, obstacles) - routeScore(b, obstacles))[0] || [start, end];
  }
  const padding = 18;
  const minX = Math.min(...points.map(point => point.x)) - padding;
  const minY = Math.min(...points.map(point => point.y)) - padding;
  const maxX = Math.max(...points.map(point => point.x)) + padding;
  const maxY = Math.max(...points.map(point => point.y)) + padding;
  const roundedX = Math.round(minX);
  const roundedY = Math.round(minY);
  return {
    x: roundedX,
    y: roundedY,
    w: Math.max(8, Math.round(maxX - minX)),
    h: Math.max(8, Math.round(maxY - minY)),
    points: points.map(point => ({ x: Math.round((point.x - roundedX) * 100) / 100, y: Math.round((point.y - roundedY) * 100) / 100 })),
    clearStart: Boolean(arrow.startBinding) && !from,
    clearEnd: Boolean(arrow.endBinding) && !to,
  };
}
