import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startHadamardGuiServer } from '../src/gui/hadamardGui.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function setupServer() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-gui-canvas-'));
  tempDirs.push(root);
  const homeDir = path.join(root, 'home');
  const workDir = path.join(root, 'work');
  const configPath = path.join(homeDir, '.hadamard', 'settings.json');
  await mkdir(workDir, { recursive: true });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    env: { HADAMARD_PROVIDER: 'openai', HADAMARD_API_KEY: 'test-key', HADAMARD_MODEL: 'gpt-4o-mini' },
  }), 'utf8');
  const port = 50000 + Math.floor(Math.random() * 8000);
  const server = await startHadamardGuiServer({ workDir, homeDir, host: '127.0.0.1', port, configPath });
  return { server, root, homeDir, workDir, configPath };
}

async function api<T>(server: Awaited<ReturnType<typeof startHadamardGuiServer>>, requestPath: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(server.url + requestPath, {
    ...init,
    headers: { 'x-hadamard-token': server.token, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : {}; } catch { /* text */ }
  return { status: res.status, body: body as T };
}

describe('canvas module loading/unloading (GUI end-to-end)', () => {
  it('hides UI state, tools and routes until the module is enabled, then unloads everything', async () => {
    const { server, configPath, workDir } = await setupServer();
    try {
      const initial = await api<{ settings: { modules: { enabled: Record<string, boolean> } }; tools: { name: string }[] }>(server, 'api/state');
      expect(initial.status).toBe(200);
      expect(initial.body.settings.modules.enabled.canvas).toBe(false);
      expect(initial.body.tools.some(tool => tool.name === 'CanvasList')).toBe(false);

      const disabledCanvas = await api<{ error?: string }>(server, 'api/canvas/list?projectPath=' + encodeURIComponent(workDir));
      expect(disabledCanvas.status).toBe(404);

      const enabled = await api<{ settings: { modules: { enabled: Record<string, boolean> } }; tools: { name: string }[] }>(server, 'api/settings', {
        method: 'POST',
        body: JSON.stringify({ modules: { canvas: { enabled: true } } }),
      });
      expect(enabled.status).toBe(200);
      expect(enabled.body.settings.modules.enabled.canvas).toBe(true);

      const reloaded = await api<{ settings: { modules: { enabled: Record<string, boolean> } }; tools: { name: string }[] }>(server, 'api/state');
      expect(reloaded.body.settings.modules.enabled.canvas).toBe(true);
      const toolNames = reloaded.body.tools.map(tool => tool.name);
      expect(toolNames).toContain('CanvasList');
      expect(toolNames).toContain('CanvasRead');
      expect(toolNames).toContain('CanvasApplyOps');
      expect(toolNames).toContain('CanvasPropose');
      expect(toolNames).toContain('CanvasValidate');

      const projectQuery = '?projectPath=' + encodeURIComponent(workDir);
      const created = await api<{ doc: { id: string; revision: number; nodes: { id: string }[] } }>(server, 'api/canvas/create', {
        method: 'POST',
        body: JSON.stringify({ projectPath: workDir, title: 'E2E canvas', template: 'ai-model-transformer' }),
      });
      expect(created.status).toBe(200);
      const docId = created.body.doc.id;
      expect(created.body.doc.nodes.length).toBeGreaterThan(0);

      const listed = await api<{ documents: { id: string }[] }>(server, 'api/canvas/list' + projectQuery);
      expect(listed.status).toBe(200);
      expect(listed.body.documents.map(doc => doc.id)).toContain(docId);

      const exported = await fetch(server.url + 'api/canvas/export' + projectQuery + '&docId=' + docId + '&format=mermaid', {
        headers: { 'x-hadamard-token': server.token },
      });
      expect(exported.status).toBe(200);
      expect(await exported.text()).toContain('flowchart TD');

      const persisted = JSON.parse(await readFile(configPath, 'utf8'));
      expect(persisted.modules.canvas.enabled).toBe(true);

      const disabled = await api<{ settings: { modules: { enabled: Record<string, boolean> } }; tools: { name: string }[] }>(server, 'api/settings', {
        method: 'POST',
        body: JSON.stringify({ modules: { canvas: { enabled: false } } }),
      });
      expect(disabled.status).toBe(200);
      expect(disabled.body.settings.modules.enabled.canvas).toBe(false);
      expect(disabled.body.tools.some(tool => tool.name === 'CanvasList')).toBe(false);
      const afterDisable = await api<{ error?: string }>(server, 'api/canvas/list' + projectQuery);
      expect(afterDisable.status).toBe(404);
    } finally {
      await server.close();
    }
  }, 60_000);
});
