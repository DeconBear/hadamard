import type { HcBlock } from './types.js';
import { vectorStroke } from './vector.js';
import { blockFill, gradientSvgDefs, normalizeGradient } from './fill.js';

function attr(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Path data for one or more cubic segments: start + 3 points per segment. */
export function curvePathData(points: Array<{ x: number; y: number }>): string {
  if (!points.length) return '';
  let data = 'M ' + points[0]!.x + ' ' + points[0]!.y;
  if (points.length >= 4 && (points.length - 1) % 3 === 0) {
    for (let segment = 0; segment < (points.length - 1) / 3; segment += 1) {
      const base = segment * 3;
      data += ' C ' + points[base + 1]!.x + ' ' + points[base + 1]!.y + ' ' + points[base + 2]!.x + ' ' + points[base + 2]!.y + ' ' + points[base + 3]!.x + ' ' + points[base + 3]!.y;
    }
  } else if (points.length >= 2) {
    data += ' L ' + points[points.length - 1]!.x + ' ' + points[points.length - 1]!.y;
  }
  return data;
}

/** A cubic Bezier curve stored as four local points: start, control1, control2, end. */
export function curveSvgMarkup(block: HcBlock): string {
  const width = Math.max(1, block.w);
  const height = Math.max(1, block.h);
  const points = (block.points && block.points.length >= 2 ? block.points : [{ x: 0, y: 0 }, { x: 0.25, y: -20 }, { x: 0.75, y: -20 }, { x: width, y: 0 }])
    .map(point => ({ x: Number(point.x) || 0, y: Number(point.y) || 0 }));
  const stroke = vectorStroke(block);
  const dash = block.style?.strokeStyle === 'dashed' ? ' stroke-dasharray="' + (stroke.width * 4 + 4) + ' ' + (stroke.width * 3 + 3) + '"' : block.style?.strokeStyle === 'dotted' ? ' stroke-dasharray="1 ' + (stroke.width * 2 + 2) + '"' : '';
  const data = curvePathData(points);
  const closed = Boolean(block.closed);
  const fill = closed ? blockFill(block, 'none') : 'none';
  const defs = closed && normalizeGradient(block.fillGradient) ? gradientSvgDefs(block) : '';
  return '<svg class="block-vector" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true">' + defs + '<path d="' + data + (closed ? ' Z' : '') + '" fill="' + attr(fill) + '" stroke="' + attr(stroke.color) + '" stroke-width="' + stroke.width + '" stroke-linecap="round" stroke-linejoin="round"' + dash + '/></svg>';
}
export interface CurvePoint { x: number; y: number }

/** Fits a cubic Bezier to a drag path: endpoints stay fixed, bow comes from maximum deviation. */
export function cubicCurveFromSamples(samples: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (samples.length < 2) return samples;
  const start = samples[0]!;
  const end = samples[samples.length - 1]!;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 2) return samples;
  const nx = -dy / length;
  const ny = dx / length;
  let signedOffset = 0;
  for (const point of samples) {
    const cross = (dx * (point.y - start.y) - dy * (point.x - start.x)) / length;
    if (Math.abs(cross) > Math.abs(signedOffset)) signedOffset = cross;
  }
  const offset = signedOffset * 4 / 3;
  return [
    start,
    { x: start.x + dx * 0.3 + nx * offset, y: start.y + dy * 0.3 + ny * offset },
    { x: start.x + dx * 0.7 + nx * offset, y: start.y + dy * 0.7 + ny * offset },
    end,
  ];
}

export function curveLocalToWorld(block: HcBlock, point: CurvePoint): CurvePoint {
  const centerX = block.w / 2;
  const centerY = block.h / 2;
  const flipX = block.style?.flipX ? -1 : 1;
  const flipY = block.style?.flipY ? -1 : 1;
  const x = centerX + (point.x - centerX) * flipX;
  const y = centerY + (point.y - centerY) * flipY;
  const angle = (Number(block.rotation) || 0) * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: block.x + centerX + (x - centerX) * cos - (y - centerY) * sin, y: block.y + centerY + (x - centerX) * sin + (y - centerY) * cos };
}

export function curveWorldToLocal(block: HcBlock, point: CurvePoint): CurvePoint {
  const centerX = block.w / 2;
  const centerY = block.h / 2;
  const angle = -(Number(block.rotation) || 0) * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point.x - block.x - centerX;
  const dy = point.y - block.y - centerY;
  const x = dx * cos - dy * sin;
  const y = dx * sin + dy * cos;
  return { x: centerX + x * (block.style?.flipX ? -1 : 1), y: centerY + y * (block.style?.flipY ? -1 : 1) };
}

export function splitCurvePoints(points: CurvePoint[], segment: number, t = 0.5): CurvePoint[] {
  const base = segment * 3;
  const p0 = points[base]!, p1 = points[base + 1]!, p2 = points[base + 2]!, p3 = points[base + 3]!;
  const q0 = lerpPoint(p0, p1, t), q1 = lerpPoint(p1, p2, t), q2 = lerpPoint(p2, p3, t);
  const r0 = lerpPoint(q0, q1, t), r1 = lerpPoint(q1, q2, t);
  const anchor = lerpPoint(r0, r1, t);
  return [...points.slice(0, base), p0, q0, r0, anchor, r1, q2, p3, ...points.slice(base + 4)];
}

export function deleteCurveAnchor(points: CurvePoint[], anchorIndex: number): CurvePoint[] | null {
  if (points.length <= 4 || anchorIndex < 0 || anchorIndex >= points.length || anchorIndex % 3 !== 0) return null;
  if (anchorIndex === 0) return points.slice(3).map(point => ({ ...point }));
  if (anchorIndex === points.length - 1) return points.slice(0, -3).map(point => ({ ...point }));
  return [...points.slice(0, anchorIndex - 1), ...points.slice(anchorIndex + 2)].map(point => ({ ...point }));
}

function lerpPoint(a: CurvePoint, b: CurvePoint, t: number): CurvePoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function cubicPoint(points: CurvePoint[], segment: number, t: number): CurvePoint {
  const base = segment * 3;
  const p0 = points[base]!, p1 = points[base + 1]!, p2 = points[base + 2]!, p3 = points[base + 3]!;
  const q0 = lerpPoint(p0, p1, t), q1 = lerpPoint(p1, p2, t), q2 = lerpPoint(p2, p3, t);
  const r0 = lerpPoint(q0, q1, t), r1 = lerpPoint(q1, q2, t);
  return lerpPoint(r0, r1, t);
}

export function nearestCurveSegment(points: CurvePoint[], point: CurvePoint): { segment: number; t: number; distance: number } | null {
  if (points.length < 4 || (points.length - 1) % 3 !== 0) return null;
  let best = { segment: 0, t: 0.5, distance: Infinity };
  for (let segment = 0; segment < (points.length - 1) / 3; segment += 1) {
    for (let step = 1; step < 64; step += 1) {
      const t = step / 64;
      const sample = cubicPoint(points, segment, t);
      const distance = Math.hypot(sample.x - point.x, sample.y - point.y);
      if (distance < best.distance) best = { segment, t, distance };
    }
  }
  return best;
}

export function curveGeometry(block: HcBlock, points: CurvePoint[]): Pick<HcBlock, 'x' | 'y' | 'w' | 'h'> & { points: CurvePoint[] } {
  const absolute = points.map(point => ({ x: block.x + point.x, y: block.y + point.y }));
  const padding = Math.max(4, Number(block.style?.strokeWidth || 2) / 2 + 2);
  const minX = Math.min(...absolute.map(point => point.x)) - padding;
  const minY = Math.min(...absolute.map(point => point.y)) - padding;
  const maxX = Math.max(...absolute.map(point => point.x)) + padding;
  const maxY = Math.max(...absolute.map(point => point.y)) + padding;
  return {
    x: Math.round(minX), y: Math.round(minY),
    w: Math.max(8, Math.round(maxX - minX)), h: Math.max(8, Math.round(maxY - minY)),
    points: absolute.map(point => ({ x: point.x - Math.round(minX), y: point.y - Math.round(minY) })),
  };
}