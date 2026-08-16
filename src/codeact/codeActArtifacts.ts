import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CodeActArtifactReference, CodeCellExecutionRecord } from './types.js';

export function hashCodeCellSource(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export class CodeActArtifactRecorder {
  async record(workDir: string, record: CodeCellExecutionRecord): Promise<string> {
    const directory = path.join(
      path.resolve(workDir),
      '.hadamard-artifacts',
      'codeact',
      safeSegment(record.sessionId),
    );
    await mkdir(directory, { recursive: true });
    const serialized = JSON.stringify(record, null, 2);
    const digest = createHash('sha256').update(serialized, 'utf8').digest('hex');
    const recordPath = path.join(
      directory,
      `${String(record.generation).padStart(3, '0')}-${safeSegment(record.executionId)}-${digest.slice(0, 16)}.json`,
    );
    try {
      await writeFile(recordPath, serialized, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
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
    const directory = path.join(
      path.resolve(workDir),
      '.hadamard-artifacts',
      'codeact',
      safeSegment(sessionId),
      'host-artifacts',
    );
    await mkdir(directory, { recursive: true });
    const artifactPath = path.join(directory, `${digest.slice(0, 16)}-${safeSegment(input.name)}`);
    await writeFile(artifactPath, bytes);
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
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 100) || 'artifact';
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
