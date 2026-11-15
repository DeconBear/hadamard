import { describe, expect, it } from 'vitest';
import { compileScene, estimateTextHeight } from '../src/hcanvas/composeScene.js';
import { getComposeTemplate, listComposeTemplates } from '../src/hcanvas/composeTemplates.js';

describe('Hcanvas compose scene compiler', () => {
  it('lays out a stack with measured text heights and no spacer block', () => {
    const result = compileScene({
      title: 'Deck',
      width: 1280,
      height: 720,
      pages: [{
        name: 'Cover',
        layout: 'stack',
        padding: 64,
        gap: 20,
        blocks: [
          { type: 'heading', text: 'Title' },
          { type: 'text', text: 'Subtitle' },
          { type: 'spacer', h: 30 },
          { type: 'divider' },
        ],
      }],
    });
    const page = result.pages[0]!;
    const blocks = page.blocks || [];
    expect(result.title).toBe('Deck');
    expect(page.name).toBe('Cover');
    expect(blocks.map(block => block.type)).toEqual(['text', 'text', 'shape']);
    expect(blocks[0]?.x).toBe(64);
    expect(blocks[0]?.y).toBe(64);
    expect(blocks[1]?.y).toBeGreaterThan(blocks[0]!.y + blocks[0]!.h);
    expect(new Set(blocks.map(block => block.id)).size).toBe(blocks.length);
    expect(result.firstPreset.blocks).toHaveLength(3);
  });

  it('places grid blocks with span-aware widths', () => {
    const result = compileScene({
      pages: [{
        layout: 'grid',
        columns: 2,
        padding: 40,
        gap: 20,
        blocks: [
          { type: 'heading', text: 'Wide', span: 2 },
          { type: 'text', text: 'Left' },
          { type: 'text', text: 'Right' },
        ],
      }],
    });
    const blocks = result.pages[0]!.blocks || [];
    expect(blocks[0]?.w).toBe(1200);
    expect(blocks[0]?.x).toBe(40);
    expect(blocks[1]?.y).toBeGreaterThan(blocks[0]!.y);
    expect(blocks[1]?.x).toBe(40);
    expect(blocks[2]?.x).toBeGreaterThan(blocks[1]!.x);
  });

  it('supports free layout, auto height, HTML and Markdown pages', () => {
    const result = compileScene({
      pages: [
        { layout: 'free', autoHeight: true, width: 800, height: 120, blocks: [{ type: 'text', text: 'Absolutely placed', x: 40, y: 40, w: 300, h: 80 }] },
        { mode: 'html', markdown: '# Markdown page' },
      ],
    });
    expect(result.pages[0]!.height).toBeGreaterThan(120);
    expect(result.pages[0]!.blocks?.[0]?.x).toBe(40);
    const origin = compileScene({ pages: [{ layout: 'free', blocks: [{ type: 'text', text: 'At origin', x: 0, y: 0, w: 100, h: 20 }] }] });
    expect(origin.pages[0]!.blocks?.[0]).toMatchObject({ x: 0, y: 0 });
    expect(result.pages[1]?.mode).toBe('html');
    expect(result.pages[1]?.markdown).toContain('# Markdown page');
    expect(result.pages[1]?.html).toContain('<h1');
  });

  it('auto-fits text and routes arrows between explicit block ids', () => {
    const result = compileScene({
      pages: [{
        layout: 'free',
        blocks: [
          { type: 'text', id: 'a', text: 'This is a long label that will need a smaller font size', x: 40, y: 40, w: 120, h: 36, fontSize: 36, autoFit: true },
          { type: 'shape', id: 'b', shape: 'rect', x: 400, y: 240, w: 120, h: 80 },
          { type: 'arrow', id: 'link', from: 'a', to: 'b', route: 'orthogonal' },
        ],
      }],
    });
    const blocks = result.pages[0]!.blocks || [];
    const text = blocks.find(block => block.id === 'a');
    const arrow = blocks.find(block => block.id === 'link');
    expect(text?.style?.fontSize).toBeLessThan(36);
    expect(arrow).toMatchObject({ type: 'arrow', startBinding: 'a', endBinding: 'b' });
    expect(arrow?.points).toHaveLength(4);
    expect(arrow?.w).toBeGreaterThan(0);
    expect(arrow?.h).toBeGreaterThan(0);
  });

  it('ships compilable built-in templates', () => {
    const templates = listComposeTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(5);
    for (const template of templates) {
      const scene = getComposeTemplate(template.id)!.scene;
      const result = compileScene(scene);
      expect(result.pages.length).toBeGreaterThan(0);
    }
  });

  it('estimates text height from width and font size', () => {
    expect(estimateTextHeight('A long line of text that wraps across several lines', 180, 18)).toBeGreaterThan(18 * 1.45);
  });
});
