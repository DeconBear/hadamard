import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HcStore } from '../src/hcanvas/store.js';

const temps: string[] = [];
async function tempStore(): Promise<HcStore> { const dir = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-history-')); temps.push(dir); const store = new HcStore(dir); await store.init(); return store; }
afterEach(async () => { await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('Revision snapshots', () => {
  it('lists, reads, and restores revisions without losing the current one', async () => {
    const store = await tempStore();
    const doc = await store.createDoc({ title: 'History test' });
    const pageId = doc.pages[0]!.id;
    const first = await store.applyOps(doc.id, { baseRevision: doc.revision, ops: [{ op: 'update_page', pageId, patch: { name: 'First rename' } }], summary: 'rename to first' });
    const second = await store.applyOps(doc.id, { baseRevision: first.doc.revision, ops: [{ op: 'update_page', pageId, patch: { name: 'Second rename' } }], summary: 'rename to second' });
    const revisions = await store.listRevisions(doc.id);
    expect(revisions.map(item => item.revision)).toEqual(expect.arrayContaining([0, 1, 2]));
    const snapshot = await store.readRevision(doc.id, 1);
    expect(snapshot.pages[0]!.name).toBe('First rename');
    const restored = await store.restoreRevision(doc.id, 1, { baseRevision: second.doc.revision });
    expect(restored.revision).toBe(3);
    expect(restored.pages[0]!.name).toBe('First rename');
    expect(restored.history.some(item => item.summary === 'Restore revision 1')).toBe(true);
    const after = await store.listRevisions(doc.id);
    expect(after.map(item => item.revision)).toContain(3);
    await expect(store.readRevision(doc.id, 99)).rejects.toThrow();
  });

  it('describes saved operations with their page and change type', async () => {
    const store = await tempStore();
    const doc = await store.createDoc({ title: 'Readable history' });
    const pageId = doc.pages[0]!.id;
    const first = await store.applyOps(doc.id, {
      baseRevision: doc.revision,
      ops: [{ op: 'set_page_markdown', pageId, markdown: '# Trip plan' }],
    });
    expect(first.doc.history.at(-1)?.summary).toBe('Edit Markdown · Page 1');
    const canvas = { id: 'page_map', name: 'Route map', mode: 'infinite' as const, width: 1200, height: 800, background: '#ffffff', blocks: [] };
    const withCanvas = await store.applyOps(doc.id, { baseRevision: first.doc.revision, ops: [{ op: 'add_page', page: canvas }] });
    const block = { id: 'shape_one', type: 'shape' as const, shape: 'roundRect' as const, x: 20, y: 30, w: 200, h: 100, z: 0 };
    const second = await store.applyOps(doc.id, { baseRevision: withCanvas.doc.revision, ops: [{ op: 'add_block', pageId: canvas.id, block }] });
    expect(second.doc.history.at(-1)?.summary).toBe('Add shape · Route map');
    const third = await store.applyOps(doc.id, {
      baseRevision: second.doc.revision,
      ops: [{ op: 'update_block', pageId: canvas.id, blockId: block.id, patch: { x: 40, y: 60 } }],
    });
    expect(third.doc.history.at(-1)?.summary).toBe('Move shape · Route map');
    const revisions = await store.listRevisions(doc.id);
    expect(revisions[0]?.summary).toBe('Move shape · Route map');
    expect(revisions[0]?.bytes).toBeGreaterThan(0);
  });
});
