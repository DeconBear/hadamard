import type { HcBlock, HcBlockStyle } from './types.js';

export type CanvasLayoutMode = 'stack' | 'row' | 'grid';
export type CanvasDistributeAxis = 'horizontal' | 'vertical';

export interface CanvasLayoutArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasLayoutOptions {
  mode: CanvasLayoutMode;
  area: CanvasLayoutArea;
  gap?: number;
  columns?: number;
  stretch?: boolean;
}

export interface CanvasLayoutPatch {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasLayoutIssue {
  code: 'outside-page' | 'overlap' | 'text-overflow';
  blockId: string;
  message: string;
}

function ordered(blocks: HcBlock[]): HcBlock[] {
  return blocks.slice().sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
}

export function layoutBlocks(blocks: HcBlock[], options: CanvasLayoutOptions): CanvasLayoutPatch[] {
  const gap = Math.max(0, options.gap ?? 24);
  const area = options.area;
  const items = ordered(blocks);
  if (!items.length) return [];
  const patches: CanvasLayoutPatch[] = [];
  if (options.mode === 'stack') {
    let y = area.y;
    for (const block of items) {
      const w = options.stretch === false ? Math.min(block.w, area.w) : area.w;
      patches.push({ id: block.id, x: Math.round(area.x), y: Math.round(y), w: Math.round(w), h: Math.round(block.h) });
      y += block.h + gap;
    }
    return patches;
  }
  if (options.mode === 'row') {
    let x = area.x;
    for (const block of items) {
      const h = options.stretch === false ? Math.min(block.h, area.h) : area.h;
      patches.push({ id: block.id, x: Math.round(x), y: Math.round(area.y), w: Math.round(block.w), h: Math.round(h) });
      x += block.w + gap;
    }
    return patches;
  }
  const columns = Math.max(1, Math.min(12, Math.floor(options.columns ?? 2)));
  const maxItemWidth = Math.max(20, ...items.map(block => block.w));
  const cellWidth = options.stretch === false
    ? Math.max(maxItemWidth, (area.w - gap * (columns - 1)) / columns)
    : Math.max(20, (area.w - gap * (columns - 1)) / columns);
  const rows: Array<{ y: number; height: number }> = [];
  for (let index = 0; index < items.length; index += 1) {
    const rowIndex = Math.floor(index / columns);
    if (!rows[rowIndex]) rows[rowIndex] = { y: area.y + rows.slice(0, rowIndex).reduce((sum, row) => sum + row.height + gap, 0), height: 0 };
    rows[rowIndex]!.height = Math.max(rows[rowIndex]!.height, items[index]!.h);
  }
  items.forEach((block, index) => {
    const rowIndex = Math.floor(index / columns);
    const column = index % columns;
    const row = rows[rowIndex]!;
    patches.push({
      id: block.id,
      x: Math.round(area.x + column * (cellWidth + gap)),
      y: Math.round(row.y),
      w: Math.round(options.stretch === false ? block.w : cellWidth),
      h: Math.round(Math.max(block.h, row.height)),
    });
  });
  return patches;
}

export function distributeBlocks(blocks: HcBlock[], axis: CanvasDistributeAxis): CanvasLayoutPatch[] {
  const items = ordered(blocks);
  if (items.length < 2) return [];
  const patches: CanvasLayoutPatch[] = [];
  if (axis === 'horizontal') {
    const start = Math.min(...items.map(block => block.x));
    const end = Math.max(...items.map(block => block.x + block.w));
    const total = items.reduce((sum, block) => sum + block.w, 0);
    const gap = (end - start - total) / (items.length - 1);
    let x = start;
    for (const block of items) {
      patches.push({ id: block.id, x: Math.round(x), y: block.y, w: block.w, h: block.h });
      x += block.w + gap;
    }
  } else {
    const start = Math.min(...items.map(block => block.y));
    const end = Math.max(...items.map(block => block.y + block.h));
    const total = items.reduce((sum, block) => sum + block.h, 0);
    const gap = (end - start - total) / (items.length - 1);
    let y = start;
    for (const block of items) {
      patches.push({ id: block.id, x: block.x, y: Math.round(y), w: block.w, h: block.h });
      y += block.h + gap;
    }
  }
  return patches;
}

export function estimateTextHeight(text: string, width: number, style: HcBlockStyle | undefined, fallbackFontSize = 16): number {
  const fontSize = typeof style?.fontSize === 'number' ? style.fontSize : fallbackFontSize;
  const lineHeight = typeof style?.lineHeight === 'number' ? style.lineHeight : 1.45;
  const charsPerLine = Math.max(1, Math.floor(width / Math.max(6, fontSize * 0.58)));
  let lines = 0;
  for (const line of (text || '').split('\n')) {
    const visual = Array.from(line).reduce((sum, char) => sum + (/[\u2E80-\u9FFF\uF900-\uFAFF]/.test(char) ? 1 : 0.55), 0);
    lines += Math.max(1, Math.ceil(visual / charsPerLine));
  }
  return Math.max(fontSize * lineHeight, lines * fontSize * lineHeight + 10);
}

export function autoHeightForText(block: HcBlock, width?: number): number | null {
  if (block.type !== 'text') return null;
  return Math.max(24, Math.round(estimateTextHeight(block.text || '', width ?? block.w, block.style)));
}

export function layoutIssues(blocks: HcBlock[], pageWidth: number, pageHeight: number, mode: string): CanvasLayoutIssue[] {
  const issues: CanvasLayoutIssue[] = [];
  if (mode !== 'canvas') return issues;
  const visible = blocks.filter(block => block.type !== 'html' && block.type !== 'arrow' && !(block.w * block.h > pageWidth * pageHeight * 0.55));
  for (const block of visible) {
    if (block.x < 0 || block.y < 0 || block.x + block.w > pageWidth || block.y + block.h > pageHeight) {
      issues.push({ code: 'outside-page', blockId: block.id, message: 'Block is outside the page bounds.' });
    }
    if (block.type === 'text') {
      const needed = autoHeightForText(block);
      if (needed !== null && needed > block.h + 4) issues.push({ code: 'text-overflow', blockId: block.id, message: 'Text may need ' + needed + 'px height.' });
    }
  }
  for (let i = 0; i < visible.length; i += 1) {
    for (let j = i + 1; j < visible.length; j += 1) {
      const a = visible[i]!;
      const b = visible[j]!;
      const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      if (w * h > Math.min(a.w * a.h, b.w * b.h) * 0.12) issues.push({ code: 'overlap', blockId: b.id, message: 'Blocks overlap.' });
    }
  }
  return issues.slice(0, 40);
}

export function augmentTextAutoHeightOps(doc: { pages: Array<{ id: string; blocks?: HcBlock[] }> }, ops: import('./types.js').HcOp[]): import('./types.js').HcOp[] {
  return ops.map(op => {
    if (op.op !== 'update_block' || op.patch.h !== undefined) return op;
    const page = doc.pages.find(item => item.id === op.pageId);
    const block = page?.blocks?.find(item => item.id === op.blockId);
    if (!block || block.type !== 'text') return op;
    if (op.patch.text === undefined && op.patch.w === undefined && op.patch.style === undefined) return op;
    const text = op.patch.text ?? block.text ?? '';
    const width = op.patch.w ?? block.w;
    const style = op.patch.style ? { ...(block.style || {}), ...op.patch.style } : block.style;
    const height = Math.max(24, Math.round(estimateTextHeight(text, width, style)));
    return height > block.h + 2 ? { ...op, patch: { ...op.patch, h: height } } : op;
  });
}

export interface FrameLayoutMetadata {
  mode: CanvasLayoutMode;
  gap?: number;
  columns?: number;
  padding?: number;
}

export function frameLayoutMetadata(frame: HcBlock): FrameLayoutMetadata | null {
  const value = frame.data?.layout;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const mode = record.mode === 'row' || record.mode === 'grid' ? record.mode : 'stack';
  return {
    mode,
    gap: typeof record.gap === 'number' ? record.gap : undefined,
    columns: typeof record.columns === 'number' ? record.columns : undefined,
    padding: typeof record.padding === 'number' ? record.padding : undefined,
  };
}

export function frameChildLayout(frame: HcBlock, children: HcBlock[], metadata: FrameLayoutMetadata): CanvasLayoutPatch[] {
  const padding = Math.max(0, metadata.padding ?? 20);
  return layoutBlocks(children, {
    mode: metadata.mode,
    area: { x: frame.x + padding, y: frame.y + padding, w: Math.max(20, frame.w - padding * 2), h: Math.max(20, frame.h - padding * 2) },
    gap: metadata.gap ?? 16,
    columns: metadata.columns ?? 2,
    stretch: false,
  });
}

export function augmentFrameLayoutOps(doc: { pages: Array<{ id: string; blocks?: HcBlock[] }> }, ops: import('./types.js').HcOp[]): import('./types.js').HcOp[] {
  const extra: import('./types.js').HcOp[] = [];
  for (const op of ops) {
    if (op.op !== 'update_block') continue;
    const patch = op.patch;
    if (patch.w === undefined && patch.h === undefined && patch.x === undefined && patch.y === undefined) continue;
    const page = doc.pages.find(item => item.id === op.pageId);
    const current = page?.blocks?.find(item => item.id === op.blockId);
    if (!page || !current || current.shape !== 'frame') continue;
    const metadata = frameLayoutMetadata({ ...current, ...patch });
    if (!metadata) continue;
    const frame = { ...current, ...patch };
    const children = (page.blocks || []).filter(item => item.frameId === current.id);
    for (const child of frameChildLayout(frame, children, metadata)) {
      const existing = children.find(item => item.id === child.id);
      if (!existing || (existing.x === child.x && existing.y === child.y && existing.w === child.w && existing.h === child.h)) continue;
      extra.push({ op: 'update_block', pageId: page.id, blockId: child.id, patch: { x: child.x, y: child.y, w: child.w, h: child.h } });
    }
  }
  return extra.length ? [...ops, ...extra] : ops;
}
