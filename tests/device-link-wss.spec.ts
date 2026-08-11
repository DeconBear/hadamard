import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { AppServer } from '../src/app-server/index.js';
import {
  createPairingCompletion,
  createSignedDeviceLinkRequest,
  DeviceIdentityStore,
  DeviceLinkAuditStore,
  DeviceLinkAuthorizationService,
  DeviceLinkGateway,
  DeviceLinkWssServer,
  DevicePairingService,
  PairedDeviceRegistry,
  withoutSecrets,
  DEFAULT_DEVICE_LINK_LIMITS,
  type DeviceIdentityCredentials,
} from '../src/device-link/index.js';
import type { HadamardAgentClient } from '../src/runtime/agentClient.js';

const roots: string[] = [];
const servers: DeviceLinkWssServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map(server => server.stop()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Device Link WSS boundary', () => {
  it('serves protocol v2 over TLS and enforces client certificate pinning and replay protection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-device-link-wss-'));
    roots.push(root);
    const local = await identity(root, 'desktop');
    const remote = await identity(root, 'phone');
    const swappedCertificate = await identity(root, 'replacement-certificate');
    const registry = new PairedDeviceRegistry(path.join(root, 'paired.json'));
    const pairing = new DevicePairingService(local, registry);
    const offer = pairing.begin({
      address: '127.0.0.1',
      port: 43100,
      offeredScopes: ['session:browse'],
    });
    await pairing.complete(createPairingCompletion(offer, remote, ['session:browse']));
    const sdk = {
      sessions: { list: vi.fn(async () => [{ id: 'session-1', title: 'One' }]) },
    } as unknown as HadamardAgentClient;
    const gateway = new DeviceLinkGateway({
      appServer: new AppServer(sdk),
      identity: withoutSecrets(local),
      pairing,
      authorization: new DeviceLinkAuthorizationService(
        local,
        registry,
        new DeviceLinkAuditStore(path.join(root, 'audit.jsonl')),
      ),
      limits: DEFAULT_DEVICE_LINK_LIMITS,
    });
    const server = new DeviceLinkWssServer({
      gateway,
      identity: local,
      limits: DEFAULT_DEVICE_LINK_LIMITS,
      host: '127.0.0.1',
    });
    servers.push(server);
    const address = await server.start();
    expect(address.url).toMatch(/^wss:\/\/127\.0\.0\.1:/u);

    const client = await connect(address.url, remote);
    expect(await exchange(client, {
      version: 2,
      id: 'initialize',
      method: 'initialize',
      params: {},
    })).toMatchObject({
      result: { protocolVersion: 2, device: { deviceId: local.deviceId } },
    });
    const browse = createSignedDeviceLinkRequest({
      version: 2,
      id: 'browse',
      method: 'session/list',
      params: {},
    }, remote, 1);
    expect(await exchange(client, browse)).toMatchObject({
      result: [{ id: 'session-1', title: 'One' }],
    });
    expect(await exchange(client, browse)).toMatchObject({
      error: { code: 'DEVICE_LINK_ERROR', message: expect.stringContaining('replayed') },
    });

    const swapped = await connect(address.url, swappedCertificate);
    const next = createSignedDeviceLinkRequest({
      version: 2,
      id: 'certificate-swap',
      method: 'session/list',
      params: {},
    }, remote, 2);
    expect(await exchange(swapped, next)).toMatchObject({
      error: { code: 'CERTIFICATE_MISMATCH' },
    });

    await registry.revoke(remote.deviceId);
    expect(await exchange(client, next)).toMatchObject({
      error: { code: 'DEVICE_NOT_PAIRED' },
    });
    expect(await exchange(client, {
      version: 1,
      id: 'legacy',
      method: 'initialize',
    })).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });
});

async function identity(root: string, name: string): Promise<DeviceIdentityCredentials> {
  return new DeviceIdentityStore(path.join(root, name)).loadOrCreate(name);
}

async function connect(url: string, identity: DeviceIdentityCredentials): Promise<WebSocket> {
  const socket = new WebSocket(url, {
    cert: identity.tlsCertificatePem,
    key: identity.tlsPrivateKeyPem,
    rejectUnauthorized: false,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

async function exchange(socket: WebSocket, request: unknown): Promise<Record<string, unknown>> {
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      cleanup();
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('message', onMessage);
      socket.off('error', onError);
    };
    socket.once('message', onMessage);
    socket.once('error', onError);
  });
  socket.send(JSON.stringify(request));
  return response;
}
