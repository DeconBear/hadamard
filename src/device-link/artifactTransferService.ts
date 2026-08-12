import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { assertSafeStorageSegment } from '../storage/pathSafety.js';

export interface DeviceLinkArtifactManifest {
  schemaVersion: 1;
  transferId: string;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  chunkSize: number;
  totalChunks: number;
  createdAt: string;
}

export type DeviceLinkArtifactStatus = 'receiving' | 'verified' | 'quarantined' | 'committed';

export interface DeviceLinkArtifactTransferState {
  deviceId: string;
  manifest: DeviceLinkArtifactManifest;
  status: DeviceLinkArtifactStatus;
  receivedChunks: number[];
  updatedAt: string;
  reason?: string;
  committedPath?: string;
}

export interface DeviceLinkArtifactTransferOptions {
  rootDirectory: string;
  workspaceRoot?: string;
  maxTransferBytes?: number;
  maxDeviceQuotaBytes?: number;
  maxChunkBytes?: number;
}

const DEFAULT_MAX_TRANSFER_BYTES = 256 * 1024 * 1024;
const DEFAULT_DEVICE_QUOTA_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_CHUNK_BYTES = 256 * 1024;

export class DeviceLinkArtifactTransferService {
  private readonly maxTransferBytes: number;
  private readonly maxDeviceQuotaBytes: number;
  private readonly maxChunkBytes: number;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly options: DeviceLinkArtifactTransferOptions) {
    this.maxTransferBytes = options.maxTransferBytes ?? DEFAULT_MAX_TRANSFER_BYTES;
    this.maxDeviceQuotaBytes = options.maxDeviceQuotaBytes ?? DEFAULT_DEVICE_QUOTA_BYTES;
    this.maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  }

  async begin(
    deviceId: string,
    manifestInput: DeviceLinkArtifactManifest,
  ): Promise<DeviceLinkArtifactTransferState> {
    const manifest = this.validateManifest(manifestInput);
    const key = `device:${assertSafeStorageSegment('deviceId', deviceId)}`;
    return this.withLock(key, async () => {
      const existing = await this.readState(deviceId, manifest.transferId).catch(() => undefined);
      if (existing) {
        if (canonicalManifest(existing.manifest) !== canonicalManifest(manifest)) {
          throw new Error('Transfer ID already exists with a different manifest.');
        }
        return existing;
      }
      const used = await this.deviceUsage(deviceId);
      if (used + manifest.size > this.maxDeviceQuotaBytes) {
        throw new Error('Device Link inbox quota exceeded.');
      }
      const directory = this.transferDirectory('inbox', deviceId, manifest.transferId);
      await mkdir(path.join(directory, 'chunks'), { recursive: true });
      const state: DeviceLinkArtifactTransferState = {
        deviceId,
        manifest,
        status: 'receiving',
        receivedChunks: [],
        updatedAt: new Date().toISOString(),
      };
      await this.writeState(directory, state);
      return structuredClone(state);
    });
  }

  async receiveChunk(
    deviceId: string,
    transferId: string,
    index: number,
    content: Uint8Array,
    expectedSha256: string,
  ): Promise<DeviceLinkArtifactTransferState> {
    const key = this.key(deviceId, transferId);
    return this.withLock(key, async () => {
      const state = await this.readState(deviceId, transferId);
      if (state.status !== 'receiving') throw new Error(`Transfer is ${state.status}.`);
      assertChunkIndex(state.manifest, index);
      const expectedBytes = chunkLength(state.manifest, index);
      if (content.byteLength !== expectedBytes || content.byteLength > this.maxChunkBytes) {
        throw new Error(`Chunk ${index} has an invalid size.`);
      }
      const digest = sha256(content);
      if (digest !== normalizeSha256(expectedSha256)) throw new Error(`Chunk ${index} SHA-256 mismatch.`);
      const chunkPath = this.chunkPath('inbox', deviceId, transferId, index);
      const existing = await readFile(chunkPath).catch(() => undefined);
      if (existing) {
        if (sha256(existing) !== digest) throw new Error(`Chunk ${index} conflicts with the stored chunk.`);
      } else {
        await atomicWrite(chunkPath, content);
      }
      if (!state.receivedChunks.includes(index)) {
        state.receivedChunks.push(index);
        state.receivedChunks.sort((left, right) => left - right);
        state.updatedAt = new Date().toISOString();
        await this.writeState(this.transferDirectory('inbox', deviceId, transferId), state);
      }
      return structuredClone(state);
    });
  }

  async status(deviceId: string, transferId: string): Promise<DeviceLinkArtifactTransferState> {
    return structuredClone(await this.readState(deviceId, transferId));
  }

  async missingChunks(deviceId: string, transferId: string): Promise<number[]> {
    const state = await this.readState(deviceId, transferId);
    const received = new Set(state.receivedChunks);
    return Array.from({ length: state.manifest.totalChunks }, (_, index) => index)
      .filter(index => !received.has(index));
  }

  async finalize(deviceId: string, transferId: string): Promise<DeviceLinkArtifactTransferState> {
    const key = this.key(deviceId, transferId);
    return this.withLock(key, async () => {
      const state = await this.readState(deviceId, transferId);
      if (state.status === 'verified' || state.status === 'committed') return structuredClone(state);
      if (state.status !== 'receiving') throw new Error(`Transfer is ${state.status}.`);
      const missing = await this.missingChunks(deviceId, transferId);
      if (missing.length > 0) throw new Error(`Transfer is missing chunks: ${missing.join(', ')}.`);
      const directory = this.transferDirectory('inbox', deviceId, transferId);
      const assembled = path.join(directory, 'artifact.bin');
      const temporary = `${assembled}.${randomUUID()}.tmp`;
      const digest = createHash('sha256');
      const output = await open(temporary, 'wx');
      try {
        for (let index = 0; index < state.manifest.totalChunks; index += 1) {
          const chunk = await readFile(this.chunkPath('inbox', deviceId, transferId, index));
          digest.update(chunk);
          await output.write(chunk);
        }
      } finally {
        await output.close();
      }
      const actual = digest.digest('hex');
      if (actual !== state.manifest.sha256) {
        await rm(temporary, { force: true });
        state.status = 'quarantined';
        state.reason = 'Assembled artifact SHA-256 mismatch.';
        state.updatedAt = new Date().toISOString();
        await this.writeState(directory, state);
        const quarantine = this.transferDirectory('quarantine', deviceId, transferId);
        await mkdir(path.dirname(quarantine), { recursive: true });
        await rename(directory, quarantine);
        throw new Error(state.reason);
      }
      await rename(temporary, assembled);
      state.status = 'verified';
      state.updatedAt = new Date().toISOString();
      await this.writeState(directory, state);
      return structuredClone(state);
    });
  }

  async listInbox(deviceId: string): Promise<DeviceLinkArtifactTransferState[]> {
    const states = await this.listStates('inbox', deviceId);
    return states.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async commit(
    deviceId: string,
    transferId: string,
    targetRelativePath: string,
    confirm: boolean,
  ): Promise<DeviceLinkArtifactTransferState> {
    if (!confirm) throw new Error('Inbox commit requires confirm:true.');
    const workspaceRoot = this.options.workspaceRoot;
    if (!workspaceRoot) throw new Error('No Device Link workspace commit root is configured.');
    const key = this.key(deviceId, transferId);
    return this.withLock(key, async () => {
      const state = await this.readState(deviceId, transferId);
      if (state.status !== 'verified') throw new Error('Only verified inbox artifacts can be committed.');
      const root = path.resolve(workspaceRoot);
      const target = path.resolve(root, targetRelativePath);
      const relative = path.relative(root, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Inbox commit target escapes the configured workspace.');
      }
      await mkdir(path.dirname(target), { recursive: true });
      await stat(target).then(
        () => { throw new Error('Inbox commit will not overwrite an existing file.'); },
        () => undefined,
      );
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await copyFile(this.artifactPath('inbox', deviceId, transferId), temporary);
        const copied = await readFile(temporary);
        if (sha256(copied) !== state.manifest.sha256) throw new Error('Committed copy failed integrity verification.');
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      state.status = 'committed';
      state.committedPath = target;
      state.updatedAt = new Date().toISOString();
      await this.writeState(this.transferDirectory('inbox', deviceId, transferId), state);
      return structuredClone(state);
    });
  }

  async readVerifiedChunk(deviceId: string, transferId: string, index: number): Promise<Buffer> {
    const state = await this.readState(deviceId, transferId);
    if (state.status !== 'verified' && state.status !== 'committed') {
      throw new Error('Artifact is not verified.');
    }
    assertChunkIndex(state.manifest, index);
    return this.readChunkFromArtifact('inbox', state, index);
  }

  async stageOutgoing(
    deviceId: string,
    sourceRelativePath: string,
    options: { name?: string; mediaType?: string; chunkSize?: number } = {},
  ): Promise<DeviceLinkArtifactTransferState> {
    const workspaceRoot = this.options.workspaceRoot;
    if (!workspaceRoot) throw new Error('No Device Link workspace root is configured.');
    const outboxLock = `outbox:${assertSafeStorageSegment('deviceId', deviceId)}`;
    return this.withLock(outboxLock, async () => {
    const root = path.resolve(workspaceRoot);
    const source = path.resolve(root, sourceRelativePath);
    const relative = path.relative(root, source);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Outgoing artifact source escapes the configured workspace.');
    }
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) throw new Error('Outgoing artifact source must be a file.');
    if (sourceStat.size > this.maxTransferBytes) throw new Error('Artifact size exceeds the Device Link transfer limit.');
    const outboxUsage = (await this.listOutbox(deviceId))
      .reduce((total, state) => total + state.manifest.size, 0);
    if (outboxUsage + sourceStat.size > this.maxDeviceQuotaBytes) {
      throw new Error('Device Link outbox quota exceeded.');
    }
    const chunkSize = options.chunkSize ?? this.maxChunkBytes;
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > this.maxChunkBytes) {
      throw new Error('Invalid artifact chunk size.');
    }
    const transferId = randomUUID();
    const name = options.name?.trim() || path.basename(source);
    assertSafeStorageSegment('artifactName', name);
    const directory = this.transferDirectory('outbox', deviceId, transferId);
    await mkdir(directory, { recursive: true });
    const target = this.artifactPath('outbox', deviceId, transferId);
    try {
      await copyFile(source, target);
      const manifest: DeviceLinkArtifactManifest = {
        schemaVersion: 1,
        transferId,
        name,
        mediaType: options.mediaType?.trim() || 'application/octet-stream',
        size: sourceStat.size,
        sha256: await hashFile(target),
        chunkSize,
        totalChunks: sourceStat.size === 0 ? 0 : Math.ceil(sourceStat.size / chunkSize),
        createdAt: new Date().toISOString(),
      };
      const state: DeviceLinkArtifactTransferState = {
        deviceId,
        manifest,
        status: 'verified',
        receivedChunks: Array.from({ length: manifest.totalChunks }, (_, index) => index),
        updatedAt: new Date().toISOString(),
      };
      await this.writeState(directory, state);
      return structuredClone(state);
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    });
  }

  async listOutbox(deviceId: string): Promise<DeviceLinkArtifactTransferState[]> {
    const states = await this.listStates('outbox', deviceId);
    return states.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async readOutgoingChunk(deviceId: string, transferId: string, index: number): Promise<Buffer> {
    const state = await this.readOutboxState(deviceId, transferId);
    assertChunkIndex(state.manifest, index);
    return this.readChunkFromArtifact('outbox', state, index);
  }

  async acknowledgeOutgoing(deviceId: string, transferId: string, confirm: boolean): Promise<void> {
    if (!confirm) throw new Error('Outbox acknowledgement requires confirm:true.');
    const statePath = path.join(this.transferDirectory('outbox', deviceId, transferId), 'state.json');
    const text = await readFile(statePath, 'utf8').catch(() => undefined);
    // Idempotent: a retry after a successful ack (or crash between ack and local finalize) is a no-op.
    if (!text) return;
    await rm(this.transferDirectory('outbox', deviceId, transferId), { recursive: true, force: true });
  }

  private validateManifest(input: DeviceLinkArtifactManifest): DeviceLinkArtifactManifest {
    if (!input || input.schemaVersion !== 1) throw new Error('Artifact manifest schemaVersion must be 1.');
    assertSafeStorageSegment('transferId', input.transferId);
    assertSafeStorageSegment('artifactName', input.name);
    if (!input.mediaType.trim() || input.mediaType.length > 160) throw new Error('Invalid artifact media type.');
    if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > this.maxTransferBytes) {
      throw new Error('Artifact size exceeds the Device Link transfer limit.');
    }
    if (!Number.isSafeInteger(input.chunkSize) || input.chunkSize <= 0 || input.chunkSize > this.maxChunkBytes) {
      throw new Error('Invalid artifact chunk size.');
    }
    const totalChunks = input.size === 0 ? 0 : Math.ceil(input.size / input.chunkSize);
    if (input.totalChunks !== totalChunks) throw new Error('Artifact totalChunks does not match size and chunkSize.');
    const createdAt = new Date(input.createdAt);
    if (!Number.isFinite(createdAt.getTime())) throw new Error('Artifact createdAt must be an ISO timestamp.');
    return {
      ...input,
      name: input.name.trim(),
      mediaType: input.mediaType.trim(),
      sha256: normalizeSha256(input.sha256),
      createdAt: createdAt.toISOString(),
    };
  }

  private async readState(deviceId: string, transferId: string): Promise<DeviceLinkArtifactTransferState> {
    const safeDeviceId = assertSafeStorageSegment('deviceId', deviceId);
    const safeTransferId = assertSafeStorageSegment('transferId', transferId);
    for (const area of ['inbox', 'quarantine'] as const) {
      const statePath = path.join(this.transferDirectory(area, safeDeviceId, safeTransferId), 'state.json');
      const text = await readFile(statePath, 'utf8').catch(() => undefined);
      if (text) return JSON.parse(text) as DeviceLinkArtifactTransferState;
    }
    throw new Error('Artifact transfer was not found.');
  }

  private async listStates(
    area: 'inbox' | 'outbox' | 'quarantine',
    deviceId: string,
  ): Promise<DeviceLinkArtifactTransferState[]> {
    const directory = path.join(this.options.rootDirectory, area, assertSafeStorageSegment('deviceId', deviceId));
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    return Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
      const text = await readFile(path.join(directory, entry.name, 'state.json'), 'utf8');
      return JSON.parse(text) as DeviceLinkArtifactTransferState;
    }));
  }

  private async readOutboxState(
    deviceId: string,
    transferId: string,
  ): Promise<DeviceLinkArtifactTransferState> {
    const statePath = path.join(this.transferDirectory('outbox', deviceId, transferId), 'state.json');
    const text = await readFile(statePath, 'utf8').catch(() => undefined);
    if (!text) throw new Error('Outgoing artifact transfer was not found.');
    return JSON.parse(text) as DeviceLinkArtifactTransferState;
  }

  private async deviceUsage(deviceId: string): Promise<number> {
    const states = await this.listStates('inbox', deviceId);
    return states
      .filter(state => state.status !== 'committed')
      .reduce((total, state) => total + state.manifest.size, 0);
  }

  private transferDirectory(
    area: 'inbox' | 'outbox' | 'quarantine',
    deviceId: string,
    transferId: string,
  ): string {
    return path.join(
      this.options.rootDirectory,
      area,
      assertSafeStorageSegment('deviceId', deviceId),
      assertSafeStorageSegment('transferId', transferId),
    );
  }

  private chunkPath(
    area: 'inbox' | 'quarantine',
    deviceId: string,
    transferId: string,
    index: number,
  ): string {
    return path.join(this.transferDirectory(area, deviceId, transferId), 'chunks', `${index}.bin`);
  }

  private artifactPath(area: 'inbox' | 'outbox', deviceId: string, transferId: string): string {
    return path.join(this.transferDirectory(area, deviceId, transferId), 'artifact.bin');
  }

  private async readChunkFromArtifact(
    area: 'inbox' | 'outbox',
    state: DeviceLinkArtifactTransferState,
    index: number,
  ): Promise<Buffer> {
    const artifact = await open(this.artifactPath(area, state.deviceId, state.manifest.transferId), 'r');
    try {
      const length = chunkLength(state.manifest, index);
      const content = Buffer.alloc(length);
      const result = await artifact.read(content, 0, length, index * state.manifest.chunkSize);
      if (result.bytesRead !== length) throw new Error('Verified artifact ended before the requested chunk.');
      return content;
    } finally {
      await artifact.close();
    }
  }

  private async writeState(directory: string, state: DeviceLinkArtifactTransferState): Promise<void> {
    await atomicWrite(path.join(directory, 'state.json'), Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
  }

  private key(deviceId: string, transferId: string): string {
    return `${assertSafeStorageSegment('deviceId', deviceId)}:${assertSafeStorageSegment('transferId', transferId)}`;
  }

  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}

function canonicalManifest(manifest: DeviceLinkArtifactManifest): string {
  return JSON.stringify(manifest);
}

function normalizeSha256(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error('SHA-256 must be 64 hexadecimal characters.');
  return normalized;
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function assertChunkIndex(manifest: DeviceLinkArtifactManifest, index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.totalChunks) {
    throw new Error('Artifact chunk index is out of range.');
  }
}

function chunkLength(manifest: DeviceLinkArtifactManifest, index: number): number {
  const offset = index * manifest.chunkSize;
  return Math.min(manifest.chunkSize, manifest.size - offset);
}

async function atomicWrite(target: string, content: Uint8Array): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function hashFile(target: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(target)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}
