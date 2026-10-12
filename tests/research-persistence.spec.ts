import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeActService } from '../src/codeact/codeActService.js';
import { ResearchService, researchGoalEvidence } from '../src/research/service.js';
import { atomicWrite, safeRead } from '../src/research/safeFiles.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const roots: string[] = [];
const services: ResearchService[] = [];
const codeActs: CodeActService[] = [];
afterEach(async () => {
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  vi.mocked(fs.open).mockImplementation(actual.open);
  await Promise.all(services.splice(0).map(service => service.close()));
  await Promise.all(codeActs.splice(0).map(service => service.close()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
});
function fsError(code: string) { return Object.assign(new Error(`rename ${code}: injected sharing violation`), { code }); }
async function root() { const result = await fs.mkdtemp(path.join(os.tmpdir(), 'research-persistence-')); roots.push(result); return result; }
async function experiment() {
  const directory = await root();
  const codeAct = new CodeActService({ enabled: true }); codeActs.push(codeAct);
  const service = new ResearchService(directory, { codeAct }); services.push(service);
  const manifest = await service.createManifest({
    title: 'Persistence test', objective: 'Validate a deterministic artifact',
    code: 'from pathlib import Path\nPath("artifacts/value.txt").write_text("5")',
    acceptanceCriteria: [{ id: 'value', kind: 'file', artifact: 'value.txt' }], budget: { timeoutMs: 5000 },
  });
  return { directory, service, manifest };
}

describe('Research atomic persistence under Windows sharing violations', () => {
  it('accepts a regular file descriptor unlinked by atomic replacement after it was opened', async () => {
    const directory = await root();
    const target = path.join(directory, 'run.json');
    await fs.writeFile(target, 'previous');
    const replacement = path.join(directory, 'replacement.json');
    await fs.writeFile(replacement, 'next');
    vi.mocked(fs.open).mockImplementation(async (filePath, flags, mode) => {
      const handle = await actual.open(filePath, flags, mode);
      if (String(filePath) === target) {
        if (process.platform === 'win32') {
          // The same detached-descriptor metadata, without relying on NTFS sharing behavior.
          const stat = handle.stat.bind(handle);
          vi.spyOn(handle, 'stat').mockImplementation(async () => Object.assign(await stat(), { nlink: 0 }));
        } else {
          await actual.rename(replacement, target);
          expect((await handle.stat()).nlink).toBe(0);
        }
      }
      return handle;
    });
    expect((await safeRead(directory, 'run.json', 1024)).toString()).toBe('previous');
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'])('retries transient %s without losing the original record or atomic replacement', async code => {
    const directory = await root();
    await atomicWrite(directory, 'run.json', '{"status":"running"}');
    let attempts = 0;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (++attempts < 3) {
        expect((await safeRead(directory, 'run.json', 1024)).toString()).toBe('{"status":"running"}');
        throw fsError(code);
      }
      await actual.rename(from, to);
    });
    await atomicWrite(directory, 'run.json', '{"status":"passed"}');
    expect(attempts).toBe(3);
    expect((await safeRead(directory, 'run.json', 1024)).toString()).toBe('{"status":"passed"}');
    expect(await fs.readdir(directory)).toEqual(['run.json']);
  });

  it('bounds retries and propagates non-retryable write failures without deleting the previous record', async () => {
    const directory = await root();
    await atomicWrite(directory, 'run.json', 'previous');
    vi.mocked(fs.rename).mockRejectedValue(fsError('EPERM'));
    await expect(atomicWrite(directory, 'run.json', 'next')).rejects.toMatchObject({ code: 'EPERM' });
    expect(fs.rename).toHaveBeenCalledTimes(9); // initial successful write plus eight bounded retry attempts
    vi.mocked(fs.rename).mockClear().mockRejectedValue(fsError('ENOSPC'));
    await expect(atomicWrite(directory, 'run.json', 'next')).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(fs.rename).toHaveBeenCalledTimes(1);
    expect((await safeRead(directory, 'run.json', 1024)).toString()).toBe('previous');
    expect(await fs.readdir(directory)).toEqual(['run.json']);
  });

  it('persists an HTTP-style polled rerun after a transient error in the final rename', async () => {
    const { service, manifest } = await experiment();
    const first = await service.waitForRun((await service.startRun(manifest.id)).id);
    expect(first.status).toBe('passed');
    let injected = 0;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      const record = JSON.parse(await fs.readFile(from, 'utf8'));
      if (record.rerunOf && record.status === 'passed' && !injected++) throw fsError('EPERM');
      await actual.rename(from, to);
    });
    const second = await service.rerun(first.id);
    await expect(service.waitForRun(second.id)).resolves.toMatchObject({ status: 'passed' });
    expect(injected).toBeGreaterThan(0);
    expect((await service.getRun(second.id))?.status).toBe('passed');
  });

  it('exposes an exhausted final-write failure as blocked rather than polling a stale pending record forever', async () => {
    const { directory, service, manifest } = await experiment();
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      const record = JSON.parse(await fs.readFile(from, 'utf8'));
      if (record.status === 'passed') throw fsError('EPERM');
      await actual.rename(from, to);
    });
    const run = await service.startRun(manifest.id, { idempotencyKey: 'persist-failure' });
    const terminal = await service.waitForRun(run.id);
    expect(terminal.status).toBe('blocked');
    expect(terminal.reason).toContain('could not be persisted');
    expect(terminal.reason).toContain('in memory only');
    expect(researchGoalEvidence(terminal).verified).toBe(false);
    await expect(service.startRun(manifest.id, { idempotencyKey: 'persist-failure' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await service.getRun(run.id))?.status).toBe('blocked');
    expect((await service.listRuns())[0]?.status).toBe('blocked');
    expect((await service.cancel(run.id)).status).toBe('blocked');
    const persisted = JSON.parse(await fs.readFile(path.join(directory, '.hadamard/research/v1/runs', `${run.id}.json`), 'utf8'));
    expect(persisted.status).toBe('validating'); // never falsely claim the failed write reached disk
    vi.mocked(fs.rename).mockImplementation(actual.rename);
    await service.close();
    const reopened = new ResearchService(directory); services.push(reopened);
    expect((await reopened.getRun(run.id))?.status).toBe('blocked');
    expect((await reopened.getRun(run.id))?.reason).toContain('restarted');
  });
});
