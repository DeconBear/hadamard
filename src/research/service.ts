import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { CodeCellExecutionRecord } from '../codeact/types.js';
import type { GoalEvidence } from '../goal/types.js';
import type { ToolExecutionContext } from '../types.js';
import { atomicWrite, canonicalJson, isCode, safePath, safeRead, safeRelative, sha256 } from './safeFiles.js';
import { manifestDigest, ResearchStore, researchProcessStartedAt } from './store.js';
import {
  RESEARCH_TERMINAL_STATES, ResearchError,
  type ResearchEnvironment, type ResearchManifest, type ResearchManifestInput, type ResearchPinnedFile,
  type ResearchRun, type ResearchRuntimeFingerprint, type ResearchServiceOptions, type ResearchStartOptions,
} from './types.js';
import { validateResearchArtifacts } from './validator.js';

const execFileAsync = promisify(execFile);
const MAX_INPUT_BYTES = 20_000_000;
const defaults = { timeoutMs: 30_000, maxArtifactBytes: 5_000_000, maxRuns: 3 };
const criterionSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().min(1).max(100), kind: z.literal('numeric'), artifact: z.string(), path: z.string().min(1).max(512), expected: z.number().finite(), tolerance: z.number().finite().nonnegative() }).strict(),
  z.object({ id: z.string().min(1).max(100), kind: z.literal('file'), artifact: z.string(), minBytes: z.number().int().nonnegative().max(MAX_INPUT_BYTES).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
]);
const manifestInputSchema = z.object({
  title: z.string().trim().min(1).max(200), objective: z.string().trim().min(1).max(10_000),
  code: z.string().min(1).max(1_000_000),
  inputs: z.array(z.object({ path: z.string() }).strict()).max(32).default([]),
  parameters: z.record(z.string(), z.json()).default({}),
  seeds: z.array(z.number().int().min(0).max(0xffffffff)).min(1).max(100).default([0]),
  acceptanceCriteria: z.array(criterionSchema).min(1).max(100),
  budget: z.object({ timeoutMs: z.number().int().min(100).max(3_600_000).optional(), maxArtifactBytes: z.number().int().min(1).max(MAX_INPUT_BYTES).optional(), maxRuns: z.number().int().min(1).max(100).optional() }).strict().optional(),
  environment: z.object({ lockFiles: z.array(z.string()).max(16).optional(), pythonVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional() }).strict().optional(),
}).strict();
const PROBE_CODE = [
  'import sys, platform, importlib.metadata',
  '{"pythonVersion": platform.python_version(), "implementation": platform.python_implementation(), "platform": sys.platform + "-" + platform.machine(), "packages": sorted([[d.metadata["Name"] or "", d.version] for d in importlib.metadata.distributions()])}',
].join('\n');

/** Bounded experiment orchestration over the existing CodeAct execution and isolation policy. */
export class ResearchService {
  private readonly store: ResearchStore;
  private initialization?: Promise<void>;
  private closed = false;
  private closing = false;
  private readonly preparations = new Map<Promise<ResearchManifest>, AbortController>();
  private mutationTail: Promise<unknown> = Promise.resolve();
  private executionTail: Promise<unknown> = Promise.resolve();
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void>; started: boolean }>();

  constructor(workspaceRoot: string, private readonly options: ResearchServiceOptions = {}) {
    this.store = new ResearchStore(workspaceRoot);
  }
  async initialize(): Promise<void> {
    if (this.closed) throw new ResearchError('Research service is closed.', 'unavailable');
    this.initialization ??= this.initializeOnce();
    return this.initialization;
  }
  private async initializeOnce(): Promise<void> {
    await this.store.initialize();
    // The exclusive workspace owner proves these records have no live service executor.
    for (const run of await this.store.listRuns()) {
      if (RESEARCH_TERMINAL_STATES.has(run.status)) continue;
      run.status = 'blocked';
      run.reason = 'Process restarted before settlement. The old run is not resumed; request an explicit rerun.';
      run.completedAt = new Date().toISOString();
      if (run.execution.status === 'running') run.execution.status = 'interrupted';
      await this.store.saveRun(run);
    }
  }
  async listManifests(): Promise<ResearchManifest[]> { await this.initialize(); return this.store.listManifests(); }
  async getManifest(id: string): Promise<ResearchManifest | null> { await this.initialize(); return this.store.getManifest(id); }
  async listRuns(manifestId?: string): Promise<ResearchRun[]> {
    await this.initialize();
    const runs = await this.store.listRuns();
    return runs.filter(run => !manifestId || run.manifestId === manifestId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getRun(id: string): Promise<ResearchRun | null> { await this.initialize(); return this.store.getRun(id); }

  async createManifest(input: ResearchManifestInput): Promise<ResearchManifest> {
    await this.initialize();
    if (this.closing) throw new ResearchError('Research service is closing.', 'unavailable');
    const controller = new AbortController();
    const task = this.createManifestInternal(input, controller.signal);
    this.preparations.set(task, controller);
    try { return await task; } finally { this.preparations.delete(task); }
  }
  private async createManifestInternal(input: ResearchManifestInput, signal: AbortSignal): Promise<ResearchManifest> {
    const parsed = manifestInputSchema.safeParse(input);
    if (!parsed.success) throw new ResearchError(parsed.error.message, 'invalid_manifest');
    // JSON round-trip detaches every caller-owned object before any await.
    const draft = structuredClone(parsed.data);
    if (Buffer.byteLength(canonicalJson(draft)) > 2_000_000) throw new ResearchError('Manifest exceeds 2 MB.', 'invalid_manifest');
    const ids = new Set<string>();
    for (const criterion of draft.acceptanceCriteria) {
      safeRelative(criterion.artifact);
      if (ids.has(criterion.id)) throw new ResearchError('Acceptance criterion IDs must be unique.', 'invalid_manifest');
      ids.add(criterion.id);
      if (criterion.kind === 'numeric' && criterion.path.split('.').some(key => !key || ['__proto__', 'prototype', 'constructor'].includes(key))) {
        throw new ResearchError('Invalid numeric JSON field path.', 'invalid_manifest');
      }
    }
    const paths = draft.inputs.map(item => safeInputPath(item.path));
    if (new Set(paths).size !== paths.length) throw new ResearchError('Input paths must be unique.', 'invalid_manifest');
    const inputs = await this.snapshotFiles(paths);
    const lockPaths = draft.environment?.lockFiles ?? await this.defaultLockFiles();
    const lockFiles = await this.snapshotFiles([...new Set(lockPaths.map(safeInputPath))]);
    let runtime: ResearchRuntimeFingerprint | null = null;
    const codeAct = this.options.codeAct;
    if (codeAct?.settings.enabled) {
      const id = `probe-${randomUUID()}`;
      const directory = await this.store.directory(`probes/${id}`);
      runtime = await this.probe(directory, id, signal);
      if (draft.environment?.pythonVersion && runtime.pythonVersion !== draft.environment.pythonVersion) {
        throw new ResearchError(`Python version mismatch: requested ${draft.environment.pythonVersion}, observed ${runtime.pythonVersion}.`, 'invalid_manifest');
      }
    }
    const environmentBody = {
      backend: codeAct?.settings.backend ?? null,
      securityMode: codeAct?.settings.securityMode ?? null,
      settingsDigest: codeAct ? sha256(canonicalJson(codeAct.settings)) : null,
      runtime, runtimeDigest: runtime ? sha256(canonicalJson(runtime)) : null,
      requiredPythonVersion: draft.environment?.pythonVersion ?? null,
      lockFiles,
    };
    const environment: ResearchEnvironment = { ...environmentBody, sha256: sha256(canonicalJson(environmentBody)) };
    const git = await this.gitProvenance();
    const body: Omit<ResearchManifest, 'digest'> = {
      version: 1, id: randomUUID(), createdAt: new Date().toISOString(),
      title: draft.title, objective: draft.objective, code: draft.code, codeDigest: sha256(draft.code),
      codeCommit: git.commit, codeDirty: git.dirty, inputs,
      parameters: draft.parameters, seeds: draft.seeds, acceptanceCriteria: draft.acceptanceCriteria,
      budget: { ...defaults, ...draft.budget }, environment,
    };
    const manifest = { ...body, digest: manifestDigest(body) };
    if (signal.aborted) throw signal.reason;
    await this.store.saveManifest(manifest);
    return structuredClone(manifest);
  }

  async startRun(manifestId: string, options: ResearchStartOptions = {}): Promise<ResearchRun> {
    return this.admit(manifestId, null, options);
  }
  async rerun(runId: string, options: ResearchStartOptions = {}): Promise<ResearchRun> {
    const source = await this.getRun(runId);
    if (!source) throw new ResearchError('Run not found.', 'not_found');
    if (!RESEARCH_TERMINAL_STATES.has(source.status)) throw new ResearchError('Wait for the source run to settle before rerunning.', 'conflict');
    return this.admit(source.manifestId, source.id, options);
  }
  private async admit(manifestId: string, rerunOf: string | null, options: ResearchStartOptions): Promise<ResearchRun> {
    await this.initialize();
    return this.mutate(async () => {
      if (this.closing) throw new ResearchError('Research service is closing.', 'unavailable');
      const manifest = await this.store.getManifest(manifestId);
      if (!manifest) throw new ResearchError('Manifest not found.', 'not_found');
      const key = options.idempotencyKey ?? null;
      if (key !== null && (typeof key !== 'string' || !/^[\w.:-]{1,128}$/.test(key))) throw new ResearchError('Invalid idempotency key.', 'invalid_manifest');
      const runs = await this.store.listRuns();
      if (key && runs.some(run => run.idempotencyKey === key)) throw new ResearchError('This idempotency key was already used; no run was started.', 'conflict');
      if (this.active.size >= 16) throw new ResearchError('Research queue is full.', 'conflict');
      const id = randomUUID();
      const run: ResearchRun = {
        version: 1, id, manifestId, manifestDigest: manifest.digest, rerunOf, idempotencyKey: key,
        sessionId: `research-${id}`, ownerPid: process.pid, ownerStartedAt: researchProcessStartedAt,
        status: 'queued', createdAt: new Date().toISOString(), startedAt: null, completedAt: null, reason: null,
        execution: { status: 'not_started', executionId: null, durationMs: 0, stdout: '', stderr: '', error: null, failureKind: null },
        validation: { status: 'not_run', criteria: [], summary: 'Pinned criteria have not been checked.' },
        artifacts: [], runtimeDigest: null,
        isolation: this.options.codeAct ? (this.options.codeAct.settings.backend === 'container' ? 'strong' : 'trusted-only') : 'unavailable',
      };
      if (runs.filter(item => item.manifestId === manifestId && item.reason !== 'Manifest run budget exhausted.').length >= manifest.budget.maxRuns) {
        run.status = 'blocked'; run.reason = 'Manifest run budget exhausted.'; run.completedAt = new Date().toISOString();
      }
      await this.store.saveRun(run, true);
      if (run.status === 'blocked') void this.notify(run, manifest);
      else {
        const controller = new AbortController();
        const entry = { controller, promise: Promise.resolve(), started: false };
        const promise = this.executionTail.then(() => {
          entry.started = true;
          return this.execute(run, manifest, controller);
        }).finally(() => { this.active.delete(id); });
        // Observe rejections while retaining a waitable promise; one failure must not break the queue.
        this.executionTail = promise.catch(() => undefined);
        entry.promise = promise;
        this.active.set(id, entry);
      }
      return structuredClone(run);
    });
  }
  async cancel(runId: string): Promise<ResearchRun> {
    await this.initialize();
    const run = await this.store.getRun(runId);
    if (!run) throw new ResearchError('Run not found.', 'not_found');
    if (RESEARCH_TERMINAL_STATES.has(run.status)) return run;
    const active = this.active.get(runId);
    if (!active) throw new ResearchError('Run has no active executor; reopen the service to recover it.', 'conflict');
    active.controller.abort(new Error('Cancelled by user.'));
    if (!active.started) {
      run.status = 'cancelled'; run.reason = 'Cancelled by user.'; run.completedAt = new Date().toISOString();
      await this.store.saveRun(run);
      return run;
    }
    await this.options.codeAct?.stop(run.sessionId);
    await active.promise;
    return (await this.store.getRun(runId))!;
  }
  async waitForRun(runId: string): Promise<ResearchRun> {
    await this.initialize();
    await this.active.get(runId)?.promise;
    const run = await this.store.getRun(runId);
    if (!run) throw new ResearchError('Run not found.', 'not_found');
    return run;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    await this.mutationTail;
    for (const controller of this.preparations.values()) controller.abort(new Error('Research service closed.'));
    for (const entry of this.active.values()) entry.controller.abort(new Error('Research service closed.'));
    await Promise.allSettled([...this.active.values()].map(entry => entry.promise));
    await Promise.allSettled(this.preparations.keys());
    if (this.initialization) { await this.initialization.catch(() => undefined); await this.store.close(); }
    this.closed = true;
  }

  private async execute(run: ResearchRun, manifest: ResearchManifest, controller: AbortController): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const codeAct = this.options.codeAct;
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!codeAct?.settings.enabled || !manifest.environment.runtimeDigest) throw new ResearchError('Enable CodeAct and create a runtime-pinned manifest before running this experiment.', 'unavailable');
      if (sha256(canonicalJson(codeAct.settings)) !== manifest.environment.settingsDigest) throw new ResearchError('CodeAct environment settings changed. Create a new manifest.', 'integrity');
      // Reload the immutable record before executing; never accept criteria edited in a caller object.
      const persisted = await this.store.getManifest(manifest.id);
      if (!persisted || persisted.digest !== run.manifestDigest) throw new ResearchError('Manifest no longer matches this run.', 'integrity');
      if (controller.signal.aborted) throw controller.signal.reason;
      run.startedAt = new Date().toISOString(); run.status = 'running';
      await this.store.saveRun(run);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('Experiment wall-clock budget exhausted.'));
        void codeAct.stop(run.sessionId).catch(() => undefined);
      }, manifest.budget.timeoutMs);
      timer.unref?.();
      const runDir = await this.store.directory(`work/${run.id}`);
      await this.store.directory(`work/${run.id}/inputs`);
      const artifactsRoot = await this.store.directory(`work/${run.id}/artifacts`);
      for (const input of manifest.inputs) {
        const bytes = await this.store.readBlob(input.sha256);
        await atomicWrite(runDir, `inputs/${input.path}`, bytes, true);
      }
      await atomicWrite(runDir, 'experiment.py', manifest.code, true);
      await atomicWrite(runDir, 'manifest.json', canonicalJson(manifest), true);
      await this.verifyLockFiles(manifest);
      const runtime = await this.probe(runDir, run.sessionId, controller.signal);
      run.runtimeDigest = sha256(canonicalJson(runtime));
      if (run.runtimeDigest !== manifest.environment.runtimeDigest) throw new ResearchError('Python runtime or installed dependencies drifted from the pinned environment.', 'integrity');
      if (controller.signal.aborted) throw controller.signal.reason;
      run.execution.status = 'running'; run.execution.executionId = `experiment-${run.id}`;
      await this.store.saveRun(run);
      const result = await codeAct.execute({
        language: 'python', code: this.experimentCode(manifest),
        timeoutMs: Math.max(1, manifest.budget.timeoutMs - (Date.now() - Date.parse(run.startedAt))),
        context: this.context(runDir, run.sessionId, run.execution.executionId, controller.signal), hostTools: [],
      });
      this.recordExecution(run, result);
      // Stop before validation so live kernel code cannot continue changing artifacts.
      await codeAct.stop(run.sessionId);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (result.failureKind === 'timeout') { timedOut = true; throw new Error('Experiment execution timed out.'); }
      if (result.status !== 'completed') {
        run.status = result.status === 'interrupted' ? 'cancelled' : 'failed';
        run.reason = result.error ?? 'CodeAct execution did not complete.';
      } else {
        run.status = 'validating'; await this.store.saveRun(run);
        const validation = await validateResearchArtifacts(manifest, run, artifactsRoot);
        // Preserve exact validated bytes outside the mutable work directory.
        for (const artifact of validation.artifacts) {
          const bytes = await safeRead(artifactsRoot, artifact.path, manifest.budget.maxArtifactBytes);
          if (sha256(bytes) !== artifact.sha256) throw new ResearchError('Artifact changed during validation.', 'integrity');
          await this.store.putBlob(bytes);
        }
        for (const input of manifest.inputs) {
          if (sha256(await safeRead(runDir, `inputs/${input.path}`, MAX_INPUT_BYTES)) !== input.sha256) throw new ResearchError('Experiment modified a pinned input.', 'integrity');
        }
        if (sha256(await safeRead(runDir, 'experiment.py', 1_000_000)) !== manifest.codeDigest
            || sha256(await safeRead(runDir, 'manifest.json', 2_000_000)) !== sha256(canonicalJson(manifest))) {
          throw new ResearchError('Experiment modified its staged code or manifest.', 'integrity');
        }
        if (controller.signal.aborted) throw controller.signal.reason;
        run.artifacts = validation.artifacts;
        run.validation = { status: validation.passed ? 'passed' : 'failed', criteria: validation.criteria,
          summary: validation.passed ? 'All precommitted acceptance criteria passed. This is not a claim of scientific validity.' : 'One or more precommitted acceptance criteria failed.' };
        run.status = validation.passed ? 'passed' : 'failed';
        run.reason = validation.passed ? null : run.validation.summary;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      run.status = timedOut ? 'timed_out' : controller.signal.aborted ? 'cancelled' : error instanceof ResearchError ? 'blocked' : 'failed';
      run.reason = message;
      if (run.execution.status === 'running') { run.execution.status = 'interrupted'; run.execution.error = message; }
    } finally {
      if (timer) clearTimeout(timer);
      // Disposal errors are surfaced and cannot turn an unvalidated run into success.
      try { await codeAct?.stop(run.sessionId); }
      catch (error) { run.status = 'blocked'; run.reason = `Kernel cleanup failed: ${error instanceof Error ? error.message : String(error)}`; }
      run.completedAt = new Date().toISOString();
      await this.store.saveRun(run);
      await this.notify(run, manifest);
    }
  }

  private async snapshotFiles(paths: string[]): Promise<ResearchPinnedFile[]> {
    let total = 0;
    const output: ResearchPinnedFile[] = [];
    for (const item of paths.sort()) {
      const bytes = await safeRead(this.store.workspaceRoot, item, MAX_INPUT_BYTES - total);
      total += bytes.length;
      output.push({ path: item, sizeBytes: bytes.length, sha256: await this.store.putBlob(bytes) });
    }
    return output;
  }
  private async defaultLockFiles(): Promise<string[]> {
    const result: string[] = [];
    for (const candidate of ['requirements.txt', 'uv.lock', 'poetry.lock', 'Pipfile.lock', 'package-lock.json']) {
      try { await lstat(await safePath(this.store.workspaceRoot, candidate)); result.push(candidate); }
      catch (error) { if (!isCode(error, 'ENOENT')) throw error; }
    }
    return result;
  }
  private async verifyLockFiles(manifest: ResearchManifest): Promise<void> {
    for (const file of manifest.environment.lockFiles) {
      try {
        if (sha256(await safeRead(this.store.workspaceRoot, file.path, MAX_INPUT_BYTES)) !== file.sha256) throw new Error('Digest mismatch.');
      } catch {
        throw new ResearchError(`Environment lockfile drifted or became unreadable: ${file.path}`, 'integrity');
      }
    }
  }
  private async probe(cwd: string, sessionId: string, signal?: AbortSignal): Promise<ResearchRuntimeFingerprint> {
    const service = this.options.codeAct!;
    try {
      const result = await service.execute({ language: 'python', code: PROBE_CODE, timeoutMs: 10_000,
        context: this.context(cwd, sessionId, `environment-${randomUUID()}`, signal), hostTools: [] });
      if (result.status !== 'completed') throw new ResearchError(result.error ?? 'Environment probe failed.', 'unavailable');
      const parsed = z.object({ pythonVersion: z.string(), implementation: z.string(), platform: z.string(), packages: z.array(z.tuple([z.string(), z.string()])) }).strict().safeParse(result.result?.value);
      if (!parsed.success) throw new ResearchError('CodeAct returned an invalid environment fingerprint.', 'unavailable');
      return parsed.data;
    } finally { await service.stop(sessionId); }
  }
  private experimentCode(manifest: ResearchManifest): string {
    // A new namespace receives data as JSON, never interpolated Python expressions.
    return [
      'import json as _research_json, random as _research_random',
      `RESEARCH_PARAMETERS = _research_json.loads(${JSON.stringify(canonicalJson(manifest.parameters))})`,
      `RESEARCH_SEEDS = _research_json.loads(${JSON.stringify(canonicalJson(manifest.seeds))})`,
      '_research_random.seed(RESEARCH_SEEDS[0])',
      `exec(compile(${JSON.stringify(manifest.code)}, 'experiment.py', 'exec'), globals())`,
    ].join('\n');
  }
  private context(cwd: string, sessionId: string, executionId: string, signal?: AbortSignal): ToolExecutionContext {
    return { cwd, sessionId, runId: sessionId, toolUseId: executionId, signal, metadata: { research: true },
      prompt: 'Execute a precommitted research experiment.', iteration: 1 };
  }
  private recordExecution(run: ResearchRun, result: CodeCellExecutionRecord): void {
    run.execution = { status: result.status, executionId: result.executionId, durationMs: result.durationMs,
      stdout: result.stdout, stderr: result.stderr, error: result.error ?? null, failureKind: result.failureKind ?? null };
  }
  private async gitProvenance(): Promise<{ commit: string | null; dirty: boolean | null }> {
    try {
      const options = { cwd: this.store.workspaceRoot, timeout: 5_000, maxBuffer: 1_000_000 };
      const head = await execFileAsync('git', ['rev-parse', 'HEAD'], options);
      const status = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=no'], options);
      const commit = head.stdout.trim();
      return { commit: /^[a-f0-9]{40,64}$/.test(commit) ? commit : null, dirty: Boolean(status.stdout.trim()) };
    } catch { return { commit: null, dirty: null }; }
  }
  private async notify(run: ResearchRun, manifest: ResearchManifest): Promise<void> {
    try { await this.options.onRunSettled?.(structuredClone(run), structuredClone(manifest), researchGoalEvidence(run)); }
    catch { /* Goal/UI observers cannot change or invalidate the persisted result. */ }
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const next = this.mutationTail.then(action);
    this.mutationTail = next.catch(() => undefined);
    return next;
  }
}
function safeInputPath(value: string): string {
  safeRelative(value);
  if (value.split('/').some(segment => ['.git', '.hadamard', '.hadamard-artifacts'].includes(segment))) throw new ResearchError('Research metadata cannot be an input.', 'unsafe_path');
  return value;
}
/** Opt-in evidence only; never marks an ordinary Goal complete or asserts scientific truth. */
export function researchGoalEvidence(run: ResearchRun): GoalEvidence {
  const passed = run.status === 'passed' && run.execution.status === 'completed' && run.validation.status === 'passed';
  return { id: `research:${run.id}`, at: run.completedAt ?? run.createdAt, kind: 'validation',
    ref: `research-run:${run.id}`, verified: passed,
    note: passed ? `Research run ${run.id} passed its precommitted acceptance criteria; scientific validity is not established.` : `Research run ${run.id}: ${run.status}. ${run.reason ?? run.validation.summary}` };
}
