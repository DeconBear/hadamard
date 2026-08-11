import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DeviceLinkArtifactTransferService,
  type DeviceLinkArtifactManifest,
} from '../src/device-link/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Device Link artifact transfer', () => {
  it('serializes concurrent outbox quota reservations per device', async () => {
    const root = await tempRoot();
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'left.bin'), Buffer.alloc(8, 1));
    await writeFile(path.join(workspace, 'right.bin'), Buffer.alloc(8, 2));
    const service = new DeviceLinkArtifactTransferService({
      rootDirectory: path.join(root, 'transfers'),
      workspaceRoot: workspace,
      maxDeviceQuotaBytes: 12,
    });

    const outcomes = await Promise.allSettled([
      service.stageOutgoing('phone', 'left.bin'),
      service.stageOutgoing('phone', 'right.bin'),
    ]);

    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await service.listOutbox('phone')).toHaveLength(1);
  });

  it('accepts out-of-order and duplicate chunks, resumes, verifies, and commits explicitly', async () => {
    const root = await tempRoot();
    const workspace = path.join(root, 'workspace');
    const service = new DeviceLinkArtifactTransferService({
      rootDirectory: path.join(root, 'transfers'),
      workspaceRoot: workspace,
      maxChunkBytes: 4,
    });
    const content = Buffer.from('abcdefghij');
    const manifest = createManifest('transfer-1', content, 4);
    await service.begin('phone-1', manifest);

    await service.receiveChunk('phone-1', manifest.transferId, 2, content.subarray(8), digest(content.subarray(8)));
    await service.receiveChunk('phone-1', manifest.transferId, 0, content.subarray(0, 4), digest(content.subarray(0, 4)));
    await service.receiveChunk('phone-1', manifest.transferId, 0, content.subarray(0, 4), digest(content.subarray(0, 4)));
    expect(await service.missingChunks('phone-1', manifest.transferId)).toEqual([1]);
    await expect(service.finalize('phone-1', manifest.transferId)).rejects.toThrow('missing chunks');

    await service.receiveChunk('phone-1', manifest.transferId, 1, content.subarray(4, 8), digest(content.subarray(4, 8)));
    await expect(service.finalize('phone-1', manifest.transferId)).resolves.toMatchObject({ status: 'verified' });
    await expect(service.commit('phone-1', manifest.transferId, 'inbox/result.txt', false))
      .rejects.toThrow('confirm:true');
    await expect(service.commit('phone-1', manifest.transferId, '../escape.txt', true))
      .rejects.toThrow('escapes');
    const committed = await service.commit('phone-1', manifest.transferId, 'inbox/result.txt', true);
    expect(committed).toMatchObject({ status: 'committed' });
    expect(await readFile(path.join(workspace, 'inbox', 'result.txt'))).toEqual(content);
  });

  it('rejects conflicting duplicates and quarantines an assembled hash mismatch', async () => {
    const root = await tempRoot();
    const transferRoot = path.join(root, 'transfers');
    const service = new DeviceLinkArtifactTransferService({ rootDirectory: transferRoot, maxChunkBytes: 8 });
    const content = Buffer.from('abcdefgh');
    const manifest = createManifest('transfer-2', content, 4);
    await service.begin('phone-2', manifest);
    const first = content.subarray(0, 4);
    await service.receiveChunk('phone-2', manifest.transferId, 0, first, digest(first));
    const conflicting = Buffer.from('WXYZ');
    await expect(service.receiveChunk('phone-2', manifest.transferId, 0, conflicting, digest(conflicting)))
      .rejects.toThrow('conflicts');
    const second = content.subarray(4);
    await service.receiveChunk('phone-2', manifest.transferId, 1, second, digest(second));
    await writeFile(path.join(transferRoot, 'inbox', 'phone-2', manifest.transferId, 'chunks', '1.bin'), 'tampered');

    await expect(service.finalize('phone-2', manifest.transferId)).rejects.toThrow('SHA-256 mismatch');
    await expect(service.status('phone-2', manifest.transferId)).resolves.toMatchObject({
      status: 'quarantined',
      reason: expect.stringContaining('SHA-256 mismatch'),
    });
  });

  it('enforces per-device quota and manifest invariants', async () => {
    const root = await tempRoot();
    const service = new DeviceLinkArtifactTransferService({
      rootDirectory: path.join(root, 'transfers'),
      maxTransferBytes: 8,
      maxDeviceQuotaBytes: 8,
      maxChunkBytes: 4,
    });
    const first = createManifest('one', Buffer.alloc(6), 4);
    const second = createManifest('two', Buffer.alloc(3), 4);
    await service.begin('phone-3', first);
    await expect(service.begin('phone-3', second)).rejects.toThrow('quota');
    await expect(service.begin('phone-4', { ...second, totalChunks: 2 })).rejects.toThrow('totalChunks');
    await expect(service.begin('phone-4', { ...second, name: '../escape' })).rejects.toThrow('Unsafe artifactName');
  });

  it('stages workspace files in a resumable per-device outbox and requires an acknowledgement', async () => {
    const root = await tempRoot();
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'report.txt'), 'outgoing', { flag: 'wx' });
    const service = new DeviceLinkArtifactTransferService({
      rootDirectory: path.join(root, 'transfers'),
      workspaceRoot: workspace,
      maxChunkBytes: 4,
    });

    const staged = await service.stageOutgoing('phone-5', 'report.txt', { chunkSize: 4 });
    expect(await service.listOutbox('phone-5')).toHaveLength(1);
    expect(await service.readOutgoingChunk('phone-5', staged.manifest.transferId, 1))
      .toEqual(Buffer.from('oing'));
    await expect(service.acknowledgeOutgoing('phone-5', staged.manifest.transferId, false))
      .rejects.toThrow('confirm:true');
    await service.acknowledgeOutgoing('phone-5', staged.manifest.transferId, true);
    expect(await service.listOutbox('phone-5')).toEqual([]);
    await expect(service.stageOutgoing('phone-5', '../outside.txt')).rejects.toThrow('escapes');
  });
});

function createManifest(
  transferId: string,
  content: Uint8Array,
  chunkSize: number,
): DeviceLinkArtifactManifest {
  return {
    schemaVersion: 1,
    transferId,
    name: `${transferId}.bin`,
    mediaType: 'application/octet-stream',
    size: content.byteLength,
    sha256: digest(content),
    chunkSize,
    totalChunks: content.byteLength === 0 ? 0 : Math.ceil(content.byteLength / chunkSize),
    createdAt: '2026-08-12T00:00:00.000Z',
  };
}

function digest(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-device-link-artifact-'));
  roots.push(root);
  return root;
}
