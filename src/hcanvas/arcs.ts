import type { HcBlock } from './types.js';
import { vectorStroke } from './vector.js';

function attr(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function markerKind(value: unknown): 'none' | 'arrow' | 'dot' {
  return value === 'arrow' || value === 'dot' ? value : 'none';
}

function markerMarkup(id: string, kind: 'arrow' | 'dot', color: string, start: boolean): string {
  const path = kind === 'arrow'
    ? '<path d="M0,0 L14,7 L0,14 Z" fill="' + attr(color) + '"/>'
    : '<circle cx="6" cy="5" r="4" fill="' + attr(color) + '"/>';
  return '<marker id="' + attr(id) + '" viewBox="0 0 14 14" markerWidth="20" markerHeight="20" refX="14" refY="7" orient="' + (start ? 'auto-start-reverse' : 'auto') + '" markerUnits="userSpaceOnUse">' + path + '</marker>';
}

export function arcSvgMarkup(block: HcBlock): string {
  const width = Math.max(1, block.w);
  const height = Math.max(1, block.h);
  const cx = width / 2;
  const cy = height / 2;
  const rx = width / 2;
  const ry = height / 2;
  const data = block.data || {};
  const start = Number(data.startAngle);
  const end = Number(data.endAngle);
  const startAngle = Number.isFinite(start) ? start : 180;
  const endAngle = Number.isFinite(end) ? end : 360;
  const sweep = endAngle >= startAngle ? 1 : 0;
  const delta = Math.abs(endAngle - startAngle) % 360;
  const largeArc = delta > 180 ? 1 : 0;
  const point = (degrees: number) => {
    const radians = degrees * Math.PI / 180;
    return { x: cx + rx * Math.cos(radians), y: cy + ry * Math.sin(radians) };
  };
  const from = point(startAngle);
  const to = point(endAngle);
  const stroke = vectorStroke(block);
  const dash = block.style?.strokeStyle === 'dashed' ? ' stroke-dasharray="' + (stroke.width * 4 + 4) + ' ' + (stroke.width * 3 + 3) + '"' : block.style?.strokeStyle === 'dotted' ? ' stroke-dasharray="1 ' + (stroke.width * 2 + 2) + '"' : '';
  const safeId = String(block.id).replace(/[^a-zA-Z0-9_-]/g, '_');
  const startMarker = markerKind(block.style?.markerStart);
  const endMarker = markerKind(block.style?.markerEnd);
  const startId = 'hc-arc-start-' + safeId;
  const endId = 'hc-arc-end-' + safeId;
  const defs = (startMarker !== 'none' || endMarker !== 'none') ? '<defs>' + (startMarker !== 'none' ? markerMarkup(startId, startMarker, stroke.color, true) : '') + (endMarker !== 'none' ? markerMarkup(endId, endMarker, stroke.color, false) : '') + '</defs>' : '';
  const markers = (startMarker !== 'none' ? ' marker-start="url(#' + startId + ')"' : '') + (endMarker !== 'none' ? ' marker-end="url(#' + endId + ')"' : '');
  const path = 'M ' + from.x.toFixed(2) + ' ' + from.y.toFixed(2) + ' A ' + rx.toFixed(2) + ' ' + ry.toFixed(2) + ' 0 ' + largeArc + ' ' + sweep + ' ' + to.x.toFixed(2) + ' ' + to.y.toFixed(2);
  return '<svg class="block-vector" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true">' + defs + '<path d="' + path + '" fill="none" stroke="' + attr(stroke.color) + '" stroke-width="' + stroke.width + '" stroke-linecap="round"' + dash + markers + '/></svg>';
}
