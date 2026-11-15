import { describe, expect, it } from 'vitest';
import { autoHeightForText, augmentFrameLayoutOps, distributeBlocks, estimateTextHeight, frameChildLayout, layoutBlocks, layoutIssues } from '../src/hcanvas/canvasLayout.js';
import type { HcBlock } from '../src/hcanvas/types.js';

const block = (id: string, x: number, y: number, w: number, h: number, text = 'Text'): HcBlock => ({ id, type: 'text', x, y, w, h, z: 0, text, style: { fontSize: 16 } });

describe('Canvas auto layout', () => {
  it('stacks selected blocks and preserves heights', () => {
    const patches = layoutBlocks([block('a', 40, 40, 200, 40), block('b', 80, 120, 160, 50)], { mode: 'stack', area: { x: 40, y: 40, w: 300, h: 200 }, gap: 10, stretch: false });
    expect(patches[0]).toMatchObject({ id: 'a', x: 40, y: 40, w: 200 });
    expect(patches[1]).toMatchObject({ id: 'b', x: 40, y: 90, w: 160 });
  });

  it('lays out a grid with equal cells', () => {
    const patches = layoutBlocks([block('a', 0, 0, 100, 40), block('b', 0, 0, 100, 40), block('c', 0, 0, 100, 40)], { mode: 'grid', area: { x: 20, y: 20, w: 420, h: 300 }, gap: 20, columns: 2 });
    expect(patches[0]).toMatchObject({ x: 20, y: 20, w: 200 });
    expect(patches[1]).toMatchObject({ x: 240, y: 20, w: 200 });
    expect(patches[2]).toMatchObject({ x: 20, w: 200 });
    expect(patches[2]!.y).toBeGreaterThan(60);
  });

  it('preserves block widths in a non-stretching grid', () => {
    const patches = layoutBlocks([block('a', 0, 0, 100, 40), block('b', 0, 0, 100, 40)], { mode: 'grid', area: { x: 20, y: 20, w: 200, h: 200 }, gap: 20, columns: 2, stretch: false });
    expect(patches.map(patch => patch.w)).toEqual([100, 100]);
  });

  it('distributes blocks and estimates text height', () => {
    const patches = distributeBlocks([block('a', 0, 0, 100, 20), block('b', 200, 0, 100, 20), block('c', 500, 0, 100, 20)], 'horizontal');
    expect(patches.map(patch => patch.x)).toEqual([0, 250, 500]);
    expect(estimateTextHeight('A long line of text that should wrap', 120, { fontSize: 16 })).toBeGreaterThan(16);
    expect(autoHeightForText(block('a', 0, 0, 120, 20, 'A long line of text that should wrap'))).toBeGreaterThan(20);
  });

  it('reflows frame children when the frame is resized', () => {
    const frame: HcBlock = { id: 'frame', type: 'shape', shape: 'frame', x: 100, y: 100, w: 500, h: 400, z: 0, data: { layout: { mode: 'grid', gap: 10, padding: 20, columns: 2 } } };
    const children = [block('child-a', 120, 120, 100, 40), block('child-b', 120, 200, 100, 40)].map(item => ({ ...item, frameId: 'frame' }));
    const doc = { pages: [{ id: 'page', blocks: [frame, ...children] }] };
    const ops = augmentFrameLayoutOps(doc, [{ op: 'update_block', pageId: 'page', blockId: 'frame', patch: { w: 700 } }]);
    expect(ops.some(op => op.op === 'update_block' && op.blockId === 'child-b')).toBe(true);
    expect(frameChildLayout({ ...frame, w: 700 }, children, { mode: 'grid', gap: 10, padding: 20, columns: 2 }).length).toBe(2);
  });

  it('reports out-of-page, overlap and text overflow issues', () => {
    const issues = layoutIssues([
      block('a', 10, 10, 200, 20, 'A very long text that cannot fit in this small box at all'),
      block('b', 150, 15, 200, 20, 'Overlap'),
      block('c', 900, 700, 100, 100, 'Outside'),
    ], 800, 600, 'canvas');
    expect(issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['outside-page', 'overlap', 'text-overflow']));
  });
});
