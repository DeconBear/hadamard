import { describe, expect, it } from 'vitest';

import { constrainLinePoint, shapeDragBounds } from '../src/hcanvas/drawing.js';

describe('hcanvas drawing geometry', () => {
  it('places a useful default shape on click', () => {
    expect(shapeDragBounds({ x: 100, y: 100 }, { x: 101, y: 102 })).toEqual({ x: -20, y: 20, w: 240, h: 160 });
  });

  it('drags in every direction', () => {
    expect(shapeDragBounds({ x: 100, y: 100 }, { x: 40, y: 160 })).toEqual({ x: 40, y: 100, w: 60, h: 60 });
  });

  it('constrains to a square while preserving direction', () => {
    expect(shapeDragBounds({ x: 100, y: 100 }, { x: 40, y: 160 }, { square: true })).toEqual({ x: 40, y: 100, w: 60, h: 60 });
    expect(shapeDragBounds({ x: 100, y: 100 }, { x: 130, y: 40 }, { square: true })).toEqual({ x: 100, y: 40, w: 60, h: 60 });
  });

  it('draws from the center with Alt', () => {
    expect(shapeDragBounds({ x: 100, y: 100 }, { x: 160, y: 130 }, { fromCenter: true })).toEqual({ x: 40, y: 70, w: 120, h: 60 });
  });

  it('snaps lines to 45-degree increments', () => {
    const point = constrainLinePoint({ x: 0, y: 0 }, { x: 100, y: 10 });
    expect(point.x).toBeCloseTo(Math.hypot(100, 10));
    expect(point.y).toBeCloseTo(0);
    const diagonal = constrainLinePoint({ x: 0, y: 0 }, { x: 100, y: 90 });
    expect(diagonal.x).toBeCloseTo(diagonal.y);
  });
});
