import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SidecarBroker } from '../src/hcanvas/sidecar/broker.js';
import { HcKernelManager, kernelSessionKey } from '../src/hcanvas/sidecar/kernelSession.js';
import {
  HcRuntimeError,
  type HcKernelCatalogEntry,
  type HcKernelExecutionResult,
  type HcKernelOutputItem,
  type HcKernelRuntimeEvent,
  type HcSidecarRuntimeEvent,
} from '../src/hcanvas/sidecar/protocol.js';
import type { HcKernelLimits } from '../src/hcanvas/sidecar/limits.js';
import { isProcessAlive } from '../src/hcanvas/sidecar/spawn.js';

const KERNEL_FIXTURE = path.resolve('tests/fixtures/hcanvas-sidecar/fake_kernel.mjs');
const roots: string[] = [];
const brokers: SidecarBroker[] = [];
const managers: HcKernelManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.disposeAll().catch(() => undefined)));
  await Promise.all(brokers.splice(0).map(broker => broker.stopAll('test cleanup').catch(() => undefined)));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

interface KernelHarness {
  manager: HcKernelManager;
  broker: SidecarBroker;
  events: HcKernelRuntimeEvent[];
  sidecarEvents: HcSidecarRuntimeEvent[];
  kernelEntry: HcKernelCatalogEntry;
  workspaceDir: string;
}

async function createHarness(options: { limits?: Partial<HcKernelLimits> } = {}): Promise<KernelHarness> {
  const extensionDir = await mkdtemp(path.join(os.tmpdir(), 'hc-kernel-ext-'));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'hc-kernel-ws-'));
  roots.push(extensionDir, workspaceDir);
  const kernelEntry: HcKernelCatalogEntry = {
    kernel: { id: 'fake', label: 'Fake Kernel', language: 'fake', features: ['execute', 'interrupt'] },
    sidecar: {
      extensionId: 'ext.fake',
      extensionDir,
      declaration: {
        id: 'fake-kernel',
        command: [process.execPath, KERNEL_FIXTURE],
        cwd: 'extension',
        role: 'kernel',
        requests: [
          { method: 'kernel/execute' },
          { method: 'kernel/interrupt' },
          { method: 'kernel/shutdown' },
        ],
      },
    },
  };
  const events: HcKernelRuntimeEvent[] = [];
  const sidecarEvents: HcSidecarRuntimeEvent[] = [];
  const broker = new SidecarBroker({
    workspaceDir,
    enforceLimitCaps: false,
    limits: { idleTimeoutMs: 0 },
    onEvent: event => sidecarEvents.push(event),
    spawnImpl: (file, args, spawnOptions) => spawn(file, args, spawnOptions),
  });
  brokers.push(broker);
  const manager = new HcKernelManager({
    broker,
    catalog: { resolveKernel: async kernelId => (kernelId === 'fake' ? kernelEntry : null) },
    workspaceDir,
    enforceLimitCaps: false,
    limits: {
      executionTimeoutMs: 0,
      interruptGraceMs: 100,
      sigintGraceMs: 150,
      restartDelayMs: 20,
      maxCrashRestarts: 1,
      shutdownGraceMs: 500,
      ...(options.limits ?? {}),
    },
    onEvent: event => events.push(event),
  });
  managers.push(manager);
  return { manager, broker, events, sidecarEvents, kernelEntry, workspaceDir };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function eventsFor(events: HcKernelRuntimeEvent[], executionId: string): HcKernelRuntimeEvent[] {
  return events.filter(event => event.executionId === executionId);
}

function eventNames(events: HcKernelRuntimeEvent[]): string[] {
  return events.map(event => event.event);
}

function errorOf(value: unknown): HcRuntimeError {
  expect(value).toBeInstanceOf(HcRuntimeError);
  return value as HcRuntimeError;
}

describe('HKP kernel manager', () => {
  it('ensures kernel sessions per scope and reuses them', async () => {
    const harness = await createHarness();
    const scope = { kind: 'document' as const, key: 'doc_1' };
    const first = await harness.manager.ensure('fake', scope);
    expect(first.sessionId).toBe(kernelSessionKey(harness.workspaceDir, 'fake', scope));
    expect(first.sessionId.startsWith('ks_')).toBe(true);
    expect(first.state).toBe('ready');
    expect(first.language).toBe('fake');
    expect(first.languageVersion).toBe('1.0.0');
    expect(first.displayName).toBe('Fake Kernel');
    expect(first.mimeTypes).toContain('image/png');
    expect(first.features?.execute).toBe(true);
    expect(typeof first.pid).toBe('number');
    const again = await harness.manager.ensure('fake', scope);
    expect(again.sessionId).toBe(first.sessionId);
    expect(again.pid).toBe(first.pid);
    const other = await harness.manager.ensure('fake', { kind: 'file', key: 'notes/demo.hnb.md' });
    expect(other.sessionId).not.toBe(first.sessionId);
    expect(other.pid).not.toBe(first.pid);
    expect(harness.manager.list()).toHaveLength(2);
  });

  it('streams execution output in protocol order', async () => {
    const harness = await createHarness();
    const session = await harness.manager.ensure('fake', { kind: 'document', key: 'doc_order' });
    const result = await harness.manager.execute(session.sessionId, 'print("hello")');
    expect(result.status).toBe('ok');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const streamText = result.outputs.events
      .filter((item): item is { type: 'stream'; name: 'stdout' | 'stderr'; text: string } => item.type === 'stream')
      .map(item => item.text)
      .join('');
    expect(streamText).toBe('hello\n');
    expect(result.outputs.events.some(item => item.type === 'display_data')).toBe(true);
    expect(result.outputs.events.some(item => item.type === 'execute_result')).toBe(true);
    const names = eventNames(eventsFor(harness.events, result.executionId)).filter(
      name => name !== 'state' && name !== 'kernel_status' && name !== 'log' && name !== 'diagnostic',
    );
    expect(names).toEqual([
      'execution_queued',
      'execution_started',
      'stream',
      'stream',
      'display_data',
      'execute_result',
      'execution_finished',
    ]);
    const finished = eventsFor(harness.events, result.executionId).at(-1)!;
    expect(finished.payload.status).toBe('ok');
  });

  it('serializes executions per session with queue positions', async () => {
    const harness = await createHarness();
    const session = await harness.manager.ensure('fake', { kind: 'document', key: 'doc_queue' });
    const first = harness.manager.startExecution(session.sessionId, 'slow:1');
    const second = harness.manager.startExecution(session.sessionId, 'print("second")');
    expect(first.queuePosition).toBe(1);
    expect(second.queuePosition).toBe(2);
    const firstResult = await first.completion;
    const secondResult = await second.completion;
    expect(firstResult.status).toBe('ok');
    expect(secondResult.status).toBe('ok');
    const firstFinished = eventsFor(harness.events, firstResult.executionId).find(event => event.event === 'execution_finished')!;
    const secondStarted = eventsFor(harness.events, secondResult.executionId).find(event => event.event === 'execution_started')!;
    expect(harness.events.indexOf(secondStarted)).toBeGreaterThan(harness.events.indexOf(firstFinished));
    const snapshot = harness.manager.snapshot(session.sessionId);
    expect(snapshot.queued).toBe(0);
    expect(snapshot.activeExecutionId).toBeUndefined();
  });

  it('reports kernel errors with structured tracebacks', async () => {
    const harness = await createHarness();
    const session = await harness.manager.ensure('fake', { kind: 'document', key: 'doc_error' });
    const result = await harness.manager.execute(session.sessionId, 'raise ValueError("boom")');
    expect(result.status).toBe('error');
    expect(result.error?.ename).toBe('ValueError');
    expect(result.error?.traceback.length).toBeGreaterThan(0);
    expect(result.outputs.events.some(item => item.type === 'error')).toBe(true);
    const errorEvent = eventsFor(harness.events, result.executionId).find(event => event.event === 'error');
    expect(errorEvent?.payload.ename).toBe('ValueError');
  });

  it('interrupts a cooperative execution', async () => {
    const harness = await createHarness();
    const session = await harness.manager.ensure('fake', { kind: 'document', key: 'doc_interrupt' });
    const started = harness.manager.startExecution(session.sessionId, 'slow:coop');
    await waitFor(() => eventsFor(harness.events, started.executionId).some(event => event.event === 'execution_started'), 'execution_started');
    const accepted = await harness.manager.interrupt(session.sessionId, started.executionId);
    expect(accepted).toBe(true);
    const result = await started.completion;
    expect(result.status).toBe('aborted');
    expect(result.durationMs).toBeLessThan(2_000);
    const names = eventNames(eventsFor(harness.events, result.executionId));
    expect(names).toContain('diagnostic');
    expect(names.at(-1)).toBe('execution_finished');
  });

  it('escalates to kill+restart when a kernel ignores interrupt', async () => {
    const harness = await createHarness();
    const session = await harness.manager.ensure('fake', { kind: 'document', key: 'doc_hang' });
    const firstPid = session.pid;
    const started = harness.manager.startExecution(session.sessionId, 'hang forever');
    await waitFor(() => eventsFor(harness.events, started.executionId).some(event => event.event === 'execution_started'), 'hang execution_started');
    const queued = harness.manager.startExecution(session.sessionId, 'print("queued after restart")');
    expect(await harness.manager.interrupt(session.sessionId)).toBe(true);
    const result = await started.completion;
    expect(result.status).toBe('aborted');
    await waitFor(() => {
      const current = harness.manager.snapshot(session.sessionId);
      return current.state === 'ready' && current.pid !== null && current.pid !== firstPid;
    }, 'kernel to restart with a new pid');
    const diagnostics = eventsFor(harness.events, result.executionId)
      .filter(event => event.event === 'diagnostic')
      .map(event => String(event.payload.code));
    expect(diagnostics).toContain('interrupt_kill');
    const after = harness.manager.snapshot(session.sessionId);
    expect(after.sessionId).toBe(session.sessionId);
    const outcome = await queued.completion;
    expect(outcome.status).toBe('ok');
    expect(JSON.stringify(outcome.outputs.events)).toContain('hello');
    const next = await harness.manager.execute(session.sessionId, 'print("after restart")');
    expect(next.status).toBe('ok');
  }, 15_000);

  it('manual restart keeps the session id and replaces the process', async () => {
    const harness = await createHarness();
    const session = await harness.manager.ensure('fake', { kind: 'document', key: 'doc_restart' });
    const firstPid = session.pid;
    const restarted = await harness.manager.restart(session.sessionId);
    expect(restarted.sessionId).toBe(session.sessionId);
    expect(restarted.state).toBe('ready');
    expect(restarted.pid).not.toBe(firstPid);
    const result = await harness.manager.execute(session.sessionId, 'print("after manual restart")');
    expect(result.status).toBe('ok');
  });

  it('auto-restarts once after a crash then goes dead', async () => {
    const harness = await createHarness();
    const session = await harness.manager.ensure('fake', { kind: 'document', key: 'doc_crash' });
    const firstPid = session.pid;
    const crashed = await harness.manager.execute(session.sessionId, 'crash now');
    expect(crashed.status).toBe('aborted');
    expect(crashed.error?.ename).toBe('KernelCrash');
    await waitFor(() => {
      const current = harness.manager.snapshot(session.sessionId);
      return current.state === 'ready' && current.pid !== null && current.pid !== firstPid;
    }, 'kernel auto restart');
    expect(harness.manager.snapshot(session.sessionId).crashes).toBe(1);
    const afterRestart = await harness.manager.execute(session.sessionId, 'print("alive")');
    expect(afterRestart.status).toBe('ok');
    const secondPid = harness.manager.snapshot(session.sessionId).pid;
    const crashedAgain = await harness.manager.execute(session.sessionId, 'crash again');
    expect(crashedAgain.status).toBe('aborted');
    await waitFor(() => harness.manager.snapshot(session.sessionId).state === 'dead', 'kernel dead after second crash');
    expect(harness.manager.snapshot(session.sessionId).pid).toBeNull();
    expect(secondPid).not.toBeNull();
    const error = errorOf((() => {
      try {
        harness.manager.startExecution(session.sessionId, 'print(1)');
        return null;
      } catch (caught) {
        return caught;
      }
    })());
    expect(error.code).toBe('kernel_crash');
  }, 15_000);

  it('caps execution output bytes, stream chunks and MIME values', async () => {
    const harness = await createHarness({
      limits: {
        maxOutputBytes: 500,
        maxStreamChunkBytes: 32,
        maxMimeValueBytes: 128,
        maxHtmlBytes: 64,
        maxJsonBytes: 64,
        maxDisplays: 2,
      },
    });
    const session = await harness.manager.ensure('fake', { kind: 'document', key: 'doc_caps' });
    const result = await harness.manager.execute(session.sessionId, 'big:2000');
    expect(result.status).toBe('ok');
    expect(result.outputs.truncated).toBe(true);
    expect(result.outputs.totalBytes).toBeLessThanOrEqual(500);
    for (const item of result.outputs.events) {
      if (item.type === 'stream') expect(Buffer.byteLength(item.text, 'utf8')).toBeLessThanOrEqual(32);
    }
    const diagnostics = eventsFor(harness.events, result.executionId)
      .filter(event => event.event === 'diagnostic')
      .map(event => String(event.payload.code));
    expect(diagnostics).toContain('limit_exceeded');
    const display = await harness.manager.execute(session.sessionId, 'bigdisplay:400');
    expect(display.outputs.truncated).toBe(true);
    const htmlItem = display.outputs.events.find(
      (item): item is Extract<HcKernelOutputItem, { type: 'display_data' }> => item.type === 'display_data',
    );
    expect(htmlItem).toBeTruthy();
    const html = String(htmlItem!.data['text/html']);
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThanOrEqual(64 + 32);
    expect(html).toContain('truncated');
  }, 15_000);

  it('cancels queued executions without disturbing the running one', async () => {
    const harness = await createHarness();
    const session = await harness.manager.ensure('fake', { kind: 'document', key: 'doc_cancel' });
    const first = harness.manager.startExecution(session.sessionId, 'slow:queued');
    const second = harness.manager.startExecution(session.sessionId, 'print("cancelled")');
    await waitFor(() => eventsFor(harness.events, first.executionId).some(event => event.event === 'execution_started'), 'first start');
    expect(harness.manager.cancel(session.sessionId, second.executionId)).toBe(true);
    const cancelled = await second.completion;
    expect(cancelled.status).toBe('cancelled');
    expect(harness.manager.cancelByExecutionId(first.executionId)).toBe(true);
    const firstResult = await first.completion;
    expect(['aborted', 'ok']).toContain(firstResult.status);
    await waitFor(() => harness.manager.snapshot(session.sessionId).state !== 'busy', 'session idle');
  }, 15_000);

  it('forwards shared variables through the HKP execute parameters', async () => {
    const harness = await createHarness();
    const session = await harness.manager.ensure('fake', { kind: 'page', key: 'page_variables' });
    const result = await harness.manager.execute(session.sessionId, 'shared-variables', { variables: { distance: 120.5, scenic: true } });
    const display = result.outputs.events.find((item): item is Extract<HcKernelOutputItem, { type: 'display_data' }> => item.type === 'display_data');
    expect(display?.data['application/vnd.hcanvas.variables+json']).toEqual({ distance: 120.5, scenic: true });
  });

  it('disposes sessions and kills their processes', async () => {
    const harness = await createHarness();
    const session = await harness.manager.ensure('fake', { kind: 'document', key: 'doc_dispose' });
    const pid = session.pid!;
    expect(isProcessAlive(pid)).toBe(true);
    await harness.manager.dispose(session.sessionId);
    expect(harness.manager.has(session.sessionId)).toBe(false);
    expect(harness.broker.snapshot(session.sessionId)).toBeNull();
    await waitFor(() => !isProcessAlive(pid), 'kernel process to exit');
  });

  it('rejects unknown kernels', async () => {
    const harness = await createHarness();
    const error = errorOf(await harness.manager.ensure('missing-kernel', { kind: 'custom', key: 'x' }).catch(value => value));
    expect(error.code).toBe('kernel_not_found');
  });
});
