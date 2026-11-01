import { describe, expect, it } from 'vitest';

import { anchorOnBlock, boundArrowGeometry, findBindingTarget } from '../src/hcanvas/bindings.js';
import type { HcBlock } from '../src/hcanvas/types.js';

function shape(id: string, x: number, y: number, w = 200, h = 100, z = 0): HcBlock {
  return { id, type: 'shape', shape: 'rect', x, y, w, h, z };
}

describe('hcanvas native arrow bindings', () => {
  it('finds the topmost block under a padded point', () => {
    const blocks = [shape('a', 100, 100), shape('b', 500, 100, 200, 100, 4)];
    expect(findBindingTarget(blocks, 490, 150)?.id).toBe('b');
    expect(findBindingTarget(blocks, 50, 50)).toBeNull();
  });

  it('anchors both endpoints to block edges and updates the arrow bounds', () => {
    const left = shape('left', 100, 100);
    const right = shape('right', 500, 100);
    const arrow: HcBlock = { id: 'arrow', type: 'arrow', x: 280, y: 120, w: 240, h: 40, z: 5, points: [{ x: 18, y: 18 }, { x: 258, y: 58 }], startBinding: 'left', endBinding: 'right' };
    expect(anchorOnBlock(left, 600, 150)).toEqual({ x: 300, y: 150 });
    const geometry = boundArrowGeometry(arrow, [left, right]);
    expect(geometry).toBeTruthy();
    expect(geometry!.points.length).toBe(2);
    expect(geometry!.points[0]!.x + geometry!.x).toBe(300);
    expect(geometry!.points[1]!.x + geometry!.x).toBe(500);
    expect(geometry!.clearStart).toBe(false);
  });

  it('reports missing binding targets for cleanup', () => {
    const arrow: HcBlock = { id: 'arrow', type: 'arrow', x: 0, y: 0, w: 100, h: 100, z: 1, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }], startBinding: 'gone', endBinding: null };
    const geometry = boundArrowGeometry(arrow, []);
    expect(geometry?.clearStart).toBe(true);
  });
});
