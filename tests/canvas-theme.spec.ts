import { describe, expect, it } from 'vitest';
import { getCanvasTheme, themeOps } from '../src/hcanvas/canvasTheme.js';
import { insertCanvasComponent } from '../src/hcanvas/canvasComponents.js';
import type { HcBlock, HcPage } from '../src/hcanvas/types.js';

const page: HcPage = { id: 'page', name: 'Page', mode: 'canvas', width: 800, height: 600, background: '#fff', blocks: [] };
const text: HcBlock = { id: 'text', type: 'text', x: 0, y: 0, w: 100, h: 30, z: 0, text: 'Hi', style: {} };
const shape: HcBlock = { id: 'shape', type: 'shape', shape: 'rect', x: 0, y: 0, w: 100, h: 30, z: 1, style: {} };

describe('Canvas themes and components', () => {
  it('applies theme tokens to page and blocks', () => {
    const theme = getCanvasTheme('neon')!;
    const ops = themeOps(page, [text, shape], theme);
    expect(ops[0]).toMatchObject({ op: 'update_page', patch: { background: theme.background } });
    expect(ops.some(op => op.op === 'update_block' && op.blockId === 'text' && (op.patch.style as { color?: string }).color === theme.text)).toBe(true);
    expect(ops.some(op => op.op === 'update_block' && op.blockId === 'shape' && (op.patch.style as { stroke?: string }).stroke === theme.stroke)).toBe(true);
  });

  it('creates independent component instances with new ids and offset', () => {
    let index = 0;
    const blocks = insertCanvasComponent({ id: 'component_1', name: 'Card', createdAt: '', blocks: [text, shape] }, () => 'block_' + (++index), 24);
    expect(blocks.map(block => block.id)).toEqual(['block_1', 'block_2']);
    expect(blocks[0]?.x).toBe(24);
    expect(blocks[0]?.y).toBe(24);
  });
});
