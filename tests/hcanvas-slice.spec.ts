import { describe, expect, it } from 'vitest';

import { polygonArea, splitPolygon, type SlicePoint } from '../src/hcanvas/sliceGeometry.js';

const SQUARE: SlicePoint[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

const L_SHAPE: SlicePoint[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 40 },
  { x: 40, y: 40 },
  { x: 40, y: 100 },
  { x: 0, y: 100 },
];

const U_SHAPE: SlicePoint[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 70, y: 100 },
  { x: 70, y: 30 },
  { x: 30, y: 30 },
  { x: 30, y: 100 },
  { x: 0, y: 100 },
];

function sortedAreas(a: SlicePoint[], b: SlicePoint[]): number[] {
  return [polygonArea(a), polygonArea(b)].sort((left, right) => left - right);
}

function bounds(ring: SlicePoint[]): { width: number; height: number } {
  const xs = ring.map(point => point.x);
  const ys = ring.map(point => point.y);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/** Closed rings must not repeat the first point and must not contain near-duplicate neighbors. */
function expectCleanRing(ring: SlicePoint[]): void {
  expect(ring.length).toBeGreaterThanOrEqual(3);
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]!;
    const next = ring[(index + 1) % ring.length]!;
    expect(Math.hypot(current.x - next.x, current.y - next.y)).toBeGreaterThan(1e-6);
  }
}

describe('polygonArea', () => {
  it('is independent of winding direction', () => {
    expect(polygonArea(SQUARE)).toBe(10000);
    expect(polygonArea([...SQUARE].reverse())).toBe(10000);
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 0, y: 100 },
      ]),
    ).toBe(5000);
  });

  it('returns zero for degenerate rings', () => {
    expect(polygonArea([])).toBe(0);
    expect(polygonArea([{ x: 0, y: 0 }])).toBe(0);
    expect(polygonArea([{ x: 0, y: 0 }, { x: 100, y: 0 }])).toBe(0);
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 50, y: 50 },
        { x: 100, y: 100 },
      ]),
    ).toBe(0);
  });
});

describe('splitPolygon', () => {
  it('splits a square with a vertical segment at x=50 into two 50x100 halves', () => {
    const result = splitPolygon(SQUARE, { x: 50, y: -20 }, { x: 50, y: 120 });
    expect(result).not.toBeNull();

    const { a, b } = result!;
    expect(a).toHaveLength(4);
    expect(b).toHaveLength(4);
    expect(polygonArea(a)).toBeCloseTo(5000, 6);
    expect(polygonArea(b)).toBeCloseTo(5000, 6);

    const aBounds = bounds(a);
    const bBounds = bounds(b);
    expect(aBounds.width).toBeCloseTo(50, 6);
    expect(aBounds.height).toBeCloseTo(100, 6);
    expect(bBounds.width).toBeCloseTo(50, 6);
    expect(bBounds.height).toBeCloseTo(100, 6);

    expectCleanRing(a);
    expectCleanRing(b);
  });

  it('splits a square along the diagonal from (0,0) to (100,100)', () => {
    const result = splitPolygon(SQUARE, { x: 0, y: 0 }, { x: 100, y: 100 });
    expect(result).not.toBeNull();

    const { a, b } = result!;
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
    expect(polygonArea(a)).toBeCloseTo(5000, 6);
    expect(polygonArea(b)).toBeCloseTo(5000, 6);
    expectCleanRing(a);
    expectCleanRing(b);
  });

  it('splits a square with a horizontal segment at y=30 into 3000 and 7000', () => {
    const result = splitPolygon(SQUARE, { x: -20, y: 30 }, { x: 120, y: 30 });
    expect(result).not.toBeNull();

    const areas = sortedAreas(result!.a, result!.b);
    expect(areas[0]).toBeCloseTo(3000, 6);
    expect(areas[1]).toBeCloseTo(7000, 6);
    expect(polygonArea(result!.a) + polygonArea(result!.b)).toBeCloseTo(10000, 6);
  });

  it('returns null when the drawn segment misses the polygon', () => {
    expect(splitPolygon(SQUARE, { x: 150, y: -20 }, { x: 150, y: 120 })).toBeNull();
    expect(splitPolygon(SQUARE, { x: -20, y: -20 }, { x: 120, y: -20 })).toBeNull();
    // The infinite line crosses the square, but this segment never touches it.
    expect(splitPolygon(SQUARE, { x: 50, y: -50 }, { x: 50, y: -10 })).toBeNull();
    // A segment inside the U-shaped notch is outside the polygon, so it must not cut.
    expect(splitPolygon(U_SHAPE, { x: 40, y: 60 }, { x: 60, y: 60 })).toBeNull();
  });

  it('cuts along the infinite line when the drawn segment lies inside', () => {
    const result = splitPolygon(SQUARE, { x: 40, y: 50 }, { x: 60, y: 50 });
    expect(result).not.toBeNull();

    const areas = sortedAreas(result!.a, result!.b);
    expect(areas[0]).toBeCloseTo(5000, 6);
    expect(areas[1]).toBeCloseTo(5000, 6);
  });

  it('returns null deterministically when the cut is collinear with an edge', () => {
    expect(splitPolygon(SQUARE, { x: 0, y: 0 }, { x: 100, y: 0 })).toBeNull();
    expect(splitPolygon(SQUARE, { x: 100, y: 0 }, { x: 0, y: 0 })).toBeNull();
    expect(splitPolygon(SQUARE, { x: 0, y: 0 }, { x: 0, y: 100 })).toBeNull();
    expect(splitPolygon(SQUARE, { x: 0, y: 100 }, { x: 100, y: 100 })).toBeNull();
  });

  it('splits a concave polygon without losing area', () => {
    const original = polygonArea(L_SHAPE);
    const result = splitPolygon(L_SHAPE, { x: 20, y: -20 }, { x: 20, y: 120 });
    expect(result).not.toBeNull();

    const { a, b } = result!;
    expectCleanRing(a);
    expectCleanRing(b);
    expect(polygonArea(a)).toBeGreaterThan(0.001);
    expect(polygonArea(b)).toBeGreaterThan(0.001);
    expect(polygonArea(a) + polygonArea(b)).toBeCloseTo(original, 6);
  });

  it('handles a concave cut that leaves two disjoint lobes on one side', () => {
    const original = polygonArea(U_SHAPE);
    const result = splitPolygon(U_SHAPE, { x: -20, y: 50 }, { x: 120, y: 50 });
    expect(result).not.toBeNull();

    const { a, b } = result!;
    expectCleanRing(a);
    expectCleanRing(b);
    expect(polygonArea(a) + polygonArea(b)).toBeCloseTo(original, 6);
  });

  it('produces the same split for either winding direction', () => {
    const clockwise = [...SQUARE].reverse();
    const result = splitPolygon(clockwise, { x: 50, y: -20 }, { x: 50, y: 120 });
    expect(result).not.toBeNull();

    const areas = sortedAreas(result!.a, result!.b);
    expect(areas[0]).toBeCloseTo(5000, 6);
    expect(areas[1]).toBeCloseTo(5000, 6);
  });

  it('rounds cut intersections to three decimal places', () => {
    const cutY = 100 / 3;
    const result = splitPolygon(SQUARE, { x: -10, y: cutY }, { x: 110, y: cutY });
    expect(result).not.toBeNull();

    const { a, b } = result!;
    const cutPoints = [...a, ...b].filter(point => point.y > 0 && point.y < 100);
    expect(cutPoints.length).toBeGreaterThanOrEqual(2);
    for (const point of cutPoints) {
      expect(point.y).toBe(33.333);
      expect(Math.abs(point.y * 1000 - Math.round(point.y * 1000))).toBeLessThan(1e-9);
    }

    expect(polygonArea(a) + polygonArea(b)).toBeCloseTo(10000, 6);
    expect(Math.min(polygonArea(a), polygonArea(b))).toBeCloseTo(3333.3, 3);
  });

  it('accepts a ring that repeats its first point', () => {
    const closed = [...SQUARE, { x: 0, y: 0 }];
    const result = splitPolygon(closed, { x: 50, y: -20 }, { x: 50, y: 120 });
    expect(result).not.toBeNull();
    expect(polygonArea(result!.a)).toBeCloseTo(5000, 6);
    expect(polygonArea(result!.b)).toBeCloseTo(5000, 6);
  });

  it('returns null for degenerate polygons and zero-length cuts', () => {
    expect(splitPolygon([], { x: 0, y: 0 }, { x: 100, y: 100 })).toBeNull();
    expect(
      splitPolygon(
        [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
        { x: 50, y: -10 },
        { x: 50, y: 10 },
      ),
    ).toBeNull();
    expect(splitPolygon(SQUARE, { x: 50, y: 50 }, { x: 50, y: 50 })).toBeNull();
  });
});
