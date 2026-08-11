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

  it('exports all formats, commits validated imports, and serves revocable immutable shares', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'design-http-transfer-'));
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
      const initial = await request<{ revision: string; templates: unknown[] }>(server, '/api/design');
      expect(initial.body.templates).toHaveLength(8);
      const saved = await request<{ document: { revision: string } }>(server, '/api/design/patch', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# Transfer Design\n\n## Goal\n\nShip safely.\n', expectedRevision: initial.body.revision }),
      });
      const exported: Record<string, { status: number; body: { contentBase64: string; mediaType: string; fileName: string } }> = {};
      for (const format of ['html', 'pdf', 'package']) {
        exported[format] = await request(server, `/api/design/export/${format}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
        });
        expect(exported[format]?.status).toBe(200);
      }
      expect(Buffer.from(exported.pdf!.body.contentBase64, 'base64').subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(Buffer.from(exported.package!.body.contentBase64, 'base64').subarray(0, 2).toString('ascii')).toBe('PK');
      const reference = await request<{ artifact: { id: string; mediaType: string } }>(server, '/api/design/import/reference', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: 'published.pdf', contentBase64: exported.pdf!.body.contentBase64, confirmed: true }),
      });
      expect(reference.body.artifact).toMatchObject({ mediaType: 'application/pdf' });

      const preview = await request<{ kind: string; editable: boolean }>(server, '/api/design/import/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: exported.package!.body.fileName, contentBase64: exported.package!.body.contentBase64 }),
      });
      expect(preview.body).toMatchObject({ kind: 'hadamard-package', editable: true });
      const committed = await request<{ document: { revision: string } }>(server, '/api/design/import/commit', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: exported.package!.body.fileName, contentBase64: exported.package!.body.contentBase64,
          action: 'new-copy', expectedRevision: saved.body.document.revision, confirmed: true }),
      });
      expect(committed.status).toBe(200);

      const shared = await request<{ token: string; url: string; snapshot: { artifacts: Record<string, unknown> } }>(server, '/api/design/share', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: committed.body.document.revision, expiresInHours: 24 }),
      });
      expect(Object.keys(shared.body.snapshot.artifacts).sort()).toEqual(['html', 'package', 'pdf']);
      const page = await fetch(`${server.url.replace(/\/$/u, '')}${shared.body.url}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('immutable snapshot');
      const packageDownload = await fetch(`${server.url.replace(/\/$/u, '')}${shared.body.url}/package`);
      expect(Buffer.from(await packageDownload.arrayBuffer()).subarray(0, 2).toString('ascii')).toBe('PK');

      expect((await request(server, '/api/design/share/revoke', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: shared.body.token }),
      })).status).toBe(200);
      expect((await fetch(`${server.url.replace(/\/$/u, '')}${shared.body.url}`)).status).toBe(404);
    } finally {
      await server.close();
    }
  }, 45_000);
});
