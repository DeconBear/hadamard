import { describe, expect, it } from 'vitest';
import { routeArrowGeometry } from '../src/hcanvas/arrowRouting.js';
import { boundArrowGeometry } from '../src/hcanvas/bindings.js';
import type { HcBlock } from '../src/hcanvas/types.js';

const shape = (id: string, x: number, y: number, w = 120, h = 80): HcBlock => ({ id, type: 'shape', shape: 'rect', x, y, w, h, z: 0 });
const arrow = (patch: Partial<HcBlock> = {}): HcBlock => ({ id: 'arrow', type: 'arrow', x: 0, y: 0, w: 10, h: 10, z: 1, startBinding: 'a', endBinding: 'b', ...patch });

describe('Canvas smart connectors', () => {
  it('chooses facing ports and routes orthogonally', () => {
    const blocks = [shape('a', 0, 0), shape('b', 400, 220)];
    const geometry = routeArrowGeometry(arrow({ connectorRoute: 'orthogonal' }), blocks);
    expect(geometry).not.toBeNull();
    expect(geometry!.points.length).toBeGreaterThanOrEqual(2);
    expect(geometry!.x).toBeLessThanOrEqual(120);
    expect(geometry!.y).toBeLessThanOrEqual(40);
  });

  it('supports custom anchors and labels metadata', () => {
    const blocks = [shape('a', 0, 0), shape('b', 400, 220)];
    const geometry = boundArrowGeometry(arrow({ startPort: 'top', endPort: 'left', connectorRoute: 'straight' }), blocks);
    expect(geometry).not.toBeNull();
    expect(geometry!.points[0]).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
  });

  it('avoids a blocking rectangle when possible', () => {
    const blocks = [shape('a', 0, 0), shape('b', 460, 0), shape('obstacle', 210, -50, 40, 180)];
    const geometry = routeArrowGeometry(arrow({ connectorRoute: 'orthogonal' }), blocks);
    expect(geometry).not.toBeNull();
    const crossesObstacle = geometry!.points.some((point, index, all) => {
      const next = all[index + 1];
      if (!next) return false;
      const absolute = { x: geometry!.x + point.x, y: geometry!.y + point.y };
      const absoluteNext = { x: geometry!.x + next.x, y: geometry!.y + next.y };
      if (absolute.x === absoluteNext.x) return absolute.x > 200 && absolute.x < 260 && Math.max(absolute.y, absoluteNext.y) > -50 && Math.min(absolute.y, absoluteNext.y) < 130;
      return false;
    });
    expect(crossesObstacle).toBe(false);
  });
});
