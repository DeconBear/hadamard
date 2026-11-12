import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startHcanvasServer, type HcServer } from '../src/hcanvas/server.js';

const roots: string[] = [];
const servers: HcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function start(): Promise<HcServer> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-server-'));
  roots.push(root);
  const server = await startHcanvasServer({ workspace: root, port: 46000 + Math.floor(Math.random() * 5000), staticDir: path.resolve('dist/hcanvas') });
  servers.push(server);
  return server;
}

async function api<T>(server: HcServer, route: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(server.url.replace(/\/$/, '') + route, {
    ...init,
    headers: { 'x-hcanvas-token': server.token, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as T : {} as T;
  if (!response.ok) throw new Error(JSON.stringify(payload));
  return payload;
}

describe('hcanvas server', () => {
  it('serves state, reads, patches, proposals and exports', async () => {
    const server = await start();
    const state = await api<{ active: { docId: string; pageId: string }; docs: unknown[] }>(server, '/api/state');
    expect(state.docs).toHaveLength(1);
    const docId = state.active.docId;
    const doc = await api<{ doc: { revision: number; pages: Array<{ id: string; html?: string; mode: string }> } }>(server, '/api/docs/' + docId);
    expect(doc.doc.revision).toBe(0);
    const infinite = doc.doc.pages.find(page => page.mode === 'infinite')!;
    const html = doc.doc.pages[0]!.html || '';
    const target = html.match(/data-hc-id="([^"]+)"[^>]*>H/)?.[1] ?? html.match(/data-hc-id="([^"]+)"/)?.[1];
    expect(target).toBeTruthy();

    const outline = await api<{ content: string }>(server, '/api/docs/' + docId + '/read?format=outline');
    expect(outline.content).toContain('## Page');
    const htmlRead = await api<{ html: string }>(server, '/api/docs/' + docId + '/read?format=html');
    expect(htmlRead.html).toContain('data-hc-id=');

    const session = await api<{ session: { id: string } }>(server, '/api/sessions', { method: 'POST', body: JSON.stringify({ docId, actor: 'claude-code' }) });
    const sessions = await api<{ sessions: Array<{ id: string; actor: string }> }>(server, '/api/sessions');
    expect(sessions.sessions.some(item => item.id === session.session.id)).toBe(true);
    const heartbeat = await api<{ session: { pageId?: string } }>(server, '/api/sessions/' + session.session.id + '/heartbeat', { method: 'POST', body: JSON.stringify({ pageId: infinite.id, selection: ['block_x'] }) });
    expect(heartbeat.session.pageId).toBe(infinite.id);
    await api(server, '/api/sessions/' + session.session.id, { method: 'DELETE' });

    const applied = await api<{ doc: { revision: number } }>(server, '/api/docs/' + docId + '/apply', {
      method: 'POST',
      body: JSON.stringify({ baseRevision: 0, actor: 'claude-code', ops: [{ op: 'html_patch', pageId: state.active.pageId, patches: [{ op: 'set_text', target, text: 'Agent patched' }] }] }),
    });
    expect(applied.doc.revision).toBe(1);

    const proposal = await api<{ proposal: { id: string } }>(server, '/api/docs/' + docId + '/proposals', {
      method: 'POST',
      body: JSON.stringify({ baseRevision: 1, actor: 'dsh', intent: 'Proposal', ops: [{ op: 'update_page', pageId: state.active.pageId, patch: { name: 'Renamed' } }] }),
    });
    const accepted = await api<{ doc: { revision: number } }>(server, '/api/docs/' + docId + '/proposals/' + proposal.proposal.id + '/accept', { method: 'POST', body: '{}' });
    expect(accepted.doc.revision).toBe(2);

    const master = await api<{ master: { id: string; name: string } }>(server, '/api/masters', { method: 'POST', body: JSON.stringify({ docId, pageId: infinite.id, name: 'Infinite master' }) });
    const masters = await api<{ masters: Array<{ id: string }> }>(server, '/api/masters');
    expect(masters.masters.some(item => item.id === master.master.id)).toBe(true);
    const latest = await api<{ doc: { revision: number } }>(server, '/api/docs/' + docId);
    const fromMaster = await api<{ page: { name: string }; doc: { pages: unknown[] } }>(server, '/api/masters/' + master.master.id + '/pages', { method: 'POST', body: JSON.stringify({ docId, baseRevision: latest.doc.revision }) });
    expect(fromMaster.page.name).toBe('Infinite master');
    await api(server, '/api/masters/' + master.master.id, { method: 'DELETE' });

    const created = await api<{ doc: { id: string } }>(server, '/api/docs', { method: 'POST', body: JSON.stringify({ title: 'PPTX test', preset: { width: 1280, height: 720, background: '#ffffff', title: 'Slide' } }) });
    const duplicated = await api<{ doc: { id: string; title: string; pages: unknown[] } }>(server, '/api/docs/' + created.doc.id + '/duplicate', { method: 'POST' });
    expect(duplicated.doc.id).not.toBe(created.doc.id);
    expect(duplicated.doc.title).toContain('copy');
    expect(duplicated.doc.pages).toHaveLength(1);

    const pptx = await api<{ path: string; bytes: number }>(server, '/api/export', { method: 'POST', body: JSON.stringify({ docId: created.doc.id, format: 'pptx' }) });
    expect(pptx.bytes).toBeGreaterThan(1000);
    expect(pptx.path).toMatch(/\.pptx$/);

    const editablePptx = await api<{ path: string; bytes: number }>(server, '/api/export', { method: 'POST', body: JSON.stringify({ docId: created.doc.id, format: 'pptx-editable' }) });
    expect(editablePptx.bytes).toBeGreaterThan(1000);
    expect(editablePptx.path).toMatch(/\.pptx$/);

    const docx = await api<{ path: string; bytes: number }>(server, '/api/export', { method: 'POST', body: JSON.stringify({ docId: created.doc.id, format: 'docx' }) });
    expect(docx.bytes).toBeGreaterThan(1000);
    expect(docx.path).toMatch(/\.docx$/);

    // Canvas pages must export a semantic DOCX and an A4 editable PPTX with data-URL images.
    const canvasDoc = await api<{ doc: { id: string; revision: number; pages: Array<{ id: string }> } }>(server, '/api/docs', { method: 'POST', body: JSON.stringify({ title: 'A4 resume', preset: { width: 794, height: 1123, background: '#ffffff', title: 'A4' } }) });
    const canvasPageId = canvasDoc.doc.pages[0]!.id;
    const onePixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
    await api(server, '/api/docs/' + canvasDoc.doc.id + '/apply', {
      method: 'POST',
      body: JSON.stringify({
        baseRevision: canvasDoc.doc.revision,
        ops: [
          { op: 'update_page', pageId: canvasPageId, patch: { mode: 'canvas', width: 794, height: 1123, background: '#ffffff' } },
          { op: 'add_block', pageId: canvasPageId, block: { id: 'resume_text', type: 'text', x: 40, y: 40, w: 300, h: 40, z: 1, text: 'Resume heading', style: { fontSize: 24, fontWeight: 700, color: '#172F45' } } },
          { op: 'add_block', pageId: canvasPageId, block: { id: 'resume_shape', type: 'shape', shape: 'rect', x: 40, y: 100, w: 300, h: 4, z: 2, style: { fill: '#355E7D', strokeWidth: 0 } } },
          { op: 'add_block', pageId: canvasPageId, block: { id: 'resume_photo', type: 'image', x: 600, y: 40, w: 100, h: 100, z: 3, src: onePixel, alt: 'photo', style: { radius: 999 } } },
        ],
      }),
    });
    const canvasDocx = await api<{ path: string; bytes: number }>(server, '/api/export', { method: 'POST', body: JSON.stringify({ docId: canvasDoc.doc.id, format: 'docx' }) });
    expect(canvasDocx.bytes).toBeGreaterThan(1000);
    expect(canvasDocx.path).toMatch(/\.docx$/);
    const canvasPptx = await api<{ path: string; bytes: number }>(server, '/api/export', { method: 'POST', body: JSON.stringify({ docId: canvasDoc.doc.id, format: 'pptx-editable' }) });
    expect(canvasPptx.bytes).toBeGreaterThan(1000);
    expect(canvasPptx.path).toMatch(/\.pptx$/);

    const exported = await api<{ path: string; bytes: number }>(server, '/api/export', { method: 'POST', body: JSON.stringify({ docId, format: 'html' }) });
    expect(exported.bytes).toBeGreaterThan(100);
    expect(exported.path).toMatch(/\.html$/);

    const removedExcalidrawAsset = await fetch(server.url.replace(/\/$/, '') + '/gui-canvas/excalidraw.js');
    expect(removedExcalidrawAsset.status).toBe(404);

    const forbiddenFolder = await fetch(server.url.replace(/\/$/, '') + '/api/projects/reveal', {
      method: 'POST',
      headers: { 'x-hcanvas-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: 'C:\\Windows' }),
    });
    expect(forbiddenFolder.status).toBe(403);

    const printPdf = await api<{ path: string; bytes: number }>(server, '/api/export', { method: 'POST', body: JSON.stringify({ docId, format: 'pdf', pageId: state.active.pageId, bleedMm: 3, cropMarks: true }) });
    expect(printPdf.bytes).toBeGreaterThan(1000);
    expect(printPdf.path).toMatch(/\.pdf$/);

    // Canvas Copilot: local OpenAI-compatible mock returning a read tool call and a final reply.
    let modelCalls = 0;
    const mockModel = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        modelCalls += 1;
        res.setHeader('content-type', 'application/json');
        if (modelCalls === 1) {
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'canvas_read', arguments: JSON.stringify({ format: 'outline' }) } }] } }] }));
        } else {
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'The canvas was inspected.' } }] }));
        }
      });
    });
    await new Promise<void>(resolve => mockModel.listen(0, '127.0.0.1', resolve));
    const modelPort = (mockModel.address() as { port: number }).port;
    process.env.HCANVAS_LLM_BASE_URL = 'http://127.0.0.1:' + modelPort + '/v1';
    process.env.HCANVAS_LLM_API_KEY = 'test';
    process.env.HCANVAS_LLM_MODEL = 'mock-model';
    try {
      const status = await api<{ configured: boolean; model: string }>(server, '/api/agent/status');
      expect(status.configured).toBe(true);
      expect(status.model).toBe('mock-model');
      const chat = await api<{ reply: string; steps: Array<{ type: string; name?: string }> }>(server, '/api/agent/chat', {
        method: 'POST',
        body: JSON.stringify({ docId, messages: [{ role: 'user', content: 'Inspect this canvas' }] }),
      });
      expect(chat.reply).toContain('inspected');
      expect(chat.steps.some(step => step.type === 'tool' && step.name === 'canvas_read')).toBe(true);
    } finally {
      delete process.env.HCANVAS_LLM_BASE_URL;
      delete process.env.HCANVAS_LLM_API_KEY;
      delete process.env.HCANVAS_LLM_MODEL;
      await new Promise<void>(resolve => mockModel.close(() => resolve()));
    }
  }, 60_000);

  it('preserves the initial preset mode and blocks through the HTTP API', async () => {
    const server = await start();
    const created = await api<{ doc: { pages: Array<{ mode: string; name: string; html?: string; blocks?: unknown[] }> } }>(server, '/api/docs', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Infinite API test',
        preset: { id: 'infinite', title: 'Infinite canvas', mode: 'infinite', width: 4800, height: 3200, background: '#f8f6f1', blocks: [] },
      }),
    });
    expect(created.doc.pages[0]).toMatchObject({ name: 'Infinite canvas', mode: 'infinite', blocks: [] });
    expect(created.doc.pages[0]!.html).toBeUndefined();
  });

  it('honors ephemeral ports and closes with an active event stream', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-server-close-'));
    roots.push(root);
    const server = await startHcanvasServer({ workspace: root, port: 0, staticDir: path.resolve('dist/hcanvas') });
    servers.push(server);
    expect(server.port).toBeGreaterThan(0);
    const response = await fetch(server.url + 'api/events?token=' + encodeURIComponent(server.token));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await server.close();
    await server.close();
  });
});
