import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startHadamardGuiServer } from '../src/gui/hadamardGui.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function request<T>(
  server: Awaited<ReturnType<typeof startHadamardGuiServer>>,
  requestPath: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${server.url}${requestPath}`, {
    ...init,
    headers: {
      'x-hadamard-token': server.token,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { status: response.status, body: await response.json() as T };
}

describe('GUI Device Link API', () => {
  it('exposes identity, listener diagnostics, and one-time pairing without contacting the model', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-gui-device-link-'));
    tempDirs.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'workspace');
    await mkdir(homeDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    const configPath = path.join(homeDir, 'settings.json');
    await writeFile(configPath, JSON.stringify({
      env: {
        HADAMARD_PROVIDER: 'openai',
        HADAMARD_API_KEY: 'test-only-key',
        HADAMARD_BASE_URL: 'http://127.0.0.1:1/v1',
        HADAMARD_MODEL: 'test-model',
      },
    }), 'utf8');

    const server = await startHadamardGuiServer({
      homeDir,
      workDir,
      configPath,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const initial = await request<{
        available: boolean;
        identity: { deviceId: string; certificateFingerprint: string };
        diagnostics: { state: string };
      }>(server, 'api/devices');
      expect(initial.status).toBe(200);
      expect(initial.body.available).toBe(true);
      expect(initial.body.identity.deviceId).toMatch(/^device-[a-f0-9]{32}$/u);
      expect(initial.body.identity.certificateFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(initial.body.diagnostics.state).toBe('stopped');

      const started = await request<{ diagnostics: { state: string; url: string } }>(
        server,
        'api/devices/start',
        { method: 'POST', body: JSON.stringify({ host: '127.0.0.1', port: 0, advertise: false }) },
      );
      expect(started.status).toBe(200);
      expect(started.body.diagnostics.state).toBe('listening');
      expect(started.body.diagnostics.url).toMatch(/^wss:\/\/127\.0\.0\.1:/u);

      const pairing = await request<{
        offer: { confirmationCode: string; offeredScopes: string[] };
        uri: string;
        qrDataUrl: string;
      }>(server, 'api/devices/pairing', {
        method: 'POST',
        body: JSON.stringify({ scopes: ['session:browse'] }),
      });
      expect(pairing.status).toBe(200);
      expect(pairing.body.offer.confirmationCode).toMatch(/^\d{6}$/u);
      expect(pairing.body.offer.offeredScopes).toEqual(['session:browse']);
      expect(pairing.body.uri).toMatch(/^hadamard:\/\/pair\?/u);
      expect(pairing.body.qrDataUrl).toMatch(/^data:image\/png;base64,/u);

      const invalidScopes = await request<{ error: string }>(server, 'api/devices/pairing', {
        method: 'POST',
        body: JSON.stringify({ scopes: ['admin'] }),
      });
      expect(invalidScopes.status).toBe(400);
      expect(invalidScopes.body.error).toContain('Unknown Device Link scope');

      const stopped = await request<{ diagnostics: { state: string } }>(server, 'api/devices/stop', { method: 'POST' });
      expect(stopped.status).toBe(200);
      expect(stopped.body.diagnostics.state).toBe('stopped');
    } finally {
      await server.close();
    }
  }, 30_000);
});
