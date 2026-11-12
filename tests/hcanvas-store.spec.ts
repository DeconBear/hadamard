import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { HcRevisionConflictError, HcStore } from '../src/hcanvas/store.js';

const dirs: string[] = [];
async function makeStore(): Promise<HcStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-store-'));
  dirs.push(dir);
  const store = new HcStore(dir);
  await store.init();
  return store;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('hcanvas store', () => {
  it('seeds a demo document with html and canvas pages', async () => {
    const store = await makeStore();
    const docs = await store.listDocs();
    expect(docs).toHaveLength(1);
    const doc = await store.readDoc(docs[0]!.id);
    expect(doc.pages).toHaveLength(3);
    expect(doc.pages[0]!.mode).toBe('html');
    expect(doc.pages[1]!.mode).toBe('canvas');
    expect(doc.pages[2]!.mode).toBe('infinite');
    expect(doc.pages[0]!.html).toContain('data-hc-id=');
  });


  it('auto-migrates a legacy whiteboard page when it is read', async () => {
    const store = await makeStore();
    const legacy = {
      schema: 'hadamard-canvas/1',
      id: 'doc_legacywhiteboard',
      title: 'Legacy document',
      revision: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      pages: [{
        id: 'page_legacywhiteboard',
        name: 'Whiteboard',
        mode: 'whiteboard',
        width: 1280,
        height: 720,
        background: '#ffffff',
        scene: { elements: [{ id: 'el_1', type: 'rectangle', x: 10, y: 20, width: 100, height: 60 }], appState: { viewBackgroundColor: '#ffffff' }, files: {} },
      }],
      proposals: [],
      history: [],
    };
    await writeFile(path.join(store.docsDir, 'doc_legacywhiteboard.json'), JSON.stringify(legacy, null, 2), 'utf8');
    const doc = await store.readDoc('doc_legacywhiteboard');
    expect(doc.pages[0]!.mode).toBe('infinite');
    expect(doc.pages[0]!.blocks?.length).toBeGreaterThan(0);
    expect((doc.pages[0] as unknown as { scene?: unknown }).scene).toBeUndefined();
  });

  it('applies ops with revision CAS and records history', async () => {
    const store = await makeStore();
    const demo = (await store.readDoc((await store.listDocs())[0]!.id));
    await expect(store.applyOps(demo.id, { baseRevision: 99, actor: 'test', ops: [] })).rejects.toBeInstanceOf(HcRevisionConflictError);
    const result = await store.applyOps(demo.id, {
      baseRevision: 0,
      actor: 'claude-code',
      ops: [{ op: 'add_page', page: { id: 'page_test', name: 'Test', mode: 'canvas', width: 1280, height: 720, background: '#ffffff', blocks: [] } }],
    });
    expect(result.doc.revision).toBe(1);
    expect(result.doc.pages.some(page => page.id === 'page_test')).toBe(true);
    expect(result.doc.history[0]!.actor).toBe('claude-code');
  });

  it('adds blocks to an infinite page', async () => {
    const store = await makeStore();
    const doc = await store.readDoc((await store.listDocs())[0]!.id);
    const infinite = doc.pages.find(page => page.mode === 'infinite')!;
    const before = infinite.blocks?.length || 0;
    const result = await store.applyOps(doc.id, {
      baseRevision: 0, actor: 'test',
      ops: [{ op: 'add_block', pageId: infinite.id, block: { id: 'block_inf', type: 'html', x: 2000, y: 1500, w: 400, h: 200, z: 20, html: '<p>Infinite</p>' } }],
    });
    const next = result.doc.pages.find(page => page.id === infinite.id)!;
    expect(next.blocks?.length).toBe(before + 1);
    expect(next.blocks?.some(block => block.id === 'block_inf')).toBe(true);
  });

  it('creates proposals and resolves them against the current revision', async () => {
    const store = await makeStore();
    const doc = await store.readDoc((await store.listDocs())[0]!.id);
    const proposal = await store.createProposal(doc.id, {
      baseRevision: 0, actor: 'dsh', intent: 'Add a page',
      ops: [{ op: 'add_page', page: { id: 'page_prop', name: 'Proposal', mode: 'html', width: 1280, height: 720, background: '#fff', html: '<h1>Proposal</h1>' } }],
    });
    expect(proposal.status).toBe('pending');
    const accepted = await store.resolveProposal(doc.id, proposal.id, 'accept', 'human');
    expect(accepted.conflict).toBeUndefined();
    expect(accepted.doc.revision).toBe(1);
    expect(accepted.doc.proposals[0]!.status).toBe('accepted');
    expect(accepted.doc.pages.some(page => page.id === 'page_prop')).toBe(true);
  });

  it('persists native freehand and arrow vector blocks', async () => {
    const store = await makeStore();
    const doc = await store.readDoc((await store.listDocs())[0]!.id);
    const page = doc.pages.find(item => item.mode === 'infinite')!;
    const result = await store.applyOps(doc.id, {
      baseRevision: doc.revision,
      actor: 'test',
      ops: [
        { op: 'add_block', pageId: page.id, block: { id: 'block_free', type: 'freehand', x: 10, y: 20, w: 100, h: 80, z: 1, points: [{ x: 0, y: 0 }, { x: 100, y: 80 }], style: { stroke: '#1f2430', strokeWidth: 2 } } },
        { op: 'add_block', pageId: page.id, block: { id: 'block_arrow', type: 'arrow', x: 200, y: 20, w: 120, h: 80, z: 2, points: [{ x: 0, y: 0 }, { x: 120, y: 80 }], arrowhead: 'arrow', style: { stroke: '#1f2430', strokeWidth: 2 } } },
      ],
    });
    const savedPage = result.doc.pages.find(item => item.id === page.id)!;
    expect(savedPage.blocks?.find(block => block.id === 'block_free')?.points).toEqual([{ x: 0, y: 0 }, { x: 100, y: 80 }]);
    expect(savedPage.blocks?.find(block => block.id === 'block_arrow')?.arrowhead).toBe('arrow');
  });

  it('tracks agent sessions and presence heartbeats', async () => {
    const store = await makeStore();
    const doc = await store.readDoc((await store.listDocs())[0]!.id);
    const session = await store.createSession(doc.id, 'claude-code');
    const presence = await store.listSessions();
    expect(presence).toHaveLength(1);
    expect(presence[0]).toMatchObject({ id: session.id, actor: 'claude-code', docTitle: doc.title });
    const touched = await store.touchSession(session.id, { pageId: doc.pages[2]!.id, selection: ['block_x'] });
    expect(touched.pageId).toBe(doc.pages[2]!.id);
    expect(touched.selection).toEqual(['block_x']);
    const context = await store.getContext();
    expect((context.presence as Array<{ id: string }>).some(item => item.id === session.id)).toBe(true);
    await store.deleteSession(session.id);
    expect(await store.listSessions()).toHaveLength(0);
  });

  it('saves page masters and creates new pages from them', async () => {
    const store = await makeStore();
    const doc = await store.readDoc((await store.listDocs())[0]!.id);
    const source = doc.pages.find(page => page.mode === 'canvas') || doc.pages[0]!;
    const master = await store.saveMaster({ docId: doc.id, pageId: source.id, name: 'Title master' });
    expect(master.name).toBe('Title master');
    expect(master.mode).toBe(source.mode);
    const masters = await store.listMasters();
    expect(masters.some(item => item.id === master.id)).toBe(true);
    const created = await store.addPageFromMaster(doc.id, master.id, { baseRevision: doc.revision, actor: 'test' });
    expect(created.doc.pages.length).toBe(doc.pages.length + 1);
    expect(created.page.name).toBe('Title master');
    expect(created.page.mode).toBe(source.mode);
    await store.deleteMaster(master.id);
    expect(await store.listMasters()).toHaveLength(0);
  });

  it('tracks active context and resolves documents by title', async () => {
    const store = await makeStore();
    const doc = await store.readDoc((await store.listDocs())[0]!.id);
    await store.activate({ docId: doc.id, pageId: doc.pages[1]!.id, blockId: 'block_x', actor: 'human' });
    const context = await store.getContext();
    expect(context.active).toMatchObject({ docId: doc.id, pageId: doc.pages[1]!.id, blockId: 'block_x' });
    const resolved = await store.resolve('welcome');
    expect(resolved.matches[0]?.docId).toBe(doc.id);
    expect(resolved.ambiguous).toBe(false);
  });

  it('creates the selected initial page mode and content', async () => {
    const store = await makeStore();
    const infinite = await store.createDoc({
      title: 'Infinite test',
      preset: { id: 'infinite', title: 'Infinite canvas', mode: 'infinite', width: 4800, height: 3200, background: '#f8f6f1', blocks: [] },
    });
    expect(infinite.pages[0]).toMatchObject({ name: 'Infinite canvas', mode: 'infinite', blocks: [] });
    expect(infinite.pages[0]!.html).toBeUndefined();

    const canvas = await store.createDoc({
      title: 'Canvas test',
      preset: {
        id: 'canvas', title: 'Canvas slide', mode: 'canvas', width: 1280, height: 720, background: '#ffffff',
        blocks: [{ id: 'block_initial', type: 'text', x: 20, y: 30, w: 300, h: 80, z: 0, text: 'Initial content' }],
      },
    });
    expect(canvas.pages[0]).toMatchObject({ mode: 'canvas', blocks: [{ id: 'block_initial', text: 'Initial content' }] });
    expect(canvas.pages[0]!.html).toBeUndefined();
  });
});
