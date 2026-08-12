import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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
  it('reads, revision-patches, renders, and exposes the project document endpoints', async () => {
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

      const saved = await request<{ entry: { content: string; revision: string } }>(server, '/api/design/entry', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'markdown', content: '# Human Design\n', expectedRevision: initial.body.revision }),
      });
      expect(saved.status).toBe(200);
      expect(saved.body.entry.content).toBe('# Human Design\n');

      const stale = await request<{ error: string }>(server, '/api/design/entry', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'markdown', content: '# Stale\n', expectedRevision: initial.body.revision }),
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toMatch(/changed since/u);

      const rendered = await request<{ bodyHtml: string }>(server, '/api/design/render', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '<script>alert(1)</script>' }),
      });
      expect(rendered.body.bodyHtml).toContain('&lt;script&gt;');

      const htmlEntry = await request<{ entry: { path: string; revision: string } }>(server, '/api/design/entry', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'html', content: '<!doctype html><h1>Design</h1>' }),
      });
      expect(htmlEntry.status).toBe(200);
      expect(path.normalize(htmlEntry.body.entry.path)).toBe(
        path.normalize(path.join(workDir, '.hadamard', 'design', 'design.html')),
      );
      const refreshedHtml = await request<{ content: string; revision: string }>(server, '/api/design/refresh', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'html' }),
      });
      expect(refreshedHtml.body).toMatchObject({
        content: '<!doctype html><h1>Design</h1>', revision: htmlEntry.body.entry.revision,
      });

      expect((await request(server, '/api/project-doc', { method: 'POST' })).status).toBe(404);

      const agents = await request<{ content: string; name: string }>(server, '/api/project-agents-doc');
      expect(agents.status).toBe(200);
      expect(agents.body).toMatchObject({ content: '', name: 'AGENTS.md' });
      const savedAgents = await request<{ content: string }>(server, '/api/project-agents-doc', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# Project rules\n' }),
      });
      expect(savedAgents.body.content).toBe('# Project rules\n');
    } finally {
      await server.close();
    }
  }, 30_000);

  it('exports all formats and commits validated imports', async () => {
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
      const saved = await request<{ entry: { revision: string } }>(server, '/api/design/entry', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'markdown', content: '# Transfer Design\n\n## Goal\n\nShip safely.\n', expectedRevision: initial.body.revision }),
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

      const preview = await request<{ kind: string; editable: boolean; changes: unknown[] }>(server, '/api/design/import/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: exported.package!.body.fileName, contentBase64: exported.package!.body.contentBase64 }),
      });
      expect(preview.body).toMatchObject({ kind: 'hadamard-workspace-bundle', editable: true });
      const committed = await request<{ workspace: { entries: { markdown: { revision: string } } } }>(server, '/api/design/import/commit', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: exported.package!.body.fileName, contentBase64: exported.package!.body.contentBase64,
          expectedChanges: preview.body.changes, confirmed: true }),
      });
      expect(committed.status).toBe(200);

      expect(committed.body.workspace.entries.markdown.revision).toBeTruthy();
    } finally {
      await server.close();
    }
  }, 45_000);
});
