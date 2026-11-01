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

export function vectorSvgMarkup(block: HcBlock): string {
  const width = Math.max(1, block.w);
  const height = Math.max(1, block.h);
  const points = (block.points && block.points.length ? block.points : [{ x: 0, y: 0 }, { x: width, y: height }])
    .map(point => ({ x: Number(point.x) || 0, y: Number(point.y) || 0 }));
  const stroke = vectorStroke(block);
  const common = 'fill="none" stroke="' + attr(stroke.color) + '" stroke-width="' + stroke.width + '" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"';
  if (block.type === 'freehand') {
    const coords = points.map(point => point.x.toFixed(2) + ',' + point.y.toFixed(2)).join(' ');
    return '<svg class="block-vector" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true"><polyline ' + common + ' points="' + coords + '"/></svg>';
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
