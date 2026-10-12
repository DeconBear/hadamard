import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { CodeActArtifactReference, CodeCellExecutionRecord } from './types.js';

export function hashCodeCellSource(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export class CodeActArtifactRecorder {
  async record(workDir: string, record: CodeCellExecutionRecord): Promise<string> {
    const directory = await artifactDirectory(workDir, [safeSegment(record.sessionId)]);
    const serialized = JSON.stringify(record, null, 2);
    const digest = createHash('sha256').update(serialized, 'utf8').digest('hex');
    const recordPath = path.join(
      directory,
      `${String(record.generation).padStart(3, '0')}-${safeSegment(record.executionId)}-${digest.slice(0, 16)}.json`,
    );
    await writeArtifactExclusive(recordPath, Buffer.from(serialized, 'utf8'));
    return recordPath;
  }

  async putHostArtifact(
    workDir: string,
    sessionId: string,
    input: { name: string; content: string; mediaType: string },
  ): Promise<CodeActArtifactReference> {
    const bytes = Buffer.from(input.content, 'utf8');
    if (bytes.length > 10_000_000) throw new Error('CodeAct host artifact exceeds 10 MB.');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const directory = await artifactDirectory(workDir, [safeSegment(sessionId), 'host-artifacts']);
    const artifactPath = path.join(directory, `${digest.slice(0, 16)}-${safeSegment(input.name)}`);
    await writeArtifactExclusive(artifactPath, bytes);
    return {
      id: digest,
      name: input.name,
      mediaType: input.mediaType,
      path: artifactPath,
      sizeBytes: bytes.length,
    };
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 100);
  return !segment || segment === '.' || segment === '..' ? 'artifact' : segment;
}

/** Never let a cell-provided symlink redirect the host-side artifact recorder. */
async function artifactDirectory(workDir: string, segments: string[]): Promise<string> {
  const root = await realpath(path.resolve(workDir));
  let directory = root;
  for (const segment of ['.hadamard-artifacts', 'codeact', ...segments]) {
    directory = path.join(directory, segment);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (!isAlreadyExists(error)) throw error; }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe CodeAct artifact directory: symlinks are not allowed.');
    const resolved = await realpath(directory);
    if (!resolved.startsWith(root + path.sep)) throw new Error('CodeAct artifact directory escaped the working directory.');
  }
  return directory;
}

async function writeArtifactExclusive(filePath: string, bytes: Buffer): Promise<void> {
  let handle;
  try {
    handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    // Content-addressed duplicates are allowed, but a planted link or different bytes are not.
    const beforeOpen = await lstat(filePath);
    if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink() || beforeOpen.nlink !== 1) throw new Error('Unsafe CodeAct artifact: only regular files are allowed.');
    const existing = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await existing.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes.length) throw new Error('Unsafe or inconsistent CodeAct artifact.');
      const actual = Buffer.alloc(bytes.length + 1);
      let read = 0;
      while (read < actual.length) {
        const chunk = await existing.read(actual, read, actual.length - read, read);
        if (!chunk.bytesRead) break;
        read += chunk.bytesRead;
      }
      if (read !== bytes.length || !actual.subarray(0, read).equals(bytes)) throw new Error('CodeAct artifact content mismatch.');
    } finally { await existing.close(); }
    return;
  }
  try { await handle.writeFile(bytes); }
  finally { await handle.close(); }
}

/**
 * Spill oversized cell output to a session-scoped artifact and replace the
 * model-facing streams with a bounded head/tail preview plus the locator
 * (dsh spill-policy shape). Best-effort: a write failure keeps the inline
 * content unchanged and never turns the cell result into an error.
 */
export async function spillOversizedCellOutput(options: {
  artifacts: CodeActArtifactRecorder;
  workDir: string;
  sessionId: string;
  executionId: string;
  maxChars: number;
  result: { stdout: string; stderr: string; artifacts: CodeActArtifactReference[] };
}): Promise<void> {
  const combined = options.result.stderr
    ? options.result.stdout + '\n--- stderr ---\n' + options.result.stderr
    : options.result.stdout;
  if (combined.length <= options.maxChars) return;
  const artifact = await options.artifacts.putHostArtifact(
    options.workDir,
    options.sessionId,
    {
      name: 'cell-output-' + safeSegment(options.executionId) + '.txt',
      content: combined,
      mediaType: 'text/plain',
    },
  ).catch(() => undefined);
  if (!artifact) return;
  // Reserve the notice bytes INSIDE the budget so preview + locator never
  // exceed maxChars (dsh spill-policy reservation rule).
  const notice = 'Full cell output stored at: ' + artifact.path + ' (read it with the Read tool when you need the omitted middle).';
  const budget = Math.max(0, options.maxChars - notice.length - 2);
  const headChars = Math.floor(budget / 2);
  const tailChars = Math.max(0, budget - headChars);
  const omitted = Math.max(0, combined.length - headChars - tailChars);
  const preview = combined.slice(0, headChars)
    + (omitted > 0 ? '\n...[omitted ' + omitted + ' chars]...\n' : '\n')
    + combined.slice(-tailChars);
  options.result.stdout = preview + '\n' + notice;
  options.result.stderr = '';
  options.result.artifacts.push(artifact);
}
