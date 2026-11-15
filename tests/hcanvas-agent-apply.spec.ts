import { describe, expect, it } from 'vitest';
import { compactApplyResult } from '../src/hcanvas/agentApply.js';
import { HCANVAS_SCHEMA, type HcDocument } from '../src/hcanvas/types.js';

const doc: HcDocument = {
  schema: HCANVAS_SCHEMA,
  id: 'doc_test',
  title: 'Test',
  revision: 7,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  pages: [{ id: 'page_1', name: 'Page 1', mode: 'canvas', width: 800, height: 600, background: '#fff', blocks: [] }],
  proposals: [],
  history: [],
};

describe('Hcanvas compact apply response', () => {
  it('summarizes created and updated ids without the full document', () => {
    const result = compactApplyResult(doc, [
      { op: 'add_page', page: { id: 'page_2', name: 'Page 2', mode: 'infinite', width: 1200, height: 800, background: '#fff' } },
      { op: 'add_block', pageId: 'page_1', block: { id: 'block_1', type: 'text', x: 0, y: 0, w: 100, h: 20, z: 0, text: 'Hi' } },
      { op: 'set_page_html', pageId: 'page_1', html: '<p>Hello</p>' },
      { op: 'html_patch', pageId: 'page_1', patches: [{ op: 'set_text', target: 'el_1', text: 'Hi' }] },
    ], { summary: 'test' });
    expect(result.docId).toBe('doc_test');
    expect(result.revision).toBe(7);
    expect(result.createdPageIds).toEqual(['page_2']);
    expect(result.createdBlockIds).toEqual(['block_1']);
    expect(result.updatedPageIds).toContain('page_1');
    expect(result.changedElementIds).toEqual(['el_1']);
    expect(result.pages[0]?.blocks).toBe(0);
    expect((result as unknown as { doc?: unknown }).doc).toBeUndefined();
  });
});
