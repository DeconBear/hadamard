import { describe, expect, it } from 'vitest';
import { blockFill, gradientCss, gradientSvgDefs, normalizeGradient } from '../src/hcanvas/fill.js';
import { shapeSvgMarkup } from '../src/hcanvas/shapes.js';
import type { HcBlock } from '../src/hcanvas/types.js';

const gradient = { type: 'linear' as const, angle: 90, stops: [{ offset: 0, color: '#ff3d7f' }, { offset: 1, color: '#8b5cf6' }] };
const block: HcBlock = { id: 'block_paint', type: 'shape', shape: 'rect', x: 0, y: 0, w: 100, h: 100, z: 1, fillGradient: gradient, style: { fill: '#ffffff' } };

describe('hcanvas paint fill', () => {
  it('normalizes linear gradients and emits SVG defs', () => {
    expect(normalizeGradient(gradient)?.stops).toHaveLength(2);
    expect(gradientSvgDefs(block)).toContain('<linearGradient');
    expect(blockFill(block)).toBe('url(#paint-block_paint)');
    expect(gradientCss(gradient)).toContain('linear-gradient');
  });
  it('renders a gradient fill into shape SVG', () => {
    const svg = shapeSvgMarkup(block);
    expect(svg).toContain('<linearGradient');
    expect(svg).toContain('url(#paint-block_paint)');
  });
});
