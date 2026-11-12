import { describe, expect, it } from 'vitest';
import { applyOpLocally } from '../src/hcanvas/client/documentHistory.js';
import type { HcDocument } from '../src/hcanvas/types.js';

describe('hcanvas local document operations', () => {
  it('applies block movement patches used by bound-arrow updates', () => {
    const doc = {
      pages: [{ id: 'page-1', blocks: [{ id: 'stop', type: 'shape', x: 40, y: 60, w: 160, h: 74, z: 0 }] }],
    } as HcDocument;
    applyOpLocally(doc, { op: 'update_block', pageId: 'page-1', blockId: 'stop', patch: { x: 96, y: 72 } });
    expect(doc.pages[0]?.blocks?.[0]).toMatchObject({ x: 96, y: 72 });
  });
});
