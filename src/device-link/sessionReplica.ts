import { randomUUID } from 'node:crypto';

import type { SessionStoreV2 } from '../storage-v2/contracts.js';
import type {
  JsonObject,
  JsonValue,
  LoadedSession,
  SessionItem,
  SessionRecord,
  SessionSnapshot,
} from '../storage-v2/types.js';
import { sha256 } from './crypto.js';

const MAX_REPLICA_ITEMS = 1_000;

export interface DeviceLinkSessionPacket {
  schemaVersion: 1;
  originDeviceId: string;
  originSessionId: string;
  originRevision: number;
  session: SessionRecord;
  snapshot?: SessionSnapshot;
  items: SessionItem[];
  complete: boolean;
}

export interface SessionReplicaResult {
  sessionId: string;
  revision: number;
  lastSequence: number;
  readOnly: boolean;
  originDeviceId: string;
  originSessionId: string;
  originRevision: number;
}

export class DeviceLinkSessionReplicaService {
  constructor(
    private readonly store: SessionStoreV2,
    private readonly localDeviceId: string,
    private readonly localTenantId: string,
    private readonly beforeRead?: (sessionId: string) => Promise<void>,
  ) {}

  async snapshot(sessionId: string): Promise<DeviceLinkSessionPacket> {
    await this.beforeRead?.(sessionId);
    const loaded = await this.store.load({
      tenantId: this.localTenantId,
      sessionId,
      useSnapshot: true,
      limit: MAX_REPLICA_ITEMS,
    });
    return this.packet(loaded, loaded.snapshot?.throughSequence ?? 0);
  }

  async items(sessionId: string, afterSequence: number): Promise<DeviceLinkSessionPacket> {
    assertSequence(afterSequence);
    await this.beforeRead?.(sessionId);
    const loaded = await this.store.load({
      tenantId: this.localTenantId,
      sessionId,
      afterSequence,
      useSnapshot: false,
      limit: MAX_REPLICA_ITEMS,
    });
    return this.packet(loaded, afterSequence);
  }

  async cache(packet: DeviceLinkSessionPacket): Promise<SessionReplicaResult> {
    validatePacket(packet);
    const sessionId = `cache-${sha256(`${packet.originDeviceId}\0${packet.originSessionId}`).slice(0, 40)}`;
    return this.importPacket(packet, sessionId, true);
  }

  async copy(packet: DeviceLinkSessionPacket, requestedSessionId?: string): Promise<SessionReplicaResult> {
    validatePacket(packet);
    if (!packet.complete) throw new Error('Explicit session copy requires a complete source packet.');
    const sessionId = requestedSessionId?.trim() || randomUUID();
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(sessionId)) throw new Error('Target session id is invalid.');
    if (await this.store.get({ tenantId: this.localTenantId, sessionId })) {
      throw new Error(`Target session already exists: ${sessionId}`);
    }
    return this.importPacket(packet, sessionId, false);
  }

  private packet(loaded: LoadedSession, afterSequence: number): DeviceLinkSessionPacket {
    const lastReturned = loaded.items.at(-1)?.sequence ?? afterSequence;
    return {
      schemaVersion: 1,
      originDeviceId: this.localDeviceId,
      originSessionId: loaded.session.sessionId,
      originRevision: loaded.session.revision,
      session: structuredClone(loaded.session),
      ...(loaded.snapshot ? { snapshot: structuredClone(loaded.snapshot) } : {}),
      items: structuredClone(loaded.items),
      complete: loaded.session.lastSequence <= lastReturned,
    };
  }

  private async importPacket(
    packet: DeviceLinkSessionPacket,
    sessionId: string,
    readOnly: boolean,
  ): Promise<SessionReplicaResult> {
    let target = await this.store.get({ tenantId: this.localTenantId, sessionId });
    if (!target) {
      target = await this.store.create({
        tenantId: this.localTenantId,
        sessionId,
        metadata: replicaMetadata(packet, readOnly),
      });
    } else {
      assertMatchingOrigin(target.metadata, packet, readOnly);
    }
    const loadedAll = await this.store.load({
      tenantId: this.localTenantId,
      sessionId,
      afterSequence: 0,
      useSnapshot: false,
      limit: 100_000,
    });
    let lastSourceSequence = sourceSequenceFromSnapshot(
      (await this.store.load({ tenantId: this.localTenantId, sessionId, useSnapshot: true, limit: 1 })).snapshot,
    );
    for (const item of loadedAll.items) {
      lastSourceSequence = Math.max(lastSourceSequence, sourceSequenceFromReplicaItem(item));
    }
    const nextItems = packet.items
      .filter(item => item.sequence > lastSourceSequence)
      .sort((left, right) => left.sequence - right.sequence);
    if (nextItems.length > 0) {
      target = await this.store.append({
        tenantId: this.localTenantId,
        sessionId,
        expectedRevision: target.revision,
        items: nextItems.map(item => ({
          itemId: `remote-${item.sequence}-${sha256(item.itemId).slice(0, 16)}`,
          kind: 'device-link.remote-item',
          payload: {
            sourceSequence: item.sequence,
            sourceItemId: item.itemId,
            sourceKind: item.kind,
            sourcePayload: item.payload,
            sourceCreatedAt: item.createdAt,
          },
          createdAt: item.createdAt,
        })),
      });
    }
    if (packet.snapshot) {
      const refreshed = await this.store.load({
        tenantId: this.localTenantId,
        sessionId,
        afterSequence: 0,
        useSnapshot: false,
        limit: 100_000,
      });
      const throughTarget = refreshed.items
        .filter(item => sourceSequenceFromReplicaItem(item) <= packet.snapshot!.throughSequence)
        .at(-1)?.sequence ?? 0;
      const currentSnapshot = (await this.store.load({
        tenantId: this.localTenantId,
        sessionId,
        useSnapshot: true,
        limit: 1,
      })).snapshot;
      if (!currentSnapshot || throughTarget > currentSnapshot.throughSequence) {
        await this.store.compact({
          tenantId: this.localTenantId,
          sessionId,
          expectedRevision: target.revision,
          throughSequence: throughTarget,
          state: {
            schemaVersion: 1,
            kind: 'device-link-session-replica',
            originDeviceId: packet.originDeviceId,
            originSessionId: packet.originSessionId,
            originRevision: packet.originRevision,
            lastSourceSequence: packet.snapshot.throughSequence,
            sourceState: packet.snapshot.state,
            readOnly,
          },
        });
        target = (await this.store.get({ tenantId: this.localTenantId, sessionId }))!;
      }
    }
    return {
      sessionId,
      revision: target.revision,
      lastSequence: target.lastSequence,
      readOnly,
      originDeviceId: packet.originDeviceId,
      originSessionId: packet.originSessionId,
      originRevision: packet.originRevision,
    };
  }
}

function replicaMetadata(packet: DeviceLinkSessionPacket, readOnly: boolean): JsonObject {
  return {
    schemaVersion: 1,
    kind: readOnly ? 'device-link-cache' : 'device-link-copy',
    readOnly,
    originDeviceId: packet.originDeviceId,
    originSessionId: packet.originSessionId,
    originRevision: packet.originRevision,
  };
}

function assertMatchingOrigin(
  metadata: JsonObject,
  packet: DeviceLinkSessionPacket,
  readOnly: boolean,
): void {
  if (metadata.originDeviceId !== packet.originDeviceId
    || metadata.originSessionId !== packet.originSessionId
    || metadata.readOnly !== readOnly) {
    throw new Error('Session replica origin does not match the existing target.');
  }
  if (!readOnly) throw new Error('A writable session copy cannot be updated from its origin.');
}

function sourceSequenceFromSnapshot(snapshot: SessionSnapshot | undefined): number {
  if (!snapshot || !snapshot.state || typeof snapshot.state !== 'object' || Array.isArray(snapshot.state)) {
    return 0;
  }
  const value = (snapshot.state as Record<string, JsonValue>).lastSourceSequence;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0;
}

function sourceSequenceFromReplicaItem(item: SessionItem): number {
  if (item.kind !== 'device-link.remote-item'
    || !item.payload
    || typeof item.payload !== 'object'
    || Array.isArray(item.payload)) return 0;
  const value = (item.payload as Record<string, JsonValue>).sourceSequence;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0;
}

function validatePacket(packet: DeviceLinkSessionPacket): void {
  if (packet.schemaVersion !== 1
    || !packet.originDeviceId.trim()
    || !packet.originSessionId.trim()
    || !Number.isSafeInteger(packet.originRevision)
    || packet.originRevision < 0
    || !Array.isArray(packet.items)
    || packet.items.length > MAX_REPLICA_ITEMS) {
    throw new Error('Device Link session packet is invalid or exceeds limits.');
  }
  let previous = packet.snapshot?.throughSequence ?? 0;
  for (const item of packet.items) {
    if (!Number.isSafeInteger(item.sequence) || item.sequence <= previous) {
      throw new Error('Device Link session items must be strictly ordered.');
    }
    previous = item.sequence;
  }
}

function assertSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('afterSequence is invalid.');
}
