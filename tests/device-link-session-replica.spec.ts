import { afterEach, describe, expect, it } from 'vitest';

import {
  DeviceLinkSessionReplicaService,
} from '../src/device-link/index.js';
import {
  SqliteStorageV2,
  type DurableStorageV2,
} from '../src/storage-v2/index.js';

const stores: DurableStorageV2[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
});

describe('Device Link session replication', () => {
  it('uses Storage V2 snapshots and ordered items for resumable read-only cache and explicit copy', async () => {
    const storage = await SqliteStorageV2.open({ filename: ':memory:' });
    stores.push(storage);
    let source = await storage.sessions.create({
      tenantId: 'source-tenant',
      sessionId: 'source-session',
      metadata: { title: 'Source' },
    });
    source = await storage.sessions.append({
      tenantId: source.tenantId,
      sessionId: source.sessionId,
      expectedRevision: source.revision,
      items: [
        { itemId: 'm1', kind: 'message', payload: { text: 'one' } },
        { itemId: 'm2', kind: 'message', payload: { text: 'two' } },
      ],
    });
    await storage.sessions.compact({
      tenantId: source.tenantId,
      sessionId: source.sessionId,
      expectedRevision: source.revision,
      throughSequence: 1,
      state: { summary: 'one' },
    });

    const sourceReplica = new DeviceLinkSessionReplicaService(
      storage.sessions,
      'desktop-device',
      'source-tenant',
    );
    const targetReplica = new DeviceLinkSessionReplicaService(
      storage.sessions,
      'phone-device',
      'target-tenant',
    );
    const first = await sourceReplica.snapshot('source-session');
    expect(first).toMatchObject({
      originDeviceId: 'desktop-device',
      originSessionId: 'source-session',
      snapshot: { throughSequence: 1 },
      items: [{ sequence: 2 }],
      complete: true,
    });
    const cached = await targetReplica.cache(first);
    expect(cached).toMatchObject({ readOnly: true, originSessionId: 'source-session' });
    const afterFirstCache = await storage.sessions.get({
      tenantId: 'target-tenant',
      sessionId: cached.sessionId,
    });
    await targetReplica.cache(first);
    expect(await storage.sessions.get({
      tenantId: 'target-tenant',
      sessionId: cached.sessionId,
    })).toEqual(afterFirstCache);

    source = (await storage.sessions.get({ tenantId: 'source-tenant', sessionId: 'source-session' }))!;
    await storage.sessions.append({
      tenantId: source.tenantId,
      sessionId: source.sessionId,
      expectedRevision: source.revision,
      items: [{ itemId: 'm3', kind: 'message', payload: { text: 'three' } }],
    });
    const incremental = await sourceReplica.items('source-session', 2);
    expect(incremental.items).toEqual([expect.objectContaining({ sequence: 3 })]);
    const resumed = await targetReplica.cache(incremental);
    expect(resumed.lastSequence).toBeGreaterThan(cached.lastSequence);

    const complete = await sourceReplica.snapshot('source-session');
    const copied = await targetReplica.copy(complete, 'local-copy');
    expect(copied).toMatchObject({
      sessionId: 'local-copy',
      readOnly: false,
      originDeviceId: 'desktop-device',
      originSessionId: 'source-session',
    });
    const copiedRecord = await storage.sessions.get({
      tenantId: 'target-tenant',
      sessionId: 'local-copy',
    });
    expect(copiedRecord?.metadata).toMatchObject({
      kind: 'device-link-copy',
      readOnly: false,
      originSessionId: 'source-session',
    });
    await expect(targetReplica.copy({ ...incremental, complete: false }, 'partial-copy'))
      .rejects.toThrow('complete source packet');
  });
});
