import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SidecarBroker } from '../src/hcanvas/sidecar/broker.js';
import { HcRuntimeError, type HcSidecarCatalogEntry, type HcSidecarDeclaration, type HcSidecarRuntimeEvent } from '../src/hcanvas/sidecar/protocol.js';
import type { HcSidecarLimits } from '../src/hcanvas/sidecar/limits.js';
import { isProcessAlive } from '../src/hcanvas/sidecar/spawn.js';

const FIXTURE = path.resolve('tests/fixtures/hcanvas-sidecar/fake_sidecar.mjs');
const REQUEST_METHODS = ['echo', 'render', 'slow', 'flood', 'seqs', 'log', 'bigline', 'artifact', 'crash', 'stderr', 'shutdown'];
const roots: string[] = [];
const brokers: SidecarBroker[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(brokers.splice(0).map(broker => broker.stopAll('test cleanup').catch(() => undefined)));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

interface Harness {
  broker: SidecarBroker;
  entry: HcSidecarCatalogEntry;
  events: HcSidecarRuntimeEvent[];
  spawnOptions: SpawnOptions[];
  extensionDir: string;
  workspaceDir: string;
  declaration: HcSidecarDeclaration;
}

async function tempDirs(): Promise<{ extensionDir: string; workspaceDir: string }> {
  const extensionDir = await mkdtemp(path.join(os.tmpdir(), 'hc-sidecar-ext-'));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'hc-sidecar-ws-'));
  roots.push(extensionDir, workspaceDir);
  return { extensionDir, workspaceDir };
}

function makeDeclaration(mode?: string): HcSidecarDeclaration {
  return {
    id: 'fake',
    label: 'Fake sidecar',
    command: [process.execPath, FIXTURE, ...(mode ? ['--mode=' + mode] : [])],
    cwd: 'extension',
    requests: REQUEST_METHODS.map(method => ({ method })),
  };
}

async function createHarness(options: {
  mode?: string;
  declaration?: Partial<HcSidecarDeclaration>;
  limits?: Partial<HcSidecarLimits>;
  extensionId?: string;
} = {}): Promise<Harness> {
  const { extensionDir, workspaceDir } = await tempDirs();
  const declaration: HcSidecarDeclaration = { ...makeDeclaration(options.mode), ...(options.declaration ?? {}) };
  const extensionId = options.extensionId ?? 'ext.fake';
  const entry: HcSidecarCatalogEntry = { extensionId, extensionDir, declaration };
  const events: HcSidecarRuntimeEvent[] = [];
  const spawnOptions: SpawnOptions[] = [];
  const broker = new SidecarBroker({
    workspaceDir,
    catalog: { resolveSidecar: sidecarId => (sidecarId === declaration.id ? entry : null) },
    enforceLimitCaps: false,
    limits: { idleTimeoutMs: 0, ...(options.limits ?? {}) },
    onEvent: event => events.push(event),
    spawnImpl: (file, args, spawnOptionsArg) => {
      spawnOptions.push(spawnOptionsArg);
      return spawn(file, args, spawnOptionsArg);
    },
  });
  brokers.push(broker);
  return { broker, entry, events, spawnOptions, extensionDir, workspaceDir, declaration };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function eventsNamed(events: HcSidecarRuntimeEvent[], name: HcSidecarRuntimeEvent['event']): HcSidecarRuntimeEvent[] {
  return events.filter(event => event.event === name);
}

function errorOf(value: unknown): HcRuntimeError {
  expect(value).toBeInstanceOf(HcRuntimeError);
  return value as HcRuntimeError;
}

describe('sidecar broker', () => {
  it('spawns with argv arrays, confined cwd and a filtered environment', async () => {
    vi.stubEnv('HADAMARD_SECRET', 'secret');
    vi.stubEnv('HCANVAS_TOKEN', 'token');
    vi.stubEnv('API_KEY', 'key');
    vi.stubEnv('TEST_KEEPME', 'yes');
    const harness = await createHarness({
      declaration: { env: { FOO: 'bar', HADAMARD_THING: 'nope', API_TOKEN: 'nope', HCANVAS_X: 'nope' } },
    });
    const snapshot = await harness.broker.startDeclared(harness.entry);
    expect(snapshot.state).toBe('ready');
    expect(typeof snapshot.pid).toBe('number');
    expect(snapshot.command).toEqual(harness.declaration.command);
    expect(snapshot.cwd).toBe(await realpath(harness.extensionDir));
    expect(snapshot.queue).toEqual({ pendingRequests: 0, queuedFrames: 0, paused: false });
    expect(harness.spawnOptions).toHaveLength(1);
    const spawnArg = harness.spawnOptions[0]!;
    expect(spawnArg.shell).toBe(false);
    expect(spawnArg.windowsHide).toBe(true);
    expect(spawnArg.cwd).toBe(snapshot.cwd);
    const env = spawnArg.env as Record<string, string>;
    expect(env.FOO).toBe('bar');
    expect(env.HADAMARD_SECRET).toBeUndefined();
    expect(env.HCANVAS_TOKEN).toBeUndefined();
    expect(env.API_KEY).toBeUndefined();
    expect(env.HADAMARD_THING).toBeUndefined();
    expect(env.API_TOKEN).toBeUndefined();
    expect(env.HCANVAS_X).toBeUndefined();
    expect(env.TEST_KEEPME).toBeUndefined();
    if (process.env.PATH) expect(env.PATH).toBe(process.env.PATH);
    await harness.broker.stopAll('done');
  });

  it('dedupes instances by instance key', async () => {
    const harness = await createHarness();
    const first = await harness.broker.startDeclared(harness.entry);
    const second = await harness.broker.startDeclared(harness.entry);
    expect(second.pid).toBe(first.pid);
    expect(harness.broker.list()).toHaveLength(1);
    await harness.broker.stopAll('done');
  });

  it('completes the initialize handshake and serves echo requests', async () => {
    const harness = await createHarness();
    const outcome = await harness.broker.request('fake', 'echo', { a: 1, b: 'two' }, { timeoutMs: 2_000 });
    expect(outcome.result).toEqual({ a: 1, b: 'two' });
    expect(outcome.stdout).toBe('');
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    const snapshot = harness.broker.snapshot('fake');
    expect(snapshot?.state).toBe('ready');
    expect(snapshot?.serverInfo?.name).toBe('fake-sidecar');
    await harness.broker.stopAll('done');
  });

  it('routes progress, output chunks and artifacts', async () => {
    const harness = await createHarness();
    const outcome = await harness.broker.request('fake', 'render', { chunks: 3 }, { timeoutMs: 3_000 });
    expect(outcome.stdout).toBe('chunk1\nchunk2\nchunk3\n');
    expect(outcome.progressCount).toBe(5);
    expect(outcome.artifacts).toHaveLength(1);
    expect(outcome.artifacts[0]!.relativePath).toBe('out.txt');
    expect(outcome.artifacts[0]!.size).toBeGreaterThan(0);
    expect(path.isAbsolute(outcome.artifacts[0]!.path)).toBe(true);
    expect(eventsNamed(harness.events, 'progress')).toHaveLength(5);
    expect(eventsNamed(harness.events, 'output')).toHaveLength(3);
    const diagnostics = harness.broker.snapshot('fake')!.diagnostics;
    expect(diagnostics.some(item => item.code === 'artifact_path_forbidden')).toBe(true);
    await harness.broker.stopAll('done');
  });

  it('times out slow requests with sidecar_timeout', async () => {
    const harness = await createHarness();
    await harness.broker.startDeclared(harness.entry);
    const error = errorOf(await harness.broker.request('fake', 'slow', {}, { timeoutMs: 50 }).catch(value => value));
    expect(error.code).toBe('sidecar_timeout');
    const diagnostics = harness.broker.snapshot('fake')!.diagnostics;
    expect(diagnostics.some(item => item.code === 'request_timeout')).toBe(true);
    expect(harness.broker.auditLog().events.some(event => event.kind === 'limit')).toBe(true);
    await harness.broker.stopAll('done');
  });

  it('cancels in-flight requests via $/cancelRequest', async () => {
    const harness = await createHarness();
    const pending = harness.broker.request('fake', 'slow', {}, { timeoutMs: 8_000 }).catch(value => value);
    await waitFor(() => eventsNamed(harness.events, 'request').some(event => event.payload.method === 'slow'), 'request event');
    const requestId = eventsNamed(harness.events, 'request').find(event => event.payload.method === 'slow')!.payload.requestId;
    expect(harness.broker.cancel(requestId as number, 'test cancel')).toBe(true);
    const error = errorOf(await pending);
    expect(error.code).toBe('execution_cancelled');
    expect(harness.broker.auditLog().events.some(event => event.kind === 'cancel')).toBe(true);
    await harness.broker.stopAll('done');
  });

  it('de-dupes duplicate output sequence numbers and reports gaps', async () => {
    const harness = await createHarness();
    const outcome = await harness.broker.request('fake', 'seqs', { seqs: [1, 2, 2, 4], chunks: ['a', 'b', 'c', 'd'] }, { timeoutMs: 3_000 });
    expect(outcome.stdout).toBe('abd');
    const diagnostics = harness.broker.snapshot('fake')!.diagnostics;
    expect(diagnostics.some(item => item.code === 'seq_gap')).toBe(true);
    await harness.broker.stopAll('done');
  });

  it('caps per-request output, truncates and reports backpressure', async () => {
    const harness = await createHarness({
      limits: { maxStdoutBytes: 1_000, maxLineBytes: 1_000_000, maxQueueEntries: 8, maxQueueBytes: 4_096, maxStderrBytes: 1_000 },
    });
    const outcome = await harness.broker.request('fake', 'flood', { count: 400, chunkSize: 10 }, { timeoutMs: 8_000 });
    expect(outcome.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.stdout, 'utf8')).toBeLessThanOrEqual(1_100);
    const diagnostics = harness.broker.snapshot('fake')!.diagnostics;
    expect(diagnostics.some(item => item.code === 'limit_exceeded')).toBe(true);
    const backpressure = eventsNamed(harness.events, 'backpressure').map(event => event.payload.paused);
    expect(backpressure).toContain(true);
    expect(backpressure).toContain(false);
    await harness.broker.stopAll('done');
  });

  it('caps oversized single lines with a truncation marker', async () => {
    const harness = await createHarness({ limits: { maxLineBytes: 64 } });
    const outcome = await harness.broker.request('fake', 'bigline', { size: 1_000 }, { timeoutMs: 3_000 });
    expect(outcome.truncated).toBe(true);
    expect(outcome.stdout).toContain('line truncated');
    expect(Buffer.byteLength(outcome.stdout, 'utf8')).toBeLessThanOrEqual(64 + 32);
    await harness.broker.stopAll('done');
  });

  it('caps log lines', async () => {
    const harness = await createHarness({ limits: { maxLineBytes: 64 } });
    await harness.broker.request('fake', 'log', { size: 500 }, { timeoutMs: 3_000 });
    const logs = eventsNamed(harness.events, 'log');
    expect(logs.length).toBeGreaterThan(0);
    const message = String(logs[logs.length - 1]!.payload.message);
    expect(message).toContain('line truncated');
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(64 + 32);
    await harness.broker.stopAll('done');
  });

  it('validates artifact notification paths against the extension and workspace roots', async () => {
    const harness = await createHarness();
    await harness.broker.request('fake', 'artifact', {}, { timeoutMs: 3_000 });
    const artifacts = eventsNamed(harness.events, 'artifact');
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0]!.payload.artifact as { path: string; relativePath?: string };
    expect(path.isAbsolute(artifact.path)).toBe(true);
    expect(artifact.relativePath).toBe('out.txt');
    const diagnostics = harness.broker.snapshot('fake')!.diagnostics;
    expect(diagnostics.some(item => item.code === 'artifact_path_forbidden')).toBe(true);
    await harness.broker.stopAll('done');
  });

  it('restarts after a crash with backoff', async () => {
    const harness = await createHarness({ limits: { maxCrashes: 2, crashBackoffMs: [20, 20, 20] } });
    const first = await harness.broker.startDeclared(harness.entry);
    const error = errorOf(await harness.broker.request('fake', 'crash', {}, { timeoutMs: 3_000 }).catch(value => value));
    expect(error.code).toBe('sidecar_crash');
    await waitFor(() => harness.broker.snapshot('fake')?.state === 'ready', 'restart to ready');
    const restarted = harness.broker.snapshot('fake')!;
    expect(restarted.pid).not.toBe(first.pid);
    expect(restarted.crashes).toBe(1);
    const outcome = await harness.broker.request('fake', 'echo', { after: 'restart' }, { timeoutMs: 3_000 });
    expect(outcome.result).toEqual({ after: 'restart' });
    await harness.broker.stopAll('done');
  });

  it('gives up after maxCrashes and fails the instance', async () => {
    const harness = await createHarness({ limits: { maxCrashes: 0, crashBackoffMs: [10] } });
    await harness.broker.startDeclared(harness.entry);
    errorOf(await harness.broker.request('fake', 'crash', {}, { timeoutMs: 3_000 }).catch(value => value));
    await waitFor(() => harness.broker.snapshot('fake')?.state === 'failed', 'failed state');
    const error = errorOf(await harness.broker.request('fake', 'echo', {}, { timeoutMs: 1_000 }).catch(value => value));
    expect(error.code).toBe('sidecar_crash');
    expect(harness.broker.auditLog().events.some(event => event.kind === 'crash')).toBe(true);
    await harness.broker.stopAll('done');
  });

  it('stops gracefully via the JSON-RPC shutdown request', async () => {
    const harness = await createHarness();
    const snapshot = await harness.broker.startDeclared(harness.entry);
    const pid = snapshot.pid!;
    await harness.broker.stop('fake', 'test stop');
    expect(harness.broker.snapshot('fake')).toBeNull();
    await waitFor(() => !isProcessAlive(pid), 'process to exit');
    const kinds = harness.broker.auditLog().events.map(event => event.kind);
    expect(kinds).toContain('stop');
    expect(kinds).toContain('exit');
  });

  it('escalates to a tree kill when shutdown is ignored', async () => {
    const harness = await createHarness({ mode: 'stubborn', limits: { shutdownGraceMs: 60, killGraceMs: 2_000 } });
    const snapshot = await harness.broker.startDeclared(harness.entry);
    const pid = snapshot.pid!;
    await harness.broker.stop('fake', 'stubborn stop');
    await waitFor(() => !isProcessAlive(pid), 'stubborn process to be killed');
    expect(harness.broker.auditLog().events.some(event => event.kind === 'signal')).toBe(true);
  });

  it('reports initialize timeouts as typed startup failures', async () => {
    const harness = await createHarness({ mode: 'no-init', limits: { initializeTimeoutMs: 80 } });
    const error = errorOf(await harness.broker.startDeclared(harness.entry).catch(value => value));
    expect(error.code).toBe('sidecar_timeout');
    const snapshot = harness.broker.snapshot('fake');
    expect(snapshot?.state).toBe('failed');
    expect(snapshot?.diagnostics.some(item => item.code === 'sidecar_timeout')).toBe(true);
  });

  it('reports spawn failures', async () => {
    const harness = await createHarness();
    const missing: HcSidecarCatalogEntry = {
      ...harness.entry,
      declaration: { ...harness.declaration, id: 'missing', command: ['definitely-not-a-real-binary-xyz'] },
    };
    const error = errorOf(await harness.broker.startDeclared(missing).catch(value => value));
    expect(error.code).toBe('sidecar_spawn_failed');
    expect(harness.broker.snapshot('missing')?.state).toBe('failed');
  });

  it('rejects methods that are not declared by the manifest', async () => {
    const harness = await createHarness();
    await harness.broker.startDeclared(harness.entry);
    const error = errorOf(await harness.broker.request('fake', 'not-declared', {}, { timeoutMs: 1_000 }).catch(value => value));
    expect(error.code).toBe('capability_denied');
    expect(harness.broker.auditLog().events.some(event => event.kind === 'denied')).toBe(true);
    await harness.broker.stopAll('done');
  });

  it('rejects cwd escapes', async () => {
    const harness = await createHarness({ declaration: { cwd: '../outside' } });
    const error = errorOf(await harness.broker.startDeclared(harness.entry).catch(value => value));
    expect(error.code).toBe('path_forbidden');
  });

  it('enforces the per-extension process cap', async () => {
    const harness = await createHarness({ limits: { maxProcessesPerExtension: 1 } });
    await harness.broker.startDeclared(harness.entry, { handleId: 'first', dedupe: false });
    const second: HcSidecarCatalogEntry = {
      ...harness.entry,
      declaration: { ...harness.declaration, id: 'fake-second' },
    };
    const error = errorOf(await harness.broker.startDeclared(second, { handleId: 'second', dedupe: false }).catch(value => value));
    expect(error.code).toBe('limit_exceeded');
    await harness.broker.stopAll('done');
  });

  it('stops idle instances', async () => {
    const harness = await createHarness({ limits: { idleTimeoutMs: 80 } });
    await harness.broker.startDeclared(harness.entry);
    await waitFor(() => harness.broker.snapshot('fake') === null, 'idle stop', 5_000);
    expect(harness.broker.auditLog().events.some(event => event.kind === 'stop' && String(event.detail).includes('idle'))).toBe(true);
  });

  it('auto-starts through the catalog on request', async () => {
    const harness = await createHarness();
    expect(harness.broker.list()).toHaveLength(0);
    const outcome = await harness.broker.request('fake', 'echo', { auto: true }, { timeoutMs: 3_000 });
    expect(outcome.result).toEqual({ auto: true });
    expect(harness.broker.list()).toHaveLength(1);
    await harness.broker.stopAll('done');
  });
});
