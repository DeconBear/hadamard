import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { GuiHttpRouter } from '../src/gui/guiHttpRouter.js';
import {
  registerGuiUsageRoutingHttpController,
  type GuiUsageRoutingPort,
} from '../src/gui/guiUsageRoutingHttpController.js';

function request(method: string, body?: unknown): IncomingMessage {
  return {
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  } as unknown as IncomingMessage;
}

function response(): ServerResponse & { status?: number; body?: unknown } {
  const result = {
    writeHead: vi.fn((status: number) => { result.status = status; return result; }),
    end: vi.fn((body?: string | Buffer) => {
      result.body = typeof body === 'string' ? JSON.parse(body) : body;
      return result;
    }),
  } as unknown as ServerResponse & { status?: number; body?: unknown };
  return result;
}

function port(): GuiUsageRoutingPort {
  return {
    overview: vi.fn(() => ({ summary: { entries: 0 }, trend: [], byProvider: [], unknownUsageEntries: 0 } as never)),
    ledger: vi.fn(() => ({ summary: {}, events: [] } as never)),
    catalog: vi.fn(async () => ({ targets: [], routes: [], budgets: [], credentials: [] })),
    saveCredential: vi.fn(async body => ({ id: String(body.id) })),
    deleteCredential: vi.fn(async () => true),
    testCredential: vi.fn(async id => ({ id, state: 'healthy' })),
    saveTarget: vi.fn(body => ({ id: String(body.id) })),
    deleteTarget: vi.fn(() => true),
    testTarget: vi.fn(async id => ({ id, state: 'authenticated' })),
    saveRoute: vi.fn(async body => ({ id: String(body.id) })),
    deleteRoute: vi.fn(() => true),
    saveBudget: vi.fn(body => ({ id: String(body.id) })),
    deleteBudget: vi.fn(() => true),
    gatewayStatus: vi.fn(() => ({ running: false, authentication: 'client-key' })),
    startGateway: vi.fn(async () => ({ running: true, url: 'http://127.0.0.1:1234', authentication: 'client-key', clientKey: 'db_sk_once' })),
    stopGateway: vi.fn(async () => ({ running: false, authentication: 'client-key' })),
    previewBridgeMigration: vi.fn(() => ({ source: 'bridge-configs' as const, items: [], ready: 0, blocked: 0, oauthSessionSecretsRead: false as const })),
    importBridgeMigration: vi.fn(async () => ({ imported: 0 })),
    previewPortableMigration: vi.fn(async () => ({ source: 'keyway-export-v1' as const, counts: {}, secretsIncluded: false as const, issuedKeysRequireRotation: false })),
    importPortableMigration: vi.fn(async () => ({ imported: 0 })),
  };
}

async function invoke(
  target: GuiUsageRoutingPort,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<ReturnType<typeof response>> {
  const router = new GuiHttpRouter();
  registerGuiUsageRoutingHttpController(router, target);
  const res = response();
  expect(await router.handle(request(method, body), res, new URL(`http://localhost${pathname}`))).toBe(true);
  return res;
}

describe('GUI Usage & Routing HTTP controller', () => {
  it('parses ledger filters and pagination without accepting arbitrary values', async () => {
    const target = port();
    await invoke(target, 'GET', '/api/usage-routing/ledger?providerId=ark&status=succeeded&limit=25&offset=50');
    expect(target.ledger).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'ark', status: 'succeeded', limit: 25, offset: 50,
    }));
  });

  it('delegates write-only credential mutations and health tests', async () => {
    const target = port();
    await invoke(target, 'PUT', '/api/usage-routing/credentials', {
      id: 'credential.ark', providerId: 'ark', secret: 'fixture-secret',
    });
    await invoke(target, 'POST', '/api/usage-routing/credentials/credential.ark/test');
    await invoke(target, 'DELETE', '/api/usage-routing/credentials/credential.ark');
    expect(target.saveCredential).toHaveBeenCalledWith(expect.objectContaining({ secret: 'fixture-secret' }));
    expect(target.testCredential).toHaveBeenCalledWith('credential.ark');
    expect(target.deleteCredential).toHaveBeenCalledWith('credential.ark');
  });

  it('starts and stops the authenticated loopback gateway', async () => {
    const target = port();
    const started = await invoke(target, 'POST', '/api/usage-routing/gateway/start', { port: 0 });
    expect(started.body).toMatchObject({ running: true, authentication: 'client-key' });
    expect(target.startGateway).toHaveBeenCalledWith(0);
    await invoke(target, 'POST', '/api/usage-routing/gateway/stop');
    expect(target.stopGateway).toHaveBeenCalledOnce();
  });

  it('maps validation failures to 400 without reflecting request secrets', async () => {
    const target = port();
    vi.mocked(target.saveCredential).mockRejectedValue(new TypeError('Invalid credential metadata.'));
    const res = await invoke(target, 'PUT', '/api/usage-routing/credentials', { secret: 'fixture-secret' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('fixture-secret');
  });
});
