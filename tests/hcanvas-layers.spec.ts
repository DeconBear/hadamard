import { describe, expect, it } from 'vitest';
import { orderedLayers } from '../src/hcanvas/client/layersPanel.js';
import type { HcPage } from '../src/hcanvas/types.js';

function page(blocks: any[]): HcPage {
  return { id: 'page_test', name: 'Layers', mode: 'canvas', width: 100, height: 100, background: '#fff', blocks };
}

describe('hcanvas layers panel ordering', () => {
  it('lists blocks from top z to bottom z', () => {
    const layers = orderedLayers(page([
      { id: 'a', type: 'text', x: 0, y: 0, w: 10, h: 10, z: 2 },
      { id: 'b', type: 'shape', x: 0, y: 0, w: 10, h: 10, z: 9 },
      { id: 'c', type: 'curve', x: 0, y: 0, w: 10, h: 10, z: 5 },
    ]));
    expect(layers.map(block => block.id)).toEqual(['b', 'c', 'a']);
  });

  it('handles an empty page', () => {
    expect(orderedLayers(page([]))).toEqual([]);
  });
});
