import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink, link } from 'node:fs/promises';
import path from 'node:path';
import { ResearchError } from './types.js';
import { isRetriableFsError } from '../storage/atomicJsonWrite.js';

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function safeRelative(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\x00-\x1f:]/.test(value)
      || path.posix.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new ResearchError(`Unsafe relative path: ${String(value)}`, 'unsafe_path');
  }
  return value;
}
export async function safePath(root: string, relative: string, createParents = false): Promise<string> {
  safeRelative(relative);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new ResearchError('Research root is not a real directory.', 'unsafe_path');
  const segments = relative.split('/');
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]!);
    const last = i === segments.length - 1;
    if (!last && createParents) {
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (!isCode(error, 'EEXIST')) throw error; }
    }
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (!last && !stat.isDirectory())) throw new ResearchError(`Symlink or non-directory path component: ${relative}`, 'unsafe_path');
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
      if (!last) throw error;
    }
  }
  const parent = await realpath(path.dirname(current));
  if (parent !== root && !parent.startsWith(root + path.sep)) throw new ResearchError('Path escaped research root.', 'unsafe_path');
  return current;
}
// File publication and intake share a path-scoped barrier. In particular, an
// exclusive link(temp, target) is not ready for readers until temp is unlinked.
// The settled tail releases on failure, and unrelated files remain concurrent.
const fileOperations = new Map<string, Promise<void>>();
function withFileOperation<T>(root: string, relative: string, action: () => Promise<T>): Promise<T> {
  const absolute = path.resolve(root, safeRelative(relative));
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  const result = (fileOperations.get(key) ?? Promise.resolve()).then(action);
  const settled = result.then(() => undefined, () => undefined);
  fileOperations.set(key, settled);
  void settled.then(() => { if (fileOperations.get(key) === settled) fileOperations.delete(key); });
  return result;
}
export async function safeRead(root: string, relative: string, limit: number): Promise<Buffer> {
  return withFileOperation(root, relative, () => readFileSnapshot(root, relative, limit));
}
async function readFileSnapshot(root: string, relative: string, limit: number): Promise<Buffer> {
  const target = await safePath(root, relative);
  const beforeOpen = await lstat(target);
  if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink() || beforeOpen.nlink !== 1) throw new ResearchError(`Only regular, non-linked files are accepted: ${relative}`, 'unsafe_path');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    // Atomic replacement may unlink the already-open old inode (nlink=0).
    // Its descriptor is still a safe immutable snapshot; multiple links are not.
    if (!stat.isFile() || stat.nlink > 1) throw new ResearchError(`Only regular, non-linked files are accepted: ${relative}`, 'unsafe_path');
    if (stat.size > limit) throw new ResearchError(`File exceeds ${limit} byte budget: ${relative}`, 'invalid_manifest');
    // A bounded read, including files which grow after fstat. Never read an unbounded stream.
    const output = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let read = 0;
    while (read < output.length) {
      const result = await handle.read(output, read, output.length - read, read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    if (read > limit || read !== stat.size) throw new ResearchError(`File changed while reading: ${relative}`, 'integrity');
    return output.subarray(0, read);
  } finally { await handle.close(); }
}
export async function atomicWrite(root: string, relative: string, bytes: Buffer | string, exclusive = false): Promise<void> {
  return withFileOperation(root, relative, () => publishFile(root, relative, bytes, exclusive));
}
async function publishFile(root: string, relative: string, bytes: Buffer | string, exclusive: boolean): Promise<void> {
  const target = await safePath(root, relative, true);
  const tempRelative = `${path.posix.dirname(relative)}/.${randomUUID()}.tmp`.replace(/^\.\//, '');
  const temp = await safePath(root, tempRelative);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    // Recheck directory ancestry immediately before publishing the record.
    await safePath(root, relative);
    if (exclusive) { await link(temp, target); await unlink(temp); }
    else {
      // Windows readers and antivirus scanners can briefly deny replacement.
      // Keep the same complete temp file and recheck containment on every retry.
      for (let attempt = 0; ; attempt += 1) {
        await safePath(root, relative);
        try { await rename(temp, target); break; }
        catch (error) {
          if (attempt >= 7 || !isRetriableFsError(error)) throw error;
          await new Promise(resolve => setTimeout(resolve, 5 * (attempt + 1)));
        }
      }
    }
  } finally { await unlink(temp).catch(() => undefined); }
}
export function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}
