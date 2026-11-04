import { describe, expect, it } from 'vitest';
import { HCANVAS_SHAPE_CATEGORIES, HCANVAS_SHAPES, isHcShape, shapeSvgMarkup } from '../src/hcanvas/shapes.js';
import type { HcBlock, HcShape } from '../src/hcanvas/types.js';

const visibleShapes = HCANVAS_SHAPES.filter(shape => !shape.hidden);
const LEGACY_SHAPES = new Set<HcShape>(['rect', 'ellipse', 'diamond', 'triangle', 'parallelogram', 'trapezoid', 'hexagon', 'octagon', 'star', 'cross', 'line', 'frame']);

function block(patch: Partial<HcBlock> = {}): HcBlock {
  return { id: 'block_shape', type: 'shape', x: 0, y: 0, w: 240, h: 160, z: 1, ...patch };
}

function shapeGeometry(markup: string): string {
  const match = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(markup);
  return match?.[1] ?? '';
}

function hasElement(geometry: string, tags: string[]): boolean {
  return tags.some(tag => geometry.includes('<' + tag + ' '));
}

describe('hcanvas shape definitions', () => {
  it('keeps every shape id unique', () => {
    const ids = HCANVAS_SHAPES.map(shape => shape.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('categorizes every visible shape and exposes at least 25 user-facing shapes', () => {
    expect(visibleShapes.length).toBeGreaterThanOrEqual(25);
    expect(new Set(visibleShapes.map(shape => shape.category)).size).toBeGreaterThanOrEqual(3);

    const knownCategories = new Set<string>(HCANVAS_SHAPE_CATEGORIES);
    expect(knownCategories.size).toBe(HCANVAS_SHAPE_CATEGORIES.length);

    for (const shape of visibleShapes) {
      expect(knownCategories.has(shape.category)).toBe(true);
      expect(shape.label.length).toBeGreaterThan(0);
      expect(shape.hint.length).toBeGreaterThan(0);
    }
  });

  it('keeps the existing ids available for backward compatibility', () => {
    const ids = new Set(HCANVAS_SHAPES.map(shape => shape.id));
    for (const legacy of LEGACY_SHAPES) expect(ids.has(legacy)).toBe(true);
    expect(isHcShape('rect')).toBe(true);
    expect(isHcShape('not-a-shape')).toBe(false);
  });

  it('hides the internal polygon shape from the visible picker filter', () => {
    const polygon = HCANVAS_SHAPES.find(shape => shape.id === 'polygon');
    expect(polygon).toBeDefined();
    expect(polygon?.hidden).toBe(true);
    expect(polygon?.category).toBeTruthy();
    expect(isHcShape('polygon')).toBe(true);

    const visiblePickerShapes = HCANVAS_SHAPES.filter(shape => !shape.hidden);
    expect(visiblePickerShapes.map(shape => shape.id)).not.toContain('polygon');
  });
});

describe('hcanvas shape rendering', () => {
  it('returns a complete svg with non-empty geometry for every visible shape', () => {
    const failures = visibleShapes.filter(shape => {
      const markup = shapeSvgMarkup(block({ shape: shape.id }));
      return !markup.startsWith('<svg ') || !markup.endsWith('</svg>') || shapeGeometry(markup).trim() === '';
    }).map(shape => shape.id);
    expect(failures).toEqual([]);
  });

  it('renders a known svg element for every visible shape', () => {
    const failures = visibleShapes.filter(shape => {
      const geometry = shapeGeometry(shapeSvgMarkup(block({ shape: shape.id })));
      return !hasElement(geometry, ['polygon', 'path', 'circle', 'rect', 'line', 'ellipse']);
    }).map(shape => shape.id);
    expect(failures).toEqual([]);
  });

  it('renders polygon/path/circle/rect/line geometry for the new shapes', () => {
    const newShapes = visibleShapes.filter(shape => !LEGACY_SHAPES.has(shape.id));
    expect(newShapes.length).toBeGreaterThanOrEqual(25);
    const failures = newShapes.filter(shape => {
      const geometry = shapeGeometry(shapeSvgMarkup(block({ shape: shape.id })));
      return !hasElement(geometry, ['polygon', 'path', 'circle', 'rect', 'line']);
    }).map(shape => shape.id);
    expect(failures).toEqual([]);
  });

  it('uses block.points normalized by block width and height for polygon', () => {
    const markup = shapeSvgMarkup({
      shape: 'polygon',
      w: 240,
      h: 160,
      points: [{ x: 0, y: 0 }, { x: 240, y: 0 }, { x: 120, y: 160 }],
      style: { fill: '#ffffff' },
    });
    expect(markup).toContain('<polygon points="0.00,0.00 100.00,0.00 50.00,100.00"');
    expect(markup).not.toContain('240.00');
    expect(shapeGeometry(markup)).not.toContain('<rect ');
  });

  it('preserves fill, stroke, dash and opacity on new shapes', () => {
    const markup = shapeSvgMarkup({
      shape: 'heart',
      style: { fill: '#ffeeaa', stroke: '#123456', strokeWidth: 2, strokeStyle: 'dashed', opacity: 0.5 },
    });
    expect(markup).toContain('fill="#ffeeaa"');
    expect(markup).toContain('stroke="#123456"');
    expect(markup).toContain('stroke-width="2"');
    expect(markup).toContain('stroke-dasharray="7 5"');
    expect(markup).toContain('opacity="0.5"');
  });

  it('keeps the special line and frame rendering', () => {
    const line = shapeSvgMarkup({
      shape: 'line',
      w: 200,
      h: 100,
      points: [{ x: 0, y: 100 }, { x: 200, y: 0 }],
      style: { stroke: '#000000', strokeWidth: 2 },
    });
    expect(shapeGeometry(line)).toContain('<line ');
    expect(shapeGeometry(line)).toContain('x1="0.00"');
    expect(shapeGeometry(line)).toContain('x2="100.00"');

    const frame = shapeSvgMarkup({ shape: 'frame', style: { fill: '#ffffff' } });
    expect(frame).toContain('fill="none"');
    expect(frame).toContain('stroke-dasharray="7 5"');
  });
});
