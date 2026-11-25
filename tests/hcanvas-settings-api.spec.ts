import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHcanvasServer, type HcServer } from '../src/hcanvas/server.js';

const roots: string[] = [];
const servers: HcServer[] = [];
const previousConfig = process.env.HCANVAS_CONFIG_HOME;
const previousHome = process.env.HCANVAS_HOME;

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-settings-api-'));
  roots.push(root);
  process.env.HCANVAS_CONFIG_HOME = root;
  process.env.HCANVAS_HOME = path.join(root, 'workspace');
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  if (previousConfig === undefined) delete process.env.HCANVAS_CONFIG_HOME;
  else process.env.HCANVAS_CONFIG_HOME = previousConfig;
  if (previousHome === undefined) delete process.env.HCANVAS_HOME;
  else process.env.HCANVAS_HOME = previousHome;
});

async function start(): Promise<HcServer> {
  const workspace = path.join(process.env.HCANVAS_HOME!, 'cfg-' + Date.now());
  const server = await startHcanvasServer({ workspace, port: 0, staticDir: path.resolve('dist/hcanvas') });
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

describe('hcanvas settings API', () => {
  it('reads and updates language, runtime and notebook settings', async () => {
    const server = await start();
    const initial = await api<{ settings: Record<string, unknown>; configPath: string }>(server, '/api/settings');
    expect(initial.configPath).toContain('hcanvas-settings.json');
    const updated = await api<{ settings: { language?: string; runtimes?: Record<string, string>; notebook?: { defaultKernel?: string }; updates?: { autoCheck?: boolean } } }>(server, '/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ language: 'zh', runtimes: { python: process.execPath, cpp: process.execPath }, notebook: { defaultKernel: 'cpp' }, updates: { autoCheck: true, channel: 'preview' } }),
    });
    expect(updated.settings.language).toBe('zh');
    expect(updated.settings.runtimes?.python).toBe(process.execPath);
    expect(updated.settings.notebook?.defaultKernel).toBe('cpp');
    expect(updated.settings.updates?.autoCheck).toBe(true);
    const reread = await api<{ settings: typeof updated.settings }>(server, '/api/settings');
    expect(reread.settings).toEqual(updated.settings);
  });

  it('detects and tests runtime commands through the settings-aware API', async () => {
    const server = await start();
    await api(server, '/api/settings', { method: 'PUT', body: JSON.stringify({ runtimes: { python: process.execPath } }) });
    const runtimes = await api<{ runtimes: Array<{ kind: string; ok: boolean; source: string; path?: string; version?: string }> }>(server, '/api/runtimes');
    const python = runtimes.runtimes.find(item => item.kind === 'python');
    expect(python?.ok).toBe(true);
    expect(python?.source).toBe('configured');
    expect(python?.path).toBe(path.resolve(process.execPath));
    expect(python?.version).toBeTruthy();
    const tested = await api<{ runtime: { kind: string; ok: boolean; path?: string } }>(server, '/api/runtimes/test', {
      method: 'POST',
      body: JSON.stringify({ kind: 'cpp', path: process.execPath }),
    });
    expect(tested.runtime.ok).toBe(true);
    expect(tested.runtime.path).toBe(path.resolve(process.execPath));
  });

  it('rejects an unknown runtime kind', async () => {
    const server = await start();
    await expect(api(server, '/api/runtimes/test', { method: 'POST', body: JSON.stringify({ kind: 'rust' }) })).rejects.toThrow(/kind must be/);
  });
});
