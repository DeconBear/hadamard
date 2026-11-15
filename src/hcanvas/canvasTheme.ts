import type { HcBlock, HcOp, HcPage } from './types.js';

export interface CanvasThemeTokens {
  id: 'neon' | 'paper' | 'mono';
  name: string;
  background: string;
  text: string;
  muted: string;
  fill: string;
  stroke: string;
  accent: string;
  fontFamily: string;
}

export const CANVAS_THEMES: CanvasThemeTokens[] = [
  { id: 'neon', name: 'Neon', background: '#050711', text: '#f5f7ff', muted: '#94a3c7', fill: '#0b1427', stroke: '#5eead4', accent: '#8b5cf6', fontFamily: 'Inter, Segoe UI, sans-serif' },
  { id: 'paper', name: 'Paper', background: '#fbfaf7', text: '#1f2430', muted: '#6b7280', fill: '#ffffff', stroke: '#d9d3c7', accent: '#6d5bd0', fontFamily: 'Inter, Segoe UI, sans-serif' },
  { id: 'mono', name: 'Mono', background: '#ffffff', text: '#111827', muted: '#6b7280', fill: '#f3f4f6', stroke: '#9ca3af', accent: '#374151', fontFamily: 'Inter, Segoe UI, sans-serif' },
];

export function getCanvasTheme(id: string): CanvasThemeTokens | null {
  return CANVAS_THEMES.find(theme => theme.id === id) || null;
}

export function themeOps(page: HcPage, blocks: HcBlock[], theme: CanvasThemeTokens): HcOp[] {
  const ops: HcOp[] = [{ op: 'update_page', pageId: page.id, patch: { background: theme.background } }];
  for (const block of blocks) {
    const style = { ...(block.style || {}) };
    if (block.type === 'text') style.color = theme.text;
    else if (block.type === 'markdown') { style.color = theme.text; style.fill = theme.fill; }
    else if (block.type === 'shape') { style.fill = theme.fill; style.stroke = theme.stroke; }
    else if (block.type === 'arrow') { style.stroke = theme.stroke; }
    else if (block.type === 'code') { style.fill = theme.fill; style.color = theme.text; }
    else continue;
    style.fontFamily = theme.fontFamily;
    ops.push({ op: 'update_block', pageId: page.id, blockId: block.id, patch: { style } });
  }
  return ops;
}
