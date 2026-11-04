import type { HcBlock, HcGradient } from './types.js';

function escapeAttr(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function normalizeGradient(gradient: HcGradient | null | undefined): HcGradient | null {
  if (!gradient || gradient.type !== 'linear' || !Array.isArray(gradient.stops) || gradient.stops.length < 2) return null;
  const stops = gradient.stops
    .map(stop => ({ offset: Math.max(0, Math.min(1, Number(stop.offset) || 0)), color: String(stop.color || '#000000'), ...(stop.opacity !== undefined ? { opacity: Number(stop.opacity) } : {}) }))
    .sort((a, b) => a.offset - b.offset);
  return { type: 'linear', angle: Number.isFinite(Number(gradient.angle)) ? Number(gradient.angle) : 90, stops };
}

export function gradientSvgDefs(block: HcBlock, idPrefix = 'paint'): string {
  const gradient = normalizeGradient(block.fillGradient);
  if (!gradient) return '';
  const id = idPrefix + '-' + String(block.id || 'block').replace(/[^a-zA-Z0-9_-]/g, '_');
  const angle = (gradient.angle * Math.PI) / 180;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const x1 = (0.5 - dx / 2).toFixed(4);
  const y1 = (0.5 - dy / 2).toFixed(4);
  const x2 = (0.5 + dx / 2).toFixed(4);
  const y2 = (0.5 + dy / 2).toFixed(4);
  const stops = gradient.stops.map(stop => '<stop offset="' + stop.offset + '" stop-color="' + escapeAttr(stop.color) + '"' + (stop.opacity !== undefined ? ' stop-opacity="' + stop.opacity + '"' : '') + '/>').join('');
  return '<defs><linearGradient id="' + id + '" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '">' + stops + '</linearGradient></defs>';
}

export function gradientPaintId(block: HcBlock, idPrefix = 'paint'): string {
  return idPrefix + '-' + String(block.id || 'block').replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function blockFill(block: HcBlock, fallback = 'none'): string {
  const gradient = normalizeGradient(block.fillGradient);
  if (gradient) return 'url(#' + gradientPaintId(block) + ')';
  return String(block.style?.fill || fallback);
}

export function gradientCss(gradient: HcGradient | undefined): string {
  const normalized = normalizeGradient(gradient);
  if (!normalized) return '#ffffff';
  const direction = normalized.angle + 'deg';
  return 'linear-gradient(' + direction + ', ' + normalized.stops.map(stop => stop.color + ' ' + Math.round(stop.offset * 100) + '%').join(', ') + ')';
}