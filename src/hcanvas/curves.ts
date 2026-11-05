import type { HcBlock } from './types.js';
import { vectorStroke } from './vector.js';
import { blockFill, gradientSvgDefs, normalizeGradient } from './fill.js';

function attr(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** A cubic Bezier curve stored as four local points: start, control1, control2, end. */
export function curveSvgMarkup(block: HcBlock): string {
  const width = Math.max(1, block.w);
  const height = Math.max(1, block.h);
  const points = (block.points && block.points.length >= 2 ? block.points : [{ x: 0, y: 0 }, { x: 0.25, y: -20 }, { x: 0.75, y: -20 }, { x: width, y: 0 }])
    .map(point => ({ x: Number(point.x) || 0, y: Number(point.y) || 0 }));
  const stroke = vectorStroke(block);
  const dash = block.style?.strokeStyle === 'dashed' ? ' stroke-dasharray="' + (stroke.width * 4 + 4) + ' ' + (stroke.width * 3 + 3) + '"' : block.style?.strokeStyle === 'dotted' ? ' stroke-dasharray="1 ' + (stroke.width * 2 + 2) + '"' : '';
  let data = 'M ' + points[0]!.x + ' ' + points[0]!.y;
  if (points.length >= 4 && (points.length - 1) % 3 === 0) {
    for (let segment = 0; segment < (points.length - 1) / 3; segment += 1) {
      const base = segment * 3;
      data += ' C ' + points[base + 1]!.x + ' ' + points[base + 1]!.y + ' ' + points[base + 2]!.x + ' ' + points[base + 2]!.y + ' ' + points[base + 3]!.x + ' ' + points[base + 3]!.y;
    }
  } else if (points.length >= 2) {
    data += ' L ' + points[points.length - 1]!.x + ' ' + points[points.length - 1]!.y;
  }
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
  const offset = signedOffset * 2.35;
  return [
    start,
    { x: start.x + dx * 0.3 + nx * offset, y: start.y + dy * 0.3 + ny * offset },
    { x: start.x + dx * 0.7 + nx * offset, y: start.y + dy * 0.7 + ny * offset },
    end,
  ];
}