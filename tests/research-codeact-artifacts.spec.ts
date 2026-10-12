import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeActArtifactRecorder } from '../src/codeact/codeActArtifacts.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function workspace() { const root = await mkdtemp(path.join(os.tmpdir(), 'research-artifact-')); roots.push(root); return root; }

describe('CodeAct artifact recorder containment for research cells', () => {
  it('rejects symlink directories planted by a cell instead of writing outside the workspace', async () => {
    const root = await workspace();
    const outside = await workspace();
    await symlink(outside, path.join(root, '.hadamard-artifacts'));
    const recorder = new CodeActArtifactRecorder();
    await expect(recorder.putHostArtifact(root, 'run', { name: 'result', content: 'secret', mediaType: 'text/plain' })).rejects.toThrow('symlink');
    expect(await readdir(outside)).toEqual([]);
  });
  it('rejects symlink session directories and preserves content-addressed deduplication', async () => {
    const root = await workspace();
    const outside = await workspace();
    const recorder = new CodeActArtifactRecorder();
    const first = await recorder.putHostArtifact(root, 'safe', { name: 'result', content: '5', mediaType: 'text/plain' });
    const second = await recorder.putHostArtifact(root, 'safe', { name: 'result', content: '5', mediaType: 'text/plain' });
    expect(second.path).toBe(first.path);
    await symlink(outside, path.join(root, '.hadamard-artifacts/codeact/unsafe'));
    await expect(recorder.putHostArtifact(root, 'unsafe', { name: 'result', content: '5', mediaType: 'text/plain' })).rejects.toThrow('symlink');
  });
  it.skipIf(process.platform === 'win32')('rejects a replaced FIFO artifact without blocking duplicate verification', async () => {
    const root = await workspace();
    const recorder = new CodeActArtifactRecorder();
    const artifact = await recorder.putHostArtifact(root, 'safe', { name: 'result', content: '5', mediaType: 'text/plain' });
    await rm(artifact.path!);
    await promisify(execFile)('mkfifo', [artifact.path!]);
    await expect(recorder.putHostArtifact(root, 'safe', { name: 'result', content: '5', mediaType: 'text/plain' })).rejects.toThrow('regular');
  });
  it('rejects replaced artifact symlinks and dot-only path segments', async () => {
    const root = await workspace();
    const outside = await workspace();
    const recorder = new CodeActArtifactRecorder();
    const artifact = await recorder.putHostArtifact(root, '..', { name: '..', content: '5', mediaType: 'text/plain' });
    expect(artifact.path).toContain(path.join('codeact', 'artifact', 'host-artifacts'));
    await writeFile(path.join(outside, 'target'), '5');
    await rm(artifact.path!);
    await symlink(path.join(outside, 'target'), artifact.path!);
    await expect(recorder.putHostArtifact(root, '..', { name: '..', content: '5', mediaType: 'text/plain' })).rejects.toThrow();
  });
});
