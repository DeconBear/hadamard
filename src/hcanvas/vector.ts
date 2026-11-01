import type { HcBlock } from './types.js';

function attr(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function vectorStroke(block: HcBlock): { color: string; width: number } {
  return {
    color: String(block.style?.stroke || block.style?.color || '#1f2430'),
    width: Math.max(1, Number(block.style?.strokeWidth || 2)),
  };
}

export function freehandPathData(points: Array<{ x: number; y: number }>): string {
  if (!points.length) return '';
  if (points.length === 1) return 'M ' + points[0]!.x + ' ' + points[0]!.y + ' L ' + (points[0]!.x + 0.01) + ' ' + points[0]!.y;
  if (points.length === 2) return 'M ' + points[0]!.x + ' ' + points[0]!.y + ' L ' + points[1]!.x + ' ' + points[1]!.y;
  let data = 'M ' + points[0]!.x.toFixed(2) + ' ' + points[0]!.y.toFixed(2);
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    data += ' Q ' + current.x.toFixed(2) + ' ' + current.y.toFixed(2) + ' ' + midX.toFixed(2) + ' ' + midY.toFixed(2);
  }
  const last = points[points.length - 1]!;
  data += ' L ' + last.x.toFixed(2) + ' ' + last.y.toFixed(2);
  return data;
}

export function vectorSvgMarkup(block: HcBlock): string {
  const width = Math.max(1, block.w);
  const height = Math.max(1, block.h);
  const points = (block.points && block.points.length ? block.points : [{ x: 0, y: 0 }, { x: width, y: height }])
    .map(point => ({ x: Number(point.x) || 0, y: Number(point.y) || 0 }));
  const stroke = vectorStroke(block);
  const dash = block.style?.strokeStyle === 'dashed' ? ' stroke-dasharray="' + (stroke.width * 4 + 4) + ' ' + (stroke.width * 3 + 3) + '"' : block.style?.strokeStyle === 'dotted' ? ' stroke-dasharray="1 ' + (stroke.width * 2 + 2) + '"' : '';
  const common = 'fill="none" stroke="' + attr(stroke.color) + '" stroke-width="' + stroke.width + '" stroke-linecap="round" stroke-linejoin="round"' + dash;
  if (block.type === 'freehand') {
    return '<svg class="block-vector" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true"><path ' + common + ' d="' + freehandPathData(points) + '"/></svg>';
  }
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  let head = '';
  if ((block.arrowhead ?? 'arrow') !== 'none' && length > 2) {
    const size = Math.min(16, Math.max(6, length * 0.22));
    const angle = Math.atan2(dy, dx);
    const left = { x: end.x - size * Math.cos(angle - Math.PI / 6), y: end.y - size * Math.sin(angle - Math.PI / 6) };
    const right = { x: end.x - size * Math.cos(angle + Math.PI / 6), y: end.y - size * Math.sin(angle + Math.PI / 6) };
    head = '<polygon points="' + end.x.toFixed(2) + ',' + end.y.toFixed(2) + ' ' + left.x.toFixed(2) + ',' + left.y.toFixed(2) + ' ' + right.x.toFixed(2) + ',' + right.y.toFixed(2) + '" fill="' + attr(stroke.color) + '" stroke="none"/>';
  }
  return '<svg class="block-vector" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true"><line ' + common + ' x1="' + start.x + '" y1="' + start.y + '" x2="' + end.x + '" y2="' + end.y + '"/>' + head + '</svg>';
}