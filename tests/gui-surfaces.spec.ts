import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseHadamardGuiArgs, startHadamardGuiServer } from '../src/gui/hadamardGui.js';

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function setup(modules: Record<string, { enabled: boolean }>, surface: 'full' | 'harness' | 'canvas') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-gui-surface-'));
  tempDirs.push(root);
  const homeDir = path.join(root, 'home');
  const workDir = path.join(root, 'work');
  const configPath = path.join(homeDir, '.hadamard', 'settings.json');
  await mkdir(workDir, { recursive: true });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    env: { HADAMARD_PROVIDER: 'openai', HADAMARD_API_KEY: 'test-key', HADAMARD_MODEL: 'gpt-4o-mini' },
    modules,
  }), 'utf8');
  const port = 50000 + Math.floor(Math.random() * 8000);
  const server = await startHadamardGuiServer({ workDir, homeDir, host: '127.0.0.1', port, configPath, surface });
  return { server, workDir };
}

async function api<T>(server: Awaited<ReturnType<typeof startHadamardGuiServer>>, requestPath: string, init: RequestInit = {}) {
  const res = await fetch(server.url + requestPath, {
    ...init,
    headers: { 'x-hadamard-token': server.token, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : {}; } catch { /* text */ }
  return { status: res.status, body: body as T };
}

type StateShape = {
  surface: string;
  settings: { modules: { enabled: Record<string, boolean>; definitions: { id: string }[] } };
  tools: { name: string }[];
};

describe('GUI launch surfaces', () => {
  it('canvas surface forces the canvas module on even when globally disabled', async () => {
    const { server, workDir } = await setup({ canvas: { enabled: false }, harness: { enabled: true } }, 'canvas');
    try {
      const state = await api<StateShape>(server, 'api/state');
      expect(state.body.surface).toBe('canvas');
      expect(state.body.settings.modules.enabled.canvas).toBe(true);
      expect(state.body.settings.modules.enabled.harness).toBe(false);
      expect(state.body.tools.map(tool => tool.name)).toContain('CanvasList');
      const list = await api<{ documents: unknown[] }>(server, 'api/canvas/list?projectPath=' + encodeURIComponent(workDir));
      expect(list.status).toBe(200);
      expect(list.body.documents).toEqual([]);
    } finally { await server.close(); }
  }, 60_000);

  it('harness surface only composes the agent module, even when canvas is enabled globally', async () => {
    const { server, workDir } = await setup({ canvas: { enabled: true }, harness: { enabled: true } }, 'harness');
    try {
      const state = await api<StateShape>(server, 'api/state');
      expect(state.body.surface).toBe('harness');
      expect(state.body.settings.modules.enabled.harness).toBe(true);
      expect(state.body.settings.modules.enabled.canvas).toBe(false);
      expect(state.body.tools.some(tool => tool.name === 'CanvasList')).toBe(false);
      const probe = await api<{ error?: string }>(server, 'api/canvas/list?projectPath=' + encodeURIComponent(workDir));
      expect(probe.status).toBe(404);
    } finally { await server.close(); }
  }, 60_000);

  it('full surface composes whatever modules are enabled in settings', async () => {
    const { server } = await setup({ canvas: { enabled: false }, harness: { enabled: true } }, 'full');
    try {
      const initial = await api<StateShape>(server, 'api/state');
      expect(initial.body.surface).toBe('full');
      expect(initial.body.settings.modules.enabled.harness).toBe(true);
      expect(initial.body.settings.modules.enabled.canvas).toBe(false);
      expect(initial.body.settings.modules.definitions.map(item => item.id)).toEqual(['harness', 'canvas']);
      expect(initial.body.tools.some(tool => tool.name === 'CanvasList')).toBe(false);

      const enabled = await api<StateShape>(server, 'api/settings', {
        method: 'POST',
        body: JSON.stringify({ modules: { canvas: { enabled: true }, harness: { enabled: true } } }),
      });
      expect(enabled.status).toBe(200);
      expect(enabled.body.settings.modules.enabled.canvas).toBe(true);
      expect(enabled.body.tools.some(tool => tool.name === 'CanvasList')).toBe(true);
    } finally { await server.close(); }
  }, 60_000);

  it('parses --surface for both GUI entrypoints', () => {
    expect(parseHadamardGuiArgs(['--surface', 'canvas']).surface).toBe('canvas');
    expect(parseHadamardGuiArgs(['--surface', 'harness']).surface).toBe('harness');
    expect(parseHadamardGuiArgs(['--surface', 'nope']).surface).toBe('full');
  });
});
