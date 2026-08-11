import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createPairingCompletion,
  createSignedDeviceLinkRequest,
  DeviceIdentityStore,
  DeviceLinkAuditStore,
  DeviceLinkAuthorizationError,
  DeviceLinkAuthorizationService,
  DevicePairingService,
  PairedDeviceRegistry,
  canonicalJson,
  sha256,
  type DeviceIdentityCredentials,
  type DeviceLinkScope,
} from '../src/device-link/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Device Link threat model', () => {
  it('persists stable identities and completes a signed, single-use pairing challenge', async () => {
    const root = await tempRoot();
    const local = await identity(root, 'desktop');
    const remote = await identity(root, 'phone');
    const reloaded = await new DeviceIdentityStore(path.join(root, 'desktop')).loadOrCreate('ignored');
    expect(reloaded).toEqual(local);

    const registry = new PairedDeviceRegistry(path.join(root, 'paired.json'));
    const pairing = new DevicePairingService(local, registry);
    const scopes: DeviceLinkScope[] = ['session:browse', 'session:send', 'approval:respond'];
    const offer = pairing.begin({
      address: '192.168.1.5',
      port: 43100,
      offeredScopes: scopes,
    });
    const completion = createPairingCompletion(offer, remote, scopes);
    const result = await pairing.complete(completion);
    expect(result.device).toMatchObject({
      deviceId: remote.deviceId,
      certificateFingerprint: remote.certificateFingerprint,
      scopes: [...scopes].sort(),
      lastSequence: 0,
    });
    expect(result.serverSignature).toMatch(/^[A-Za-z0-9_-]+$/u);
    await expect(pairing.complete(completion)).rejects.toThrow('already used');
  });

  it('fails closed for unpaired, replayed, stale, certificate-swapped, revoked, and over-scoped requests', async () => {
    const root = await tempRoot();
    const local = await identity(root, 'desktop');
    const remote = await identity(root, 'phone');
    const attacker = await identity(root, 'attacker');
    const registry = new PairedDeviceRegistry(path.join(root, 'paired.json'));
    await pair(local, remote, registry, ['session:browse', 'approval:respond']);
    const audit = new DeviceLinkAuditStore(path.join(root, 'audit.jsonl'));
    const authorization = new DeviceLinkAuthorizationService(local, registry, audit);
    const context = {
      certificateFingerprint: remote.certificateFingerprint,
      peerUnlocked: false,
      remoteAddress: '192.168.1.8',
    };

    const browse = createSignedDeviceLinkRequest({
      version: 2,
      id: 'browse-1',
      method: 'session/list',
      params: {},
    }, remote, 1);
    await expect(authorization.authorize(browse, context)).resolves.toMatchObject({
      deviceId: remote.deviceId,
    });
    await expect(authorization.authorize(browse, context)).rejects.toMatchObject({
      message: expect.stringContaining('replayed'),
    });

    const unpaired = createSignedDeviceLinkRequest({
      version: 2,
      id: 'unpaired',
      method: 'session/list',
    }, attacker, 1);
    await expect(authorization.authorize(unpaired, {
      ...context,
      certificateFingerprint: attacker.certificateFingerprint,
    })).rejects.toMatchObject({ code: 'DEVICE_NOT_PAIRED' });

    const stale = createSignedDeviceLinkRequest({
      version: 2,
      id: 'stale',
      method: 'session/list',
    }, remote, 2, '2020-01-01T00:00:00.000Z');
    await expect(authorization.authorize(stale, context)).rejects.toMatchObject({ code: 'CLOCK_SKEW' });

    const certSwap = createSignedDeviceLinkRequest({
      version: 2,
      id: 'cert-swap',
      method: 'session/list',
    }, remote, 2);
    await expect(authorization.authorize(certSwap, {
      ...context,
      certificateFingerprint: attacker.certificateFingerprint,
    })).rejects.toMatchObject({ code: 'CERTIFICATE_MISMATCH' });

    const send = createSignedDeviceLinkRequest({
      version: 2,
      id: 'send-denied',
      method: 'session/send',
      params: { sessionId: 'one', input: 'hello' },
    }, remote, 2);
    await expect(authorization.authorize(send, context)).rejects.toMatchObject({ code: 'SCOPE_DENIED' });

    await registry.revoke(remote.deviceId);
    const revoked = createSignedDeviceLinkRequest({
      version: 2,
      id: 'revoked',
      method: 'session/list',
    }, remote, 2);
    await expect(authorization.authorize(revoked, context)).rejects.toMatchObject({
      code: 'DEVICE_NOT_PAIRED',
    });
    expect(await audit.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'session/list', outcome: 'allowed' }),
      expect.objectContaining({ method: 'session/list', outcome: 'denied' }),
    ]));
  });

  it('binds remote approvals to user presence, target device, workspace, tool, and parameter hash', async () => {
    const root = await tempRoot();
    const local = await identity(root, 'desktop');
    const remote = await identity(root, 'phone');
    const registry = new PairedDeviceRegistry(path.join(root, 'paired.json'));
    await pair(local, remote, registry, ['approval:respond']);
    const authorization = new DeviceLinkAuthorizationService(
      local,
      registry,
      new DeviceLinkAuditStore(path.join(root, 'audit.jsonl')),
    );
    const params = {
      confirm: true,
      approval: { id: 'approval-1', tool: 'Bash', behavior: 'deny' },
      remoteContext: {
        targetDeviceId: local.deviceId,
        requestingDeviceId: remote.deviceId,
        workspaceId: 'workspace-1',
        tool: 'Bash',
        parametersSha256: sha256(canonicalJson({ id: 'approval-1', tool: 'Bash', behavior: 'deny' })),
        foregroundConfirmed: true,
      },
    };
    const locked = createSignedDeviceLinkRequest({
      version: 2,
      id: 'approval-locked',
      method: 'approval/remember',
      params,
    }, remote, 1);
    await expect(authorization.authorize(locked, {
      certificateFingerprint: remote.certificateFingerprint,
      peerUnlocked: false,
    })).rejects.toMatchObject({ code: 'DEVICE_LOCKED' });

    const wrongTool = createSignedDeviceLinkRequest({
      version: 2,
      id: 'approval-wrong-tool',
      method: 'approval/remember',
      params: {
        ...params,
        remoteContext: { ...params.remoteContext, tool: 'Write' },
      },
    }, remote, 1);
    await expect(authorization.authorize(wrongTool, {
      certificateFingerprint: remote.certificateFingerprint,
      peerUnlocked: true,
    })).rejects.toMatchObject({ code: 'APPROVAL_CONTEXT_INVALID' });

    const valid = createSignedDeviceLinkRequest({
      version: 2,
      id: 'approval-valid',
      method: 'approval/remember',
      params,
    }, remote, 1);
    await expect(authorization.authorize(valid, {
      certificateFingerprint: remote.certificateFingerprint,
      peerUnlocked: true,
    })).resolves.toMatchObject({ deviceId: remote.deviceId });
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-device-link-'));
  roots.push(root);
  return root;
}

function identity(root: string, name: string): Promise<DeviceIdentityCredentials> {
  return new DeviceIdentityStore(path.join(root, name)).loadOrCreate(name);
}

async function pair(
  local: DeviceIdentityCredentials,
  remote: DeviceIdentityCredentials,
  registry: PairedDeviceRegistry,
  scopes: DeviceLinkScope[],
): Promise<void> {
  const pairing = new DevicePairingService(local, registry);
  const offer = pairing.begin({ address: '192.168.1.5', port: 43100, offeredScopes: scopes });
  await pairing.complete(createPairingCompletion(offer, remote, scopes));
}
