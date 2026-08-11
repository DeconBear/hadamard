import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { getHadamardProjectSessionDirectory } from '../src/config/projectSessionDirectory.js';
import { resolveHadamardHome } from '../src/config/hadamardHome.js';
import { startHadamardGuiServer } from '../src/gui/hadamardGui.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })));
});

async function request<T>(
  server: Awaited<ReturnType<typeof startHadamardGuiServer>>,
  requestPath: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${server.url}${requestPath.replace(/^\//u, '')}`, {
    ...init,
    headers: { 'x-hadamard-token': server.token, ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json() as T };
}

describe('GUI Design document HTTP boundary', () => {
  it('reads, revision-patches, renders, and rejects the removed legacy write endpoint', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'design-http-'));
    temporaryDirectories.push(root);
    const workDir = path.join(root, 'work');
    const homeDir = path.join(root, 'home');
    await Promise.all([mkdir(workDir), mkdir(homeDir)]);
    const configPath = path.join(homeDir, 'settings.json');
    await writeFile(configPath, JSON.stringify({ env: {
      HADAMARD_PROVIDER: 'openai', HADAMARD_API_KEY: 'test-key',
      HADAMARD_BASE_URL: 'http://127.0.0.1:1/v1', HADAMARD_MODEL: 'test-model',
    } }), 'utf8');
    const server = await startHadamardGuiServer({
      workDir, homeDir, configPath, host: '127.0.0.1',
      port: 47000 + Math.floor(Math.random() * 5000),
    });
    try {
      const initial = await request<{ state: string; revision: string }>(server, '/api/design');
      expect(initial.status).toBe(200);
      expect(initial.body.state).toBe('empty');

      const saved = await request<{ document: { content: string; revision: string } }>(server, '/api/design/patch', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# Human Design\n', expectedRevision: initial.body.revision }),
      });
      expect(saved.status).toBe(200);
      expect(saved.body.document.content).toBe('# Human Design\n');

      const stale = await request<{ error: string }>(server, '/api/design/patch', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# Stale\n', expectedRevision: initial.body.revision }),
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatch(/changed since/u);

      const rendered = await request<{ bodyHtml: string }>(server, '/api/design/render', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '<script>alert(1)</script>' }),
      });
      expect(rendered.body.bodyHtml).toContain('&lt;script&gt;');

      expect((await request(server, '/api/project-doc', { method: 'POST' })).status).toBe(410);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('exposes legacy content only as a migration preview', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'design-http-legacy-'));
    temporaryDirectories.push(root);
    const workDir = path.join(root, 'work');
    const homeDir = path.join(root, 'home');
    await Promise.all([mkdir(workDir), mkdir(homeDir)]);
    const configPath = path.join(homeDir, 'settings.json');
    await writeFile(configPath, JSON.stringify({ env: {
      HADAMARD_PROVIDER: 'openai', HADAMARD_API_KEY: 'test-key',
      HADAMARD_BASE_URL: 'http://127.0.0.1:1/v1', HADAMARD_MODEL: 'test-model',
    } }), 'utf8');
    const projectStore = getHadamardProjectSessionDirectory(workDir, resolveHadamardHome(homeDir));
    await mkdir(projectStore, { recursive: true });
    await writeFile(path.join(projectStore, 'PROGRESS.md'), '# Legacy status\n', 'utf8');
    const server = await startHadamardGuiServer({
      workDir, homeDir, configPath, host: '127.0.0.1',
      port: 47000 + Math.floor(Math.random() * 5000),
    });
    try {
      const preview = await request<{ state: string; content: string; designPath: string }>(server, '/api/design');
      expect(path.normalize(preview.body.designPath)).toBe(path.normalize(path.join(projectStore, 'DESIGN.md')));
      expect(preview.body).toMatchObject({ state: 'legacy-progress', content: '# Legacy status\n' });
      const migrated = await request<{ document: { state: string } }>(server, '/api/design/migrate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'migrate-legacy' }),
      });
      expect(migrated.body.document.state).toBe('design');
    } finally {
      await server.close();
    }
  }, 30_000);
});
