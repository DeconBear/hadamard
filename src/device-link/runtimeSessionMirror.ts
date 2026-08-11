import type { HadamardAgentClient } from '../runtime/agentClient.js';
import type { SessionStoreV2 } from '../storage-v2/contracts.js';
import type { JsonValue, SessionRecord } from '../storage-v2/types.js';
import { canonicalJson, sha256 } from './crypto.js';

export class RuntimeSessionV2Mirror {
  constructor(
    private readonly sdk: HadamardAgentClient,
    private readonly store: SessionStoreV2,
    private readonly tenantId: string,
  ) {}

  async sync(sessionId: string): Promise<SessionRecord> {
    const runtimeSession = await this.sdk.resumeSession(sessionId);
    const snapshot = runtimeSession.snapshot();
    const jsonSnapshot = JSON.parse(canonicalJson(snapshot)) as JsonValue;
    let target = await this.store.get({ tenantId: this.tenantId, sessionId });
    if (!target) {
      target = await this.store.create({
        tenantId: this.tenantId,
        sessionId,
        metadata: {
          schemaVersion: 1,
          kind: 'hadamard-runtime-session',
          title: snapshot.title,
          model: snapshot.model,
        },
        createdAt: snapshot.createdAt,
      });
    }
    const latest = await this.store.load({
      tenantId: this.tenantId,
      sessionId,
      useSnapshot: true,
      limit: 1,
    });
    const mirroredRevision = readMirroredRevision(latest.snapshot?.state);
    if (snapshot.revision <= mirroredRevision) return target;
    target = await this.store.append({
      tenantId: this.tenantId,
      sessionId,
      expectedRevision: target.revision,
      items: [{
        itemId: `runtime-revision-${snapshot.revision}-${sha256(canonicalJson(snapshot)).slice(0, 16)}`,
        kind: 'hadamard.runtime-session-revision',
        payload: {
          runtimeRevision: snapshot.revision,
          snapshot: jsonSnapshot,
        },
        createdAt: snapshot.updatedAt,
      }],
      updatedAt: snapshot.updatedAt,
    });
    await this.store.compact({
      tenantId: this.tenantId,
      sessionId,
      expectedRevision: target.revision,
      throughSequence: target.lastSequence,
      state: {
        schemaVersion: 1,
        kind: 'hadamard-runtime-session-snapshot',
        runtimeRevision: snapshot.revision,
        session: jsonSnapshot,
      },
      createdAt: snapshot.updatedAt,
    });
    return (await this.store.get({ tenantId: this.tenantId, sessionId }))!;
  }
}

function readMirroredRevision(value: JsonValue | undefined): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return -1;
  const revision = value.runtimeRevision;
  return typeof revision === 'number' && Number.isSafeInteger(revision) ? revision : -1;
}
