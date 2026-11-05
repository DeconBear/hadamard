import { describe, expect, it } from 'vitest';

import {
  cubicCurveFromSamples,
  curveGeometry,
  curveLocalToWorld,
  curveWorldToLocal,
  deleteCurveAnchor,
  nearestCurveSegment,
  splitCurvePoints,
} from '../src/hcanvas/curves.js';
import type { HcBlock, HcPoint } from '../src/hcanvas/types.js';

describe('hcanvas Bezier geometry', () => {
  it('fits the sampled bow without exaggerating its midpoint', () => {
    const curve = cubicCurveFromSamples([{ x: 0, y: 0 }, { x: 50, y: 20 }, { x: 100, y: 0 }]);
    expect(curve).toHaveLength(4);
    const midpoint = splitCurvePoints(curve, 0, 0.5)[3]!;
    expect(midpoint.x).toBeCloseTo(50);
    expect(midpoint.y).toBeCloseTo(20);
  });

  it('round-trips local points through rotation and mirroring', () => {
    const block: HcBlock = { id: 'curve', type: 'curve', x: 100, y: 200, w: 200, h: 100, z: 0, rotation: 93, style: { flipX: true, flipY: true } };
    const local = { x: 23, y: 31 };
    const transformed = curveWorldToLocal(block, curveLocalToWorld(block, local));
    expect(transformed.x).toBeCloseTo(local.x, 8);
    expect(transformed.y).toBeCloseTo(local.y, 8);
  });

  it('splits a cubic at the requested point', () => {
    const points = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }];
    const split = splitCurvePoints(points, 0, 0.5);
    expect(split).toHaveLength(7);
    expect(split[3]).toEqual({ x: 50, y: 0 });
    expect(nearestCurveSegment(split, { x: 50, y: 2 })?.segment).toBe(0);
  });

  it('deletes first, interior and last anchors while retaining valid cubics', () => {
    const points: HcPoint[] = Array.from({ length: 10 }, (_, x) => ({ x, y: x * 2 }));
    expect(deleteCurveAnchor(points, 0)?.map(point => point.x)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(deleteCurveAnchor(points, 3)?.map(point => point.x)).toEqual([0, 1, 5, 6, 7, 8, 9]);
    expect(deleteCurveAnchor(points, 9)?.map(point => point.x)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(deleteCurveAnchor(points.slice(0, 4), 0)).toBeNull();
    expect(deleteCurveAnchor(points, 1)).toBeNull();
  });

  it('normalizes edited points with stroke-safe padding', () => {
    const block: HcBlock = { id: 'curve', type: 'curve', x: 100, y: 100, w: 100, h: 20, z: 0, style: { strokeWidth: 2 } };
    const geometry = curveGeometry(block, [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }]);
    expect(geometry).toMatchObject({ x: 96, y: 96, w: 108, h: 8 });
    expect(geometry.points[0]).toEqual({ x: 4, y: 4 });
    expect(geometry.points[3]).toEqual({ x: 104, y: 4 });
  });
});
