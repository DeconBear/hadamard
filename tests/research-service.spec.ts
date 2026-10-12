import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeActService } from '../src/codeact/codeActService.js';
import { ResearchService, researchGoalEvidence, type ResearchManifestInput } from '../src/research/index.js';
import { ResearchStore } from '../src/research/store.js';

const directories: string[] = [];
const researchServices: ResearchService[] = [];
const codeServices: CodeActService[] = [];
afterEach(async () => {
  await Promise.all(researchServices.splice(0).map(service => service.close()));
  await Promise.all(codeServices.splice(0).map(service => service.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture(withExecution = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-research-'));
  directories.push(root);
  const codeAct = withExecution ? new CodeActService({ enabled: true, backend: 'process', securityMode: 'trusted', executionTimeoutMs: 3000 }) : undefined;
  if (codeAct) codeServices.push(codeAct);
  const service = new ResearchService(root, { codeAct });
  researchServices.push(service);
  await service.initialize();
  return { root, service, codeAct };
}
function experiment(overrides: Partial<ResearchManifestInput> = {}): ResearchManifestInput {
  return {
    title: 'Deterministic addition', objective: 'Check a toy arithmetic result using precommitted criteria.',
    code: 'import json\nfrom pathlib import Path\nPath("artifacts/result.json").write_text(json.dumps({"sum": RESEARCH_PARAMETERS["a"] + RESEARCH_PARAMETERS["b"]}))',
    parameters: { a: 2, b: 3 }, seeds: [123],
    acceptanceCriteria: [{ id: 'sum', kind: 'numeric', artifact: 'result.json', path: 'sum', expected: 5, tolerance: 0 }],
    budget: { timeoutMs: 5000, maxRuns: 3, maxArtifactBytes: 10000 },
    ...overrides,
  };
}

describe('ResearchService bounded experiment lifecycle', () => {
  it('pins the manifest, independently validates a toy fixture, and creates distinct reproducible reruns', async () => {
    const { service } = await fixture();
    const manifest = await service.createManifest(experiment());
    expect(manifest.environment.runtime?.pythonVersion).toMatch(/^\d+\./);
    expect(manifest.environment.runtimeDigest).toHaveLength(64);
    const first = await service.startRun(manifest.id, { idempotencyKey: 'first' });
    const finished = await service.waitForRun(first.id);
    expect(finished.status).toBe('passed');
    expect(finished.execution.status).toBe('completed');
    expect(finished.validation.criteria[0]?.observed).toBe(5);
    expect(finished.artifacts[0]?.manifestDigest).toBe(manifest.digest);
    expect(finished.isolation).toBe('trusted-only');
    const second = await service.rerun(first.id, { idempotencyKey: 'second' });
    const rerun = await service.waitForRun(second.id);
    expect(second.id).not.toBe(first.id);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.rerunOf).toBe(first.id);
    expect(rerun.artifacts[0]?.sha256).toBe(finished.artifacts[0]?.sha256);
    expect(researchGoalEvidence(finished).verified).toBe(true);
    expect(researchGoalEvidence(first).verified).toBe(false);
    await expect(service.startRun(manifest.id, { idempotencyKey: 'first' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not equate exit success or printed claims with numeric validation', async () => {
    const { service } = await fixture();
    const manifest = await service.createManifest(experiment({
      code: 'from pathlib import Path\nprint("all criteria passed")\nPath("artifacts/result.json").write_text(\'{"sum": 4}\')',
    }));
    const run = await service.waitForRun((await service.startRun(manifest.id)).id);
    expect(run.execution.status).toBe('completed');
    expect(run.status).toBe('failed');
    expect(run.validation.status).toBe('failed');
    expect(researchGoalEvidence(run).verified).toBe(false);
  });

  it('validates pinned file hashes separately from numeric checks and records all artifact lineage', async () => {
    const { service } = await fixture();
    const hash = createHash('sha256').update('toy report').digest('hex');
    const manifest = await service.createManifest(experiment({
      code: experiment().code + '\nfrom pathlib import Path\nPath("artifacts/report.txt").write_text("toy report")\nPath("artifacts/copy.txt").write_text("toy report")',
      acceptanceCriteria: [...experiment().acceptanceCriteria, { id: 'report', kind: 'file', artifact: 'report.txt', minBytes: 5, sha256: hash }],
    }));
    const run = await service.waitForRun((await service.startRun(manifest.id)).id);
    expect(run.status).toBe('passed');
    expect(run.artifacts).toHaveLength(3);
    expect(new Set(run.artifacts.map(artifact => artifact.id)).size).toBe(3);
    expect(run.validation.criteria.find(criterion => criterion.criterionId === 'report')?.passed).toBe(true);
    const mismatch = await service.createManifest(experiment({
      code: 'from pathlib import Path\nPath("artifacts/report.txt").write_text("tampered report")',
      acceptanceCriteria: [{ id: 'report', kind: 'file', artifact: 'report.txt', sha256: hash }],
    }));
    expect((await service.waitForRun((await service.startRun(mismatch.id)).id)).validation.status).toBe('failed');
  });

  it('stages immutable input snapshots and ignores later caller mutations', async () => {
    const { root, service } = await fixture();
    await mkdir(path.join(root, 'data'));
    await writeFile(path.join(root, 'data/value.txt'), '5');
    const request = experiment({ inputs: [{ path: 'data/value.txt' }],
      code: 'from pathlib import Path\nimport json\nPath("artifacts/result.json").write_text(json.dumps({"sum": int(Path("inputs/data/value.txt").read_text())}))' });
    const manifest = await service.createManifest(request);
    await writeFile(path.join(root, 'data/value.txt'), '99');
    manifest.acceptanceCriteria[0] = { id: 'sum', kind: 'numeric', artifact: 'result.json', path: 'sum', expected: 99, tolerance: 0 };
    request.parameters = { a: 90 };
    const run = await service.waitForRun((await service.startRun(manifest.id)).id);
    expect(run.status).toBe('passed');
    expect(run.validation.criteria[0]?.observed).toBe(5);
    expect((await service.getManifest(manifest.id))?.parameters).toEqual({ a: 2, b: 3 });
  });

  it('fails closed without a configured execution service', async () => {
    const { service } = await fixture(false);
    const manifest = await service.createManifest(experiment());
    const run = await service.waitForRun((await service.startRun(manifest.id)).id);
    expect(manifest.environment.runtimeDigest).toBeNull();
    expect(run.status).toBe('blocked');
    expect(run.execution.status).toBe('not_started');
  });

  it('enforces bounded runs and rejects duplicate concurrent idempotency keys', async () => {
    const { service } = await fixture();
    const manifest = await service.createManifest(experiment({ budget: { maxRuns: 1, timeoutMs: 5000 } }));
    const outcomes = await Promise.allSettled([
      service.startRun(manifest.id, { idempotencyKey: 'same' }), service.startRun(manifest.id, { idempotencyKey: 'same' }),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    const run = (await service.listRuns())[0]!;
    await service.waitForRun(run.id);
    const blocked = await service.rerun(run.id);
    expect(blocked.status).toBe('blocked');
    expect(blocked.reason).toContain('budget');
    expect(blocked.execution.status).toBe('not_started');
  });

  it('records execution errors and time budget exhaustion separately', async () => {
    const { service } = await fixture();
    const failure = await service.createManifest(experiment({ code: 'raise RuntimeError("toy failure")' }));
    const failed = await service.waitForRun((await service.startRun(failure.id)).id);
    expect(failed.status).toBe('failed');
    expect(failed.execution.error).toContain('toy failure');
    expect(failed.validation.status).toBe('not_run');
    const timeout = await service.createManifest(experiment({ code: 'import time\ntime.sleep(30)', budget: { timeoutMs: 300 } }));
    const timed = await service.waitForRun((await service.startRun(timeout.id)).id);
    expect(timed.status).toBe('timed_out');
    expect(timed.validation.status).toBe('not_run');
  });

  it('cancels a running experiment and allows an explicit unique rerun', async () => {
    const { service } = await fixture();
    const manifest = await service.createManifest(experiment({ code: 'import time\ntime.sleep(30)', budget: { timeoutMs: 5000 } }));
    const initial = await service.startRun(manifest.id);
    const cancelled = await service.cancel(initial.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.validation.status).toBe('not_run');
    const again = await service.rerun(initial.id);
    expect(again.id).not.toBe(initial.id);
    await service.cancel(again.id);
  });

  it('blocks environment drift and tampered immutable manifests', async () => {
    const { root, service } = await fixture();
    await writeFile(path.join(root, 'requirements.txt'), '# no third party dependencies\n');
    const manifest = await service.createManifest(experiment());
    await writeFile(path.join(root, 'requirements.txt'), '# changed lock\n');
    const drift = await service.waitForRun((await service.startRun(manifest.id)).id);
    expect(drift.status).toBe('blocked');
    expect(drift.reason).toContain('drifted');
    const file = path.join(root, '.hadamard/research/v1/manifests', `${manifest.id}.json`);
    const json = JSON.parse(await readFile(file, 'utf8'));
    json.acceptanceCriteria[0].expected = 999;
    await writeFile(file, JSON.stringify(json));
    await expect(service.getManifest(manifest.id)).rejects.toMatchObject({ code: 'integrity' });
  });

  it('compares observed runtime dependency fingerprints before executing code', async () => {
    const { service, codeAct } = await fixture();
    const manifest = await service.createManifest(experiment());
    const execute = codeAct!.execute.bind(codeAct);
    vi.spyOn(codeAct!, 'execute').mockImplementation(async input => {
      const result = await execute(input);
      if (input.code.includes('importlib.metadata')) {
        const value = result.result!.value as { packages: [string, string][] };
        value.packages.push(['unexpected-package', '1.0']);
      }
      return result;
    });
    const run = await service.waitForRun((await service.startRun(manifest.id)).id);
    expect(run.status).toBe('blocked');
    expect(run.reason).toContain('dependencies drifted');
    expect(run.execution.status).toBe('not_started');
  });

  it('cancels queued work immediately without waiting for the active experiment', async () => {
    const { service } = await fixture();
    const manifest = await service.createManifest(experiment({ code: 'import time\ntime.sleep(1)\n' + experiment().code }));
    const first = await service.startRun(manifest.id);
    const second = await service.startRun(manifest.id);
    const start = Date.now();
    expect((await service.cancel(second.id)).status).toBe('cancelled');
    expect(Date.now() - start).toBeLessThan(500);
    await service.cancel(first.id);
    expect((await service.waitForRun(second.id)).status).toBe('cancelled');
  });

  it('releases its store lock after failed initialization and concurrent shutdown', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-research-lock-'));
    directories.push(root);
    const metadata = path.join(root, '.hadamard/research/v1');
    await mkdir(metadata, { recursive: true });
    await symlink(os.tmpdir(), path.join(metadata, 'runs'));
    const bad = new ResearchService(root);
    researchServices.push(bad);
    await expect(bad.initialize()).rejects.toMatchObject({ code: 'unsafe_path' });
    await expect(readFile(path.join(metadata, 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(path.join(metadata, 'runs'));
    const working = new ResearchService(root);
    researchServices.push(working);
    await working.initialize();
    const competing = new ResearchService(root);
    researchServices.push(competing);
    await expect(competing.initialize()).rejects.toMatchObject({ code: 'conflict' });
    const pending = working.createManifest(experiment()).catch(error => error);
    await working.close();
    await pending;
    await expect(readFile(path.join(metadata, 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers interrupted persisted work as blocked after reopening, never silently resumes', async () => {
    const { root, service } = await fixture(false);
    const manifest = await service.createManifest(experiment());
    const run = await service.waitForRun((await service.startRun(manifest.id)).id);
    await service.close();
    const store = new ResearchStore(root);
    await store.initialize();
    run.status = 'running'; run.execution.status = 'running'; run.completedAt = null;
    await store.saveRun(run);
    await store.close();
    const reopened = new ResearchService(root);
    researchServices.push(reopened);
    const recovered = await reopened.getRun(run.id);
    expect(recovered?.status).toBe('blocked');
    expect(recovered?.reason).toContain('explicit rerun');
    expect(recovered?.execution.status).toBe('interrupted');
  });
});

describe('Research filesystem safety', () => {

  it.skipIf(process.platform === 'win32')('rejects FIFO inputs and artifacts without blocking the event loop', async () => {
    const { root, service } = await fixture();
    await promisify(execFile)('mkfifo', [path.join(root, 'pipe')]);
    await expect(service.createManifest(experiment({ inputs: [{ path: 'pipe' }] }))).rejects.toMatchObject({ code: 'unsafe_path' });
    const manifest = await service.createManifest(experiment({ code: 'import os\nos.mkfifo("artifacts/result.json")' }));
    const run = await service.waitForRun((await service.startRun(manifest.id)).id);
    expect(run.status).toBe('failed');
    expect(run.validation.criteria[0]?.reason).toContain('Non-regular');
  });

  it('counts undeclared artifacts against the aggregate output budget', async () => {
    const { service } = await fixture();
    const manifest = await service.createManifest(experiment({
      code: 'from pathlib import Path\nPath("artifacts/result.json").write_text(\'{"sum":5}\')\nPath("artifacts/extra.txt").write_text("x" * 200)',
      budget: { maxArtifactBytes: 100, timeoutMs: 5000 },
    }));
    const run = await service.waitForRun((await service.startRun(manifest.id)).id);
    expect(run.status).toBe('failed');
    expect(run.validation.criteria[0]?.reason).toContain('budget');
  });
  it('rejects traversal, absolute paths, duplicate criterion IDs, and symlink input ancestors', async () => {
    const { root, service } = await fixture(false);
    await expect(service.createManifest(experiment({ inputs: [{ path: '../secret' }] }))).rejects.toMatchObject({ code: 'unsafe_path' });
    await expect(service.createManifest(experiment({ inputs: [{ path: '/etc/passwd' }] }))).rejects.toMatchObject({ code: 'unsafe_path' });
    await expect(service.createManifest(experiment({ acceptanceCriteria: [{ id: 'bad', kind: 'file', artifact: '../escape' }] }))).rejects.toMatchObject({ code: 'unsafe_path' });
    await expect(service.createManifest(experiment({ acceptanceCriteria: [{ id: 'a', kind: 'file', artifact: 'x' }, { id: 'a', kind: 'file', artifact: 'y' }] }))).rejects.toMatchObject({ code: 'invalid_manifest' });
    await symlink(os.tmpdir(), path.join(root, 'linked'));
    await expect(service.createManifest(experiment({ inputs: [{ path: 'linked/anything' }] }))).rejects.toMatchObject({ code: 'unsafe_path' });
  });

  it('rejects symlink artifacts even when their contents satisfy the criteria', async () => {
    const { service } = await fixture();
    const manifest = await service.createManifest(experiment({ code:
      'from pathlib import Path\nPath("outside.json").write_text(\'{"sum":5}\')\nPath("artifacts/result.json").symlink_to("../outside.json")' }));
    const run = await service.waitForRun((await service.startRun(manifest.id)).id);
    expect(run.execution.status).toBe('completed');
    expect(run.status).toBe('failed');
    expect(run.validation.criteria[0]?.reason).toContain('Symlink');
    expect(run.artifacts).toHaveLength(0);
  });

  it('fails validation for missing, oversized, nonnumeric, and nonfinite results', async () => {
    const { service } = await fixture();
    for (const content of ['{"sum":"5"}', '{"sum":1e999}', '{"other":5}', 'x'.repeat(200)]) {
      const manifest = await service.createManifest(experiment({
        code: `from pathlib import Path\nPath("artifacts/result.json").write_text(${JSON.stringify(content)})`,
        budget: { maxArtifactBytes: 100, timeoutMs: 5000 },
      }));
      const run = await service.waitForRun((await service.startRun(manifest.id)).id);
      expect(run.status).toBe('failed');
      expect(run.validation.status).toBe('failed');
    }
  });
});
