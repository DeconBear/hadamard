import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, canonicalJson, isCode, safePath, safeRead, sha256 } from './safeFiles.js';
import { ResearchError, type ResearchManifest, type ResearchRun } from './types.js';

const ID = /^[a-z0-9-]{1,80}$/;
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1_000);
export const researchProcessStartedAt = PROCESS_STARTED_AT;
const activeStores = new Set<string>();

/** One writer per workspace. Atomic files preserve the previous complete JSON on write failure. */
export class ResearchStore {
  root = '';
  workspaceRoot = '';
  private token = randomUUID();
  private initialized = false;
  constructor(private readonly workspace: string) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.workspaceRoot = await realpath(this.workspace);
    const root = await safePath(this.workspaceRoot, '.hadamard/research/v1/placeholder', true);
    this.root = path.dirname(root);
    if (activeStores.has(this.root)) throw new ResearchError('Research workspace already has an active service.', 'conflict');
    activeStores.add(this.root);
    let ownsLock = false;
    try {
      try {
        await atomicWrite(this.root, 'owner.json', canonicalJson(this.owner()), true);
      } catch (error) {
        if (!isCode(error, 'EEXIST')) throw error;
        const owner = JSON.parse((await safeRead(this.root, 'owner.json', 4096)).toString()) as { pid: number };
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || processAlive(owner.pid)) {
          throw new ResearchError('Research workspace is owned by another live process.', 'conflict');
        }
        await unlink(await safePath(this.root, 'owner.json'));
        await atomicWrite(this.root, 'owner.json', canonicalJson(this.owner()), true);
      }
      ownsLock = true;
      for (const name of ['manifests', 'runs', 'blobs', 'work', 'probes']) {
        const directory = await safePath(this.root, `${name}/placeholder`, true);
        await lstat(path.dirname(directory));
      }
      this.initialized = true;
    } catch (error) {
      if (ownsLock) {
        await this.releaseLock().catch(() => undefined);
      }
      activeStores.delete(this.root);
      throw error;
    }
  }

  private owner() { return { pid: process.pid, startedAt: PROCESS_STARTED_AT, token: this.token }; }
  async close(): Promise<void> {
    if (!this.initialized) return;
    try { await this.releaseLock(); } finally {
      activeStores.delete(this.root);
      this.initialized = false;
    }
  }
  private async releaseLock(): Promise<void> {
    const owner = JSON.parse((await safeRead(this.root, 'owner.json', 4096)).toString()) as { token: string };
    if (owner.token === this.token) await unlink(await safePath(this.root, 'owner.json'));
  }
  async putBlob(bytes: Buffer): Promise<string> {
    const digest = sha256(bytes);
    try { await atomicWrite(this.root, `blobs/${digest}`, bytes, true); }
    catch (error) { if (!isCode(error, 'EEXIST')) throw error; }
    if (sha256(await safeRead(this.root, `blobs/${digest}`, 20_000_000)) !== digest) throw new ResearchError('Snapshot digest mismatch.', 'integrity');
    return digest;
  }
  async readBlob(digest: string, limit = 20_000_000): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new ResearchError('Invalid snapshot digest.', 'integrity');
    const bytes = await safeRead(this.root, `blobs/${digest}`, limit);
    if (sha256(bytes) !== digest) throw new ResearchError('Snapshot was modified.', 'integrity');
    return bytes;
  }
  async saveManifest(manifest: ResearchManifest): Promise<void> {
    verifyManifest(manifest);
    await atomicWrite(this.root, `manifests/${validId(manifest.id)}.json`, canonicalJson(manifest), true);
  }
  async getManifest(id: string): Promise<ResearchManifest | null> {
    const result = await this.read<ResearchManifest>('manifests', id);
    if (result) verifyManifest(result);
    return result;
  }
  async listManifests(): Promise<ResearchManifest[]> {
    return this.list('manifests', id => this.getManifest(id));
  }
  async saveRun(run: ResearchRun, exclusive = false): Promise<void> {
    await atomicWrite(this.root, `runs/${validId(run.id)}.json`, canonicalJson(run), exclusive);
  }
  async getRun(id: string): Promise<ResearchRun | null> { return this.read('runs', id); }
  async listRuns(): Promise<ResearchRun[]> { return this.list('runs', id => this.getRun(id)); }
  async directory(relative: string): Promise<string> {
    return path.dirname(await safePath(this.root, `${relative}/placeholder`, true));
  }
  private async read<T>(directory: string, id: string): Promise<T | null> {
    try { return JSON.parse((await safeRead(this.root, `${directory}/${validId(id)}.json`, 10_000_000)).toString()) as T; }
    catch (error) { if (isCode(error, 'ENOENT')) return null; throw error; }
  }
  private async list<T>(directory: string, read: (id: string) => Promise<T | null>): Promise<T[]> {
    const names = await readdir(await this.directory(directory));
    const items = await Promise.all(names.filter(name => name.endsWith('.json')).sort().map(name => read(name.slice(0, -5))));
    return items.filter(item => item !== null) as T[];
  }
}
export function validId(id: string): string {
  if (typeof id !== 'string' || !ID.test(id)) throw new ResearchError('Invalid research identifier.', 'not_found');
  return id;
}
export function manifestDigest(manifest: Omit<ResearchManifest, 'digest'>): string { return sha256(canonicalJson(manifest)); }
export function verifyManifest(manifest: ResearchManifest): void {
  const { digest, ...body } = manifest;
  if (manifest.version !== 1 || digest !== manifestDigest(body) || sha256(manifest.code) !== manifest.codeDigest) {
    throw new ResearchError('Immutable manifest integrity check failed.', 'integrity');
  }
  const { sha256: environmentDigest, ...environment } = manifest.environment;
  if (sha256(canonicalJson(environment)) !== environmentDigest) throw new ResearchError('Environment integrity check failed.', 'integrity');
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !isCode(error, 'ESRCH'); }
}
