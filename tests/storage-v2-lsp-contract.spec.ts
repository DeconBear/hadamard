import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SqliteStorageV2,
  type DurableStorageV2,
} from '../src/storage-v2/index.js';

interface DurableStorageContractHarness {
  name: string;
  open(): Promise<DurableStorageV2>;
}

const roots: string[] = [];
const stores: DurableStorageV2[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function durableStorageContract(harness: DurableStorageContractHarness): void {
  describe(`Durable storage LSP contract: ${harness.name}`, () => {
    it('exposes substitutable session, checkpoint, memory, and artifact stores', async () => {
      const storage = await harness.open();
      stores.push(storage);

      await storage.sessions.create({ tenantId: 'tenant', sessionId: 'session' });
      await storage.sessions.append({
        tenantId: 'tenant',
        sessionId: 'session',
        expectedRevision: 0,
        items: [{ itemId: 'message-1', kind: 'message', payload: { text: 'hello' } }],
      });
      await expect(storage.sessions.load({ tenantId: 'tenant', sessionId: 'session' }))
        .resolves.toMatchObject({ items: [{ itemId: 'message-1', payload: { text: 'hello' } }] });

      await storage.checkpoints.save({
        tenantId: 'tenant',
        checkpointId: 'checkpoint',
        runId: 'run',
        sessionId: 'session',
        expectedRevision: null,
        status: 'running',
        state: { turn: 1 },
        traceContext: { traceId: 'trace', spanId: 'span' },
      });
      await expect(storage.checkpoints.load({ tenantId: 'tenant', checkpointId: 'checkpoint' }))
        .resolves.toMatchObject({ runId: 'run', state: { turn: 1 } });

      await storage.memory.put({
        tenantId: 'tenant',
        memoryId: 'memory',
        namespace: 'project',
        expectedRevision: null,
        value: { summary: 'remember' },
      });
      await expect(storage.memory.get({ tenantId: 'tenant', memoryId: 'memory' }))
        .resolves.toMatchObject({ namespace: 'project', value: { summary: 'remember' } });

      await storage.artifacts.put({
        tenantId: 'tenant',
        artifactId: 'artifact',
        expectedRevision: null,
        mediaType: 'text/plain',
        data: new TextEncoder().encode('artifact body'),
      });
      const artifact = await storage.artifacts.get({ tenantId: 'tenant', artifactId: 'artifact' });
      expect(artifact).toMatchObject({ mediaType: 'text/plain' });
      expect(new TextDecoder().decode(artifact?.data)).toBe('artifact body');
    });
  });
}

durableStorageContract({
  name: 'sqlite',
  async open() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'storage-lsp-contract-'));
    roots.push(root);
    return SqliteStorageV2.open({ filename: path.join(root, 'storage.sqlite') });
  },
});
