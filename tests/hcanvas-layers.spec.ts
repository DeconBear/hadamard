import { describe, expect, it } from 'vitest';
import { blocksInStackOrder, effectiveLayers, isBlockLocked, DEFAULT_LAYER_ID } from '../src/hcanvas/layers.js';
import type { HcPage } from '../src/hcanvas/types.js';

function page(blocks: any[], layers?: any[]): HcPage {
  return { id: 'page_test', name: 'Layers', mode: 'canvas', width: 100, height: 100, background: '#fff', blocks, ...(layers ? { layers } : {}) };
}

describe('hcanvas layers model', () => {
  it('falls back to an implicit default layer', () => {
    const model = page([{ id: 'a', type: 'text', x: 0, y: 0, w: 10, h: 10, z: 2 }]);
    expect(effectiveLayers(model).map(layer => layer.id)).toEqual([DEFAULT_LAYER_ID]);
    expect(blocksInStackOrder(model).map(block => block.id)).toEqual(['a']);
  });

  it('orders blocks by layer order and then local z', () => {
    const model = page([
      { id: 'a', type: 'text', x: 0, y: 0, w: 10, h: 10, z: 9, layerId: 'bottom' },
      { id: 'b', type: 'text', x: 0, y: 0, w: 10, h: 10, z: 1, layerId: 'top' },
      { id: 'c', type: 'text', x: 0, y: 0, w: 10, h: 10, z: 2, layerId: 'bottom' },
    ], [
      { id: 'bottom', name: 'Bottom', visible: true, locked: false },
      { id: 'top', name: 'Top', visible: true, locked: false },
    ]);
    expect(blocksInStackOrder(model).map(block => block.id)).toEqual(['c', 'a', 'b']);
  });

  it('omits hidden layers and reports locked layers', () => {
    const model = page([
      { id: 'hidden', type: 'text', x: 0, y: 0, w: 10, h: 10, z: 2, layerId: 'hidden' },
      { id: 'locked', type: 'text', x: 0, y: 0, w: 10, h: 10, z: 1, layerId: 'locked' },
    ], [
      { id: 'hidden', name: 'Hidden', visible: false, locked: false },
      { id: 'locked', name: 'Locked', visible: true, locked: true },
    ]);
    expect(blocksInStackOrder(model).map(block => block.id)).toEqual(['locked']);
    expect(isBlockLocked(model, model.blocks![1]!)).toBe(true);
  });
});
