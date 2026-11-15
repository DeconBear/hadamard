import { describe, expect, it } from 'vitest';
import { buildLayoutRead, buildLintReport } from '../src/hcanvas/agentLayout.js';
import { HCANVAS_SCHEMA, type HcBlock, type HcDocument, type HcPage } from '../src/hcanvas/types.js';

function block(partial: Partial<HcBlock> & Pick<HcBlock, 'id' | 'type' | 'x' | 'y' | 'w' | 'h'>): HcBlock {
  return { z: 0, ...partial };
}

function makeDoc(blocks: HcBlock[], html = ''): HcDocument {
  const page: HcPage = {
    id: 'page_test',
    name: 'Test canvas',
    mode: 'canvas',
    width: 800,
    height: 600,
    background: '#ffffff',
    ...(html ? { html } : {}),
    blocks,
  };
  return {
    schema: HCANVAS_SCHEMA,
    id: 'doc_test',
    title: 'Test',
    revision: 4,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    pages: [page],
    proposals: [],
    history: [],
  };
}

describe('Hcanvas agent layout view', () => {
  it('returns compact page summaries without raw HTML or MathML internals', () => {
    const html = '<div data-hc-id="el_root"><h2 data-hc-id="el_title">Heading</h2><span class="hc-math" data-hc-id="el_formula" data-hc-tex="\\lambda"><span class="katex"><math><annotation>\\lambda</annotation></math></span></span><svg><text data-hc-id="el_svg">λ（波长）</text></svg></div>';
    const doc = makeDoc([block({ id: 'block_html', type: 'html', x: 20, y: 30, w: 500, h: 200, html })], html);
    const result = buildLayoutRead(doc, { pageId: 'page_test' });
    expect(result.format).toBe('layout');
    expect(result.revision).toBe(4);
    expect(result.page?.blocks?.[0]?.preview).toContain('Heading');
    expect(result.page?.blocks?.[0]?.targets?.map(target => target.id)).toEqual(['el_title', 'el_formula', 'el_svg']);
    expect(result.page?.blocks?.[0]?.targets?.some(target => target.tag === 'annotation')).toBe(false);
    expect(result.page?.blocks?.[0]?.targets?.find(target => target.id === 'el_formula')?.tex).toBe('\\lambda');
  });

  it('reports page bounds, overlap and likely text overflow', () => {
    const doc = makeDoc([
      block({ id: 'block_text', type: 'text', x: 20, y: 20, w: 120, h: 24, text: 'A very long text that cannot fit in this small text block at all.' }),
      block({ id: 'block_a', type: 'shape', x: 100, y: 100, w: 200, h: 100 }),
      block({ id: 'block_b', type: 'shape', x: 150, y: 120, w: 200, h: 100 }),
      block({ id: 'block_out', type: 'text', x: 900, y: 700, w: 100, h: 100, text: 'Out' }),
    ]);
    const report = buildLintReport(doc);
    expect(report.summary.errors).toBe(0);
    expect(report.summary.warnings).toBeGreaterThan(0);
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['text-overflow', 'block-overlap', 'block-outside-page']));
  });

  it('respects the block and target limit', () => {
    const blocks = Array.from({ length: 10 }, (_, index) => block({ id: 'block_' + index, type: 'shape', x: index * 10, y: index * 10, w: 10, h: 10 }));
    const result = buildLayoutRead(makeDoc(blocks), { pageId: 'page_test', limit: 3 });
    expect(result.page?.blocks).toHaveLength(3);
    expect(result.page?.hasMoreBlocks).toBe(true);
  });
});
