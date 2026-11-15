import { hcId } from './types.js';
import { markdownPageHtml } from './markdownPage.js';
import type { HcBlock, HcBlockStyle, HcPage, HcPageMode, HcPagePreset, HcShape } from './types.js';

export type ComposePageLayout = 'stack' | 'grid' | 'free';
export type ComposeBlockType =
  | 'heading' | 'text' | 'paragraph' | 'caption'
  | 'markdown' | 'code' | 'math' | 'formula'
  | 'image' | 'shape' | 'html' | 'spacer' | 'divider'
  | 'arrow';

export interface ComposeBlockContent {
  type: ComposeBlockType | string;
  id?: string;
  name?: string;
  text?: string;
  markdown?: string;
  code?: string;
  language?: string;
  tex?: string;
  src?: string;
  alt?: string;
  shape?: HcShape | string;
  html?: string;
  srcFile?: string;
  from?: string;
  to?: string;
  route?: 'straight' | 'orthogonal';
}

export interface ComposeBlockPlacement {
  level?: number;
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  fill?: string;
  stroke?: string;
  align?: 'left' | 'center' | 'right';
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  span?: number;
  autoFit?: boolean;
  style?: HcBlockStyle;
}

export type ComposeBlockSpec = ComposeBlockContent & ComposeBlockPlacement;

export interface ComposePageSpec {
  name?: string;
  mode?: HcPageMode;
  width?: number;
  height?: number;
  background?: string;
  layout?: ComposePageLayout;
  padding?: number;
  gap?: number;
  columns?: number;
  autoHeight?: boolean;
  html?: string;
  markdown?: string;
  notes?: string;
  blocks?: ComposeBlockSpec[];
}

export interface ComposeScene {
  title?: string;
  width?: number;
  height?: number;
  background?: string;
  pages: ComposePageSpec[];
}

export interface ComposeResult {
  title: string;
  pages: HcPage[];
  firstPreset: HcPagePreset;
  warnings: string[];
  blockCount: number;
}

interface Placement {
  spec: ComposeBlockSpec;
  x: number;
  y: number;
  w: number;
  h: number;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_PADDING = 64;
const DEFAULT_GAP = 24;
const DEFAULT_BACKGROUND = '#ffffff';

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionalCoordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function visualWidth(line: string): number {
  return Array.from(line).reduce((sum, char) => sum + (/[\u2E80-\u9FFF\uF900-\uFAFF]/.test(char) ? 1 : 0.55), 0);
}

export function estimateTextHeight(text: string, width: number, fontSize: number, lineHeight = 1.45): number {
  const charsPerLine = Math.max(1, Math.floor(width / Math.max(6, fontSize * 0.58)));
  let lines = 0;
  for (const line of (text || '').split('\n')) lines += Math.max(1, Math.ceil(visualWidth(line) / charsPerLine));
  return Math.max(fontSize * lineHeight, lines * fontSize * lineHeight + 10);
}

function blockBase(spec: ComposeBlockSpec, placement: Placement, z: number): HcBlock {
  return {
    id: spec.id || hcId('block'),
    type: 'text',
    x: placement.x,
    y: placement.y,
    w: placement.w,
    h: placement.h,
    z,
  };
}

function styleFor(spec: ComposeBlockSpec, kind: string): HcBlockStyle {
  const base: HcBlockStyle = spec.style ? { ...spec.style } : {};
  if (kind === 'heading') {
    base.fontSize = optionalNumber(spec.fontSize) || (spec.level === 1 ? 38 : spec.level === 2 ? 30 : 24);
    base.fontWeight = optionalNumber(spec.fontWeight) || 700;
    base.color = spec.color || '#1f2430';
  } else if (kind === 'caption') {
    base.fontSize = optionalNumber(spec.fontSize) || 14;
    base.color = spec.color || '#6b7280';
  } else if (kind === 'text' || kind === 'paragraph') {
    base.fontSize = optionalNumber(spec.fontSize) || 18;
    base.color = spec.color || '#334155';
  } else if (kind === 'markdown') {
    base.fill = spec.fill || '#ffffff';
    base.radius = 12;
    base.fontSize = optionalNumber(spec.fontSize) || 16;
    base.color = spec.color || '#334155';
  } else if (kind === 'code') {
    base.fill = spec.fill || '#171923';
    base.color = spec.color || '#e2e8f0';
    base.fontSize = optionalNumber(spec.fontSize) || 14;
    base.radius = 10;
  }
  if (spec.fill) base.fill = spec.fill;
  if (spec.stroke) base.stroke = spec.stroke;
  if (spec.align) base.align = spec.align;
  return base;
}

function textSpecHeight(spec: ComposeBlockSpec, width: number, fontSize: number): number {
  if (optionalNumber(spec.h)) return spec.h!;
  const text = spec.type === 'markdown' ? spec.markdown || spec.text || '' : spec.text || spec.code || '';
  return Math.max(fontSize * 1.45, estimateTextHeight(text, width, fontSize));
}

function specHeight(spec: ComposeBlockSpec, width: number): number {
  switch (spec.type) {
    case 'spacer': return optionalNumber(spec.h) || optionalNumber(spec.fontSize) || 24;
    case 'divider': return optionalNumber(spec.h) || 1;
    case 'heading': return optionalNumber(spec.h) || estimateTextHeight(spec.text || '', width, optionalNumber(spec.fontSize) || 38);
    case 'caption': return optionalNumber(spec.h) || estimateTextHeight(spec.text || '', width, optionalNumber(spec.fontSize) || 14);
    case 'markdown': return textSpecHeight(spec, width, optionalNumber(spec.fontSize) || 16);
    case 'code': {
      if (optionalNumber(spec.h)) return spec.h!;
      const lines = Math.max(1, (spec.code || '').split('\n').length);
      return lines * (optionalNumber(spec.fontSize) || 14) * 1.45 + 24;
    }
    case 'math':
    case 'formula': return optionalNumber(spec.h) || 84;
    case 'image': return optionalNumber(spec.h) || 220;
    case 'html': return optionalNumber(spec.h) || 160;
    case 'shape': return optionalNumber(spec.h) || 100;
    default: return textSpecHeight(spec, width, optionalNumber(spec.fontSize) || 18);
  }
}

function applyAutoFit(spec: ComposeBlockSpec, placement: Placement, style: HcBlockStyle, text: string): void {
  if (!spec.autoFit || !text) return;
  let fontSize = typeof style.fontSize === 'number' ? style.fontSize : 16;
  while (fontSize > 8 && estimateTextHeight(text, placement.w, fontSize) > placement.h - 8) fontSize -= 1;
  style.fontSize = fontSize;
}

function buildBlock(spec: ComposeBlockSpec, placement: Placement, z: number, warnings: string[]): HcBlock | null {
  const kind = spec.type || 'text';
  if (kind === 'spacer') return null;
  const base = blockBase(spec, placement, z);
  if (kind === 'heading' || kind === 'text' || kind === 'paragraph' || kind === 'caption') {
    const style = styleFor(spec, kind);
    applyAutoFit(spec, placement, style, spec.text || '');
    return { ...base, type: 'text', text: spec.text || '', style };
  }
  if (kind === 'markdown') {
    const style = styleFor(spec, kind);
    applyAutoFit(spec, placement, style, spec.markdown || spec.text || '');
    return { ...base, type: 'markdown', markdown: spec.markdown || spec.text || '', style };
  }
  if (kind === 'code') {
    const style = styleFor(spec, kind);
    applyAutoFit(spec, placement, style, spec.code || spec.text || '');
    return { ...base, type: 'code', code: spec.code || spec.text || '', language: spec.language || 'text', style };
  }
  if (kind === 'math' || kind === 'formula') {
    return { ...base, type: 'math', data: { tex: spec.tex || spec.text || '' } };
  }
  if (kind === 'image') {
    return { ...base, type: 'image', src: spec.src || '', alt: spec.alt || spec.text || '', style: { radius: 12, ...(spec.style || {}) } };
  }
  if (kind === 'shape' || kind === 'divider') {
    const shape = kind === 'divider' ? 'rect' : (spec.shape || 'rect') as HcShape;
    const shapeStyle: HcBlockStyle = kind === 'divider'
      ? { fill: spec.fill || '#d9d3c7', strokeWidth: 0, ...(spec.style || {}) }
      : { fill: spec.fill || '#f1eee7', stroke: spec.stroke || '#d9d3c7', strokeWidth: 1, ...(spec.style || {}) };
    if (spec.color) shapeStyle.color = spec.color;
    if (spec.fontSize) shapeStyle.fontSize = spec.fontSize;
    if (spec.fontWeight) shapeStyle.fontWeight = spec.fontWeight;
    if (spec.align) shapeStyle.align = spec.align;
    return { ...base, type: 'shape', shape, text: spec.text || '', style: shapeStyle };
  }
  if (kind === 'html') {
    if (!spec.html) warnings.push('HTML block "' + (spec.name || spec.id || 'block') + '" has no html; using empty content.');
    return { ...base, type: 'html', html: spec.html || '<div></div>' };
  }
  warnings.push('Unknown block type "' + kind + '"; treating it as text.');
  return { ...base, type: 'text', text: spec.text || '', style: styleFor(spec, 'text') };
}

function stackLayout(blocks: ComposeBlockSpec[], width: number, padding: number, gap: number, warnings: string[]): { placements: Placement[]; height: number } {
  const placements: Placement[] = [];
  let y = padding;
  for (const spec of blocks) {
    const w = optionalNumber(spec.w) || width;
    const h = specHeight(spec, w);
    placements.push({ spec, x: padding, y, w, h });
    y += h + gap;
  }
  return { placements, height: y + padding - (blocks.length ? gap : 0) };
}

function gridLayout(blocks: ComposeBlockSpec[], width: number, padding: number, gap: number, columns: number, warnings: string[]): { placements: Placement[]; height: number } {
  const cols = Math.max(1, Math.floor(columns));
  const cell = Math.max(24, (width - gap * (cols - 1)) / cols);
  const rows: Array<{ items: Placement[]; height: number }> = [];
  let row = { items: [] as Placement[], height: 0 };
  let col = 0;
  for (const spec of blocks) {
    const span = Math.max(1, Math.min(cols, Math.floor(Number(spec.span) || 1)));
    if (col + span > cols) {
      rows.push(row);
      row = { items: [], height: 0 };
      col = 0;
    }
    const w = span * cell + gap * (span - 1);
    const x = padding + col * (cell + gap);
    const h = specHeight(spec, w);
    row.items.push({ spec, x, y: 0, w, h });
    row.height = Math.max(row.height, h);
    col += span;
  }
  if (row.items.length) rows.push(row);
  let y = padding;
  const placements: Placement[] = [];
  for (const itemRow of rows) {
    for (const item of itemRow.items) placements.push({ ...item, y });
    y += itemRow.height + gap;
  }
  return { placements, height: y + padding - (rows.length ? gap : 0) };
}

function freeLayout(blocks: ComposeBlockSpec[], padding: number, width: number, warnings: string[]): { placements: Placement[]; height: number } {
  const placements: Placement[] = [];
  let bottom = padding;
  for (const spec of blocks) {
    if (optionalCoordinate(spec.x) === undefined || optionalCoordinate(spec.y) === undefined) {
      warnings.push('Free layout block "' + (spec.name || spec.id || spec.type) + '" is missing x/y; using padding.');
    }
    const w = optionalNumber(spec.w) || width;
    const h = specHeight(spec, w);
    const x = optionalCoordinate(spec.x) ?? padding;
    const y = optionalCoordinate(spec.y) ?? padding;
    placements.push({ spec, x, y, w, h });
    bottom = Math.max(bottom, y + h + padding);
  }
  return { placements, height: bottom };
}

function anchorPoints(from: HcBlock, to: HcBlock): { start: { x: number; y: number }; end: { x: number; y: number }; horizontal: boolean } {
  const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { start: { x: from.x + from.w, y: fromCenter.y }, end: { x: to.x, y: toCenter.y }, horizontal: true }
      : { start: { x: from.x, y: fromCenter.y }, end: { x: to.x + to.w, y: toCenter.y }, horizontal: true };
  }
  return dy >= 0
    ? { start: { x: fromCenter.x, y: from.y + from.h }, end: { x: toCenter.x, y: to.y }, horizontal: false }
    : { start: { x: fromCenter.x, y: from.y }, end: { x: toCenter.x, y: to.y + to.h }, horizontal: false };
}

function buildArrowBlock(spec: ComposeBlockSpec, from: HcBlock, to: HcBlock, z: number): HcBlock {
  const anchors = anchorPoints(from, to);
  const points: Array<{ x: number; y: number }> = [];
  if (spec.route === 'orthogonal') {
    if (anchors.horizontal) {
      const midX = (anchors.start.x + anchors.end.x) / 2;
      points.push(anchors.start, { x: midX, y: anchors.start.y }, { x: midX, y: anchors.end.y }, anchors.end);
    } else {
      const midY = (anchors.start.y + anchors.end.y) / 2;
      points.push(anchors.start, { x: anchors.start.x, y: midY }, { x: anchors.end.x, y: midY }, anchors.end);
    }
  } else {
    points.push(anchors.start, anchors.end);
  }
  const minX = Math.min(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y));
  const maxX = Math.max(...points.map(point => point.x));
  const maxY = Math.max(...points.map(point => point.y));
  return {
    id: spec.id || hcId('block'),
    type: 'arrow',
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
    z,
    points: points.map(point => ({ x: point.x - minX, y: point.y - minY })),
    arrowhead: 'arrow',
    startBinding: from.id,
    endBinding: to.id,
    style: { stroke: spec.stroke || '#1f2430', strokeWidth: 2, ...(spec.style || {}) },
  };
}

function compilePage(spec: ComposePageSpec, index: number, scene: ComposeScene, warnings: string[]): HcPage {
  const mode = spec.mode || 'canvas';
  const width = numberOr(spec.width, numberOr(scene.width, DEFAULT_WIDTH));
  const height = numberOr(spec.height, numberOr(scene.height, DEFAULT_HEIGHT));
  const background = spec.background || scene.background || DEFAULT_BACKGROUND;
  const name = spec.name || (index === 0 ? scene.title : undefined) || 'Page ' + (index + 1);
  const padding = Math.max(0, numberOr(spec.padding, DEFAULT_PADDING));
  const gap = Math.max(0, numberOr(spec.gap, DEFAULT_GAP));
  const page: HcPage = { id: hcId('page'), name, mode, width, height, background };
  if (spec.notes) page.notes = spec.notes;
  if (mode === 'html') {
    if (spec.html) page.html = spec.html;
    else if (spec.markdown !== undefined) {
      page.markdown = spec.markdown;
      page.html = markdownPageHtml(spec.markdown, { background });
    } else {
      const blocks = spec.blocks || [];
      const text = blocks.filter(block => block.text || block.markdown || block.html).map(block => block.html || block.markdown || block.text || '').join('\n');
      if (text) {
        warnings.push('HTML page "' + name + '" has no html/markdown; using a basic text document.');
        page.html = '<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px/1.6 Inter,sans-serif;padding:64px;color:#1f2430;background:' + background + '}</style></head><body>' + text.split('\n').map(line => '<p>' + escapeHtml(line) + '</p>').join('') + '</body></html>';
      } else {
        page.html = '<!doctype html><html><body></body></html>';
      }
    }
    return page;
  }
  const blockSpecs = spec.blocks || [];
  const arrowSpecs = blockSpecs.filter(blockSpec => blockSpec.type === 'arrow');
  const layoutSpecs = blockSpecs.filter(blockSpec => blockSpec.type !== 'arrow');
  const layout = spec.layout || 'stack';
  let result: { placements: Placement[]; height: number };
  if (layout === 'free') result = freeLayout(layoutSpecs, padding, width - padding * 2, warnings);
  else if (layout === 'grid') result = gridLayout(layoutSpecs, width - padding * 2, padding, gap, numberOr(spec.columns, 2), warnings);
  else result = stackLayout(layoutSpecs, width - padding * 2, padding, gap, warnings);
  if (spec.autoHeight && result.height > height) page.height = Math.ceil(result.height);
  const blocks: HcBlock[] = [];
  const bySpecId = new Map<string, HcBlock>();
  let z = 0;
  for (const placement of result.placements) {
    const block = buildBlock(placement.spec, placement, z, warnings);
    if (block) {
      blocks.push(block);
      if (placement.spec.id) bySpecId.set(placement.spec.id, block);
      z += 1;
    }
  }
  for (const arrowSpec of arrowSpecs) {
    const from = arrowSpec.from ? bySpecId.get(arrowSpec.from) : undefined;
    const to = arrowSpec.to ? bySpecId.get(arrowSpec.to) : undefined;
    if (!from || !to) {
      warnings.push('Arrow "' + (arrowSpec.name || arrowSpec.id || 'arrow') + '" needs from/to block ids that exist in the same page.');
      continue;
    }
    const arrow = buildArrowBlock(arrowSpec, from, to, z);
    if (arrow) { blocks.push(arrow); z += 1; }
  }
  page.blocks = blocks;
  return page;
}

export function compileScene(scene: ComposeScene, options: { title?: string } = {}): ComposeResult {
  if (!scene || typeof scene !== 'object') throw new Error('Scene must be a JSON object');
  if (!Array.isArray(scene.pages) || !scene.pages.length) throw new Error('Scene must contain at least one page');
  const warnings: string[] = [];
  const title = options.title || scene.title || 'Untitled canvas';
  const pages = scene.pages.map((page, index) => compilePage(page, index, scene, warnings));
  const first = pages[0]!;
  const firstPreset: HcPagePreset = {
    id: 'compose',
    title: first.name,
    width: first.width,
    height: first.height,
    background: first.background,
    mode: first.mode,
    ...(first.mode === 'html' ? { html: first.html, ...(first.markdown !== undefined ? { markdown: first.markdown } : {}) } : { blocks: first.blocks }),
  };
  return {
    title,
    pages,
    firstPreset,
    warnings,
    blockCount: pages.reduce((sum, page) => sum + (page.blocks?.length || 0), 0),
  };
}

export function sceneSummary(scene: ComposeScene): { pages: number; blocks: number } {
  const pages = Array.isArray(scene.pages) ? scene.pages.length : 0;
  const blocks = Array.isArray(scene.pages)
    ? scene.pages.reduce((sum, page) => sum + (Array.isArray(page.blocks) ? page.blocks.length : 0), 0)
    : 0;
  return { pages, blocks };
}
