import { describe, expect, it } from 'vitest';
import { applyOpsToDocument } from '../src/hcanvas/store.js';
import type { HcDocument, HcPage } from '../src/hcanvas/types.js';

function baseDoc(pages: HcPage[]): HcDocument {
  return {
    schema: 'hadamard-canvas/1',
    id: 'doc_test',
    title: 'Test',
    revision: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    pages,
    proposals: [],
    history: [],
  };
}

function canvasPage(): HcPage {
  return { id: 'page_a', name: 'A', mode: 'canvas', width: 1280, height: 720, background: '#fff', blocks: [] };
}

describe('extension page model', () => {
  it('adds an extension page and preserves its format/data', () => {
    const doc = applyOpsToDocument(baseDoc([canvasPage()]), [{
      op: 'add_page',
      page: { id: 'page_ext', name: 'Board', mode: 'extension', width: 1280, height: 800, background: '#fff', extension: { format: 'demo-board', data: { columns: [] } } },
    }]);
    const page = doc.pages[1]!;
    expect(page.mode).toBe('extension');
    expect(page.extension).toEqual({ format: 'demo-board', data: { columns: [] } });
    expect(page.blocks).toEqual([]);
    expect(page.html).toBeUndefined();
  });

  it('falls back to canvas when extension mode has no extension content', () => {
    const doc = applyOpsToDocument(baseDoc([canvasPage()]), [{
      op: 'update_page',
      pageId: 'page_a',
      patch: { mode: 'extension' },
    }]);
    expect(doc.pages[0]!.mode).toBe('canvas');
    expect(doc.pages[0]!.extension).toBeUndefined();
  });

  it('updates extension data through update_page', () => {
    const doc = applyOpsToDocument(baseDoc([{ ...canvasPage(), mode: 'extension', blocks: [], extension: { format: 'demo-board', data: { v: 1 } } }]), [{
      op: 'update_page',
      pageId: 'page_a',
      patch: { extension: { format: 'demo-board', data: { v: 2 } } },
    }]);
    expect(doc.pages[0]!.extension).toEqual({ format: 'demo-board', data: { v: 2 } });
  });

  it('rejects blocks on extension pages', () => {
    const doc = baseDoc([{ ...canvasPage(), mode: 'extension', blocks: [], extension: { format: 'demo-board', data: {} } }]);
    expect(() => applyOpsToDocument(doc, [{
      op: 'add_block',
      pageId: 'page_a',
      block: { id: 'block_1', type: 'text', x: 10, y: 10, w: 100, h: 40, z: 1, text: 'hello' },
    }])).toThrow(/canvas or infinite page/);
  });

  it('clears extension content when converting back to an HTML page', () => {
    const doc = applyOpsToDocument(baseDoc([{ ...canvasPage(), mode: 'extension', blocks: [], extension: { format: 'demo-board', data: {} } }]), [{
      op: 'set_page_html',
      pageId: 'page_a',
      html: '<p>Hello</p>',
    }]);
    expect(doc.pages[0]!.mode).toBe('html');
    expect(doc.pages[0]!.extension).toBeUndefined();
  });
});
