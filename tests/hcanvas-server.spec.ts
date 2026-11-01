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
    const doc = await api<{ doc: { revision: number; pages: Array<{ id: string; html?: string; mode: string; scene?: { elements: unknown[] } }> } }>(server, '/api/docs/' + docId);
    expect(doc.doc.revision).toBe(0);
    const whiteboard = doc.doc.pages.find(page => page.mode === 'whiteboard')!;
    const sceneRead = await api<{ scene: { elements: unknown[] } }>(server, '/api/docs/' + docId + '/read?format=scene&pageId=' + whiteboard.id);
    expect(sceneRead.scene.elements.length).toBeGreaterThan(0);
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
    const heartbeat = await api<{ session: { pageId?: string } }>(server, '/api/sessions/' + session.session.id + '/heartbeat', { method: 'POST', body: JSON.stringify({ pageId: whiteboard.id, selection: ['block_x'] }) });
    expect(heartbeat.session.pageId).toBe(whiteboard.id);
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

    const master = await api<{ master: { id: string; name: string } }>(server, '/api/masters', { method: 'POST', body: JSON.stringify({ docId, pageId: whiteboard.id, name: 'Whiteboard master' }) });
    const masters = await api<{ masters: Array<{ id: string }> }>(server, '/api/masters');
    expect(masters.masters.some(item => item.id === master.master.id)).toBe(true);
    const latest = await api<{ doc: { revision: number } }>(server, '/api/docs/' + docId);
    const fromMaster = await api<{ page: { name: string }; doc: { pages: unknown[] } }>(server, '/api/masters/' + master.master.id + '/pages', { method: 'POST', body: JSON.stringify({ docId, baseRevision: latest.doc.revision }) });
    expect(fromMaster.page.name).toBe('Whiteboard master');
    await api(server, '/api/masters/' + master.master.id, { method: 'DELETE' });

    const created = await api<{ doc: { id: string } }>(server, '/api/docs', { method: 'POST', body: JSON.stringify({ title: 'PPTX test', preset: { width: 1280, height: 720, background: '#ffffff', title: 'Slide' } }) });
    const pptx = await api<{ path: string; bytes: number }>(server, '/api/export', { method: 'POST', body: JSON.stringify({ docId: created.doc.id, format: 'pptx' }) });
    expect(pptx.bytes).toBeGreaterThan(1000);
    expect(pptx.path).toMatch(/\.pptx$/);

    const editablePptx = await api<{ path: string; bytes: number }>(server, '/api/export', { method: 'POST', body: JSON.stringify({ docId: created.doc.id, format: 'pptx-editable' }) });
    expect(editablePptx.bytes).toBeGreaterThan(1000);
    expect(editablePptx.path).toMatch(/\.pptx$/);

    const docx = await api<{ path: string; bytes: number }>(server, '/api/export', { method: 'POST', body: JSON.stringify({ docId: created.doc.id, format: 'docx' }) });
    expect(docx.bytes).toBeGreaterThan(1000);
    expect(docx.path).toMatch(/\.docx$/);

    const exported = await api<{ path: string; bytes: number }>(server, '/api/export', { method: 'POST', body: JSON.stringify({ docId, format: 'html' }) });
    expect(exported.bytes).toBeGreaterThan(100);
    expect(exported.path).toMatch(/\.html$/);

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
});
