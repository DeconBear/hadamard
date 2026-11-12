import { describe, expect, it } from 'vitest';
import { resizeBoxFromPointer } from '../src/hcanvas/client/resizeHandle.js';

describe('rotated resize geometry', () => {
  it('keeps the opposite edge anchored for axis-aligned blocks', () => {
    expect(resizeBoxFromPointer({ x: 100, y: 100, w: 200, h: 100 }, 'e', 50, 0)).toEqual({ x: 100, y: 100, w: 250, h: 100 });
    expect(resizeBoxFromPointer({ x: 100, y: 100, w: 200, h: 100 }, 'w', 50, 0)).toEqual({ x: 150, y: 100, w: 150, h: 100 });
  });

  it('uses the block local axes after rotation', () => {
    // An east handle on a 90° rotated block points down the screen.
    const next = resizeBoxFromPointer({ x: 100, y: 100, w: 200, h: 100, rotation: 90 }, 'e', 0, 50);
    expect(next.w).toBe(250);
    expect(next.h).toBe(100);
    expect(Math.round(next.x)).toBe(75);
    expect(Math.round(next.y)).toBe(125);
  });

  it('keeps the center fixed for symmetric resize', () => {
    expect(resizeBoxFromPointer({ x: 100, y: 100, w: 200, h: 100 }, 'e', 50, 0, { center: true })).toEqual({ x: 75, y: 100, w: 250, h: 100 });
  });

  it('clamps to the minimum size', () => {
    const next = resizeBoxFromPointer({ x: 100, y: 100, w: 200, h: 100 }, 'w', 500, 0);
    expect(next.w).toBe(40);
  });
});
