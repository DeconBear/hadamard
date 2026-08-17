import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildProviderSharePayload,
  PROVIDER_SHARE_QR_TYPE,
} from '../src/device-link/providerShare.js';
import { startHadamardGuiServer } from '../src/gui/hadamardGui.js';
import { writeBridgeConfigs, type PersistedBridgeConfig } from '../src/parity/bridgeConfigs.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function shareableConfig(overrides: Partial<PersistedBridgeConfig> = {}): PersistedBridgeConfig {
  return {
    name: 'mobile-openai',
    runtime: 'hadamard',
    provider: 'openai',
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-test-1234567890abcdef',
    models: [{ name: 'gpt-4o-mini' }],
    ...overrides,
  };
}

describe('buildProviderSharePayload', () => {
  it('encodes name, endpoint, first model and API key statically', () => {
    const payload = buildProviderSharePayload(shareableConfig());
    expect(payload).toEqual({
      type: PROVIDER_SHARE_QR_TYPE,
      version: 1,
      displayName: 'mobile-openai',
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-1234567890abcdef',
    });
  });

  it('falls back to the selected model when no model list exists', () => {
    const payload = buildProviderSharePayload(shareableConfig({ models: undefined, model: 'gpt-4o' }));
    expect(payload.model).toBe('gpt-4o');
  });

  it('rejects non-HTTPS endpoints, missing models and missing keys', () => {
    expect(() => buildProviderSharePayload(shareableConfig({ baseURL: 'http://insecure.local/v1' })))
      .toThrow(/HTTPS base URL/);
    expect(() => buildProviderSharePayload(shareableConfig({ models: [], model: undefined })))
      .toThrow(/no model/);
    expect(() => buildProviderSharePayload(shareableConfig({ apiKey: undefined })))
      .toThrow(/no API key/);
  });
});

describe('GUI /api/bridge/provider-qr', () => {
  async function bootServer(configs: PersistedBridgeConfig[]) {
    const root = await tempRoot('hadamard-gui-provider-qr-');
    const userHome = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    await mkdir(path.join(userHome, '.hadamard'), { recursive: true });
    await mkdir(workDir, { recursive: true });
    await writeFile(path.join(userHome, '.hadamard', 'settings.json'), JSON.stringify({
      HADAMARD_PROVIDER: 'openai',
      HADAMARD_API_KEY: 'test-key',
      HADAMARD_MODEL: 'gpt-4o-mini',
    }), 'utf8');
    writeBridgeConfigs({ configs }, userHome);
    const port = 46000 + Math.floor(Math.random() * 10000);
    const server = await startHadamardGuiServer({ workDir, homeDir: userHome, host: '127.0.0.1', port });
    return server;
  }

  async function post(
    server: Awaited<ReturnType<typeof startHadamardGuiServer>>,
    body: unknown,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(new URL('api/bridge/provider-qr', server.url), {
      method: 'POST',
      headers: { 'x-hadamard-token': server.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it('returns a QR data URL and a masked provider summary for a shareable config', async () => {
    const server = await bootServer([shareableConfig()]);
    try {
      const res = await post(server, { name: 'mobile-openai' });
      expect(res.status).toBe(200);
      expect(res.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(res.body.provider).toEqual({
        displayName: 'mobile-openai',
        endpoint: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        apiKeyMasked: expect.not.stringContaining('sk-test-1234567890abcdef'),
      });
      // The plaintext key must only exist inside the QR image, never in the summary.
      expect(JSON.stringify(res.body.provider)).not.toContain('sk-test-1234567890abcdef');
    } finally {
      await server.close();
    }
  });

  it('rejects missing, unknown and unshareable configs', async () => {
    const server = await bootServer([
      shareableConfig(),
      shareableConfig({ name: 'no-key', apiKey: undefined }),
    ]);
    try {
      expect((await post(server, {})).status).toBe(400);
      expect((await post(server, { name: 'nope' })).status).toBe(404);
      const noKey = await post(server, { name: 'no-key' });
      expect(noKey.status).toBe(400);
      expect(noKey.body.error).toMatch(/no API key/);
    } finally {
      await server.close();
    }
  });
});
