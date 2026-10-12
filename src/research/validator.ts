import { opendir } from 'node:fs/promises';
import { safePath, safeRelative, safeRead, sha256 } from './safeFiles.js';
import type { ResearchArtifact, ResearchCriterionResult, ResearchManifest, ResearchRun } from './types.js';

/** Host-side validation uses only precommitted criteria and regular files, never experiment claims. */
export async function validateResearchArtifacts(
  manifest: ResearchManifest,
  run: Pick<ResearchRun, 'id'>,
  artifactsRoot: string,
): Promise<{ artifacts: ResearchArtifact[]; criteria: ResearchCriterionResult[]; passed: boolean }> {
  const files = new Map<string, Buffer>();
  const artifacts: ResearchArtifact[] = [];
  let totalBytes = 0;
  let collectionError: string | null = null;
  try {
    const paths = await listArtifactPaths(artifactsRoot);
    for (const artifactPath of paths) {
      const bytes = await safeRead(artifactsRoot, artifactPath, manifest.budget.maxArtifactBytes - totalBytes);
      totalBytes += bytes.length;
      files.set(artifactPath, bytes);
      const digest = sha256(bytes);
      artifacts.push({
        id: `${run.id}:${sha256(artifactPath).slice(0, 16)}:${digest}`, runId: run.id, manifestId: manifest.id, manifestDigest: manifest.digest,
        codeDigest: manifest.codeDigest, environmentDigest: manifest.environment.sha256,
        inputDigests: manifest.inputs.map(input => input.sha256), path: artifactPath,
        sha256: digest, sizeBytes: bytes.length,
        mediaType: artifactPath.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      });
    }
  } catch (error) { collectionError = error instanceof Error ? error.message : String(error); }
  const criteria = manifest.acceptanceCriteria.map((criterion): ResearchCriterionResult => {
    if (collectionError) return { criterionId: criterion.id, passed: false, reason: `Artifact collection failed: ${collectionError}` };
    const bytes = files.get(criterion.artifact);
    if (!bytes) return { criterionId: criterion.id, passed: false, reason: 'Artifact missing.' };
    const artifactDigest = sha256(bytes);
    if (criterion.kind === 'file') {
      const passed = bytes.length >= (criterion.minBytes ?? 1) && (!criterion.sha256 || criterion.sha256 === artifactDigest);
      return { criterionId: criterion.id, passed, artifactDigest, reason: passed ? 'File size and pinned digest criteria passed.' : 'File size or digest criterion failed.' };
    }
    try {
      let value: unknown = JSON.parse(bytes.toString('utf8'));
      for (const key of criterion.path.split('.')) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error(`Missing JSON field: ${criterion.path}`);
        value = (value as Record<string, unknown>)[key];
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Observed value is not a finite number.');
      const passed = Math.abs(value - criterion.expected) <= criterion.tolerance;
      return {
        criterionId: criterion.id, passed, observed: value, artifactDigest,
        reason: passed ? 'Observed value satisfies the pinned absolute tolerance.' : `Expected ${criterion.expected} ± ${criterion.tolerance}; observed ${value}.`,
      };
    } catch (error) {
      return { criterionId: criterion.id, passed: false, artifactDigest, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  return { artifacts, criteria, passed: criteria.length > 0 && criteria.every(item => item.passed) };
}

/** Bound traversal as well as total bytes, including artifacts not named by a criterion. */
async function listArtifactPaths(root: string): Promise<string[]> {
  const files: string[] = [];
  let count = 0;
  async function visit(relative: string, depth: number): Promise<void> {
    if (depth > 16) throw new Error('Artifact directory nesting exceeds 16 levels.');
    const directory = relative ? await safePath(root, relative) : root;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (++count > 256) throw new Error('Artifact tree exceeds 256 entries.');
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      safeRelative(child);
      if (entry.isSymbolicLink()) throw new Error(`Symlink artifact rejected: ${child}`);
      if (entry.isDirectory()) await visit(child, depth + 1);
      else if (entry.isFile()) files.push(child);
      else throw new Error(`Non-regular artifact rejected: ${child}`);
    }
  }
  // Verify the root itself before enumeration, even if the directory is empty.
  await safePath(root, 'placeholder');
  await visit('', 0);
  return files.sort();
}
