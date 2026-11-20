import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createRuntimeServices,
  handleHcRuntimeRoute,
  type HcRuntimeServices,
} from '../src/hcanvas/sidecar/routes.js';
import type { HcKernelCatalogEntry, HcSidecarCatalogEntry } from '../src/hcanvas/sidecar/protocol.js';

const SIDECAR_FIXTURE = path.resolve('tests/fixtures/hcanvas-sidecar/fake_sidecar.mjs');
const KERNEL_FIXTURE = path.resolve('tests/fixtures/hcanvas-sidecar/fake_kernel.mjs');

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

interface RouteHarness {
  services: HcRuntimeServices;
  baseUrl: string;
  extensionDir: string;
  workspaceDir: string;
}

async function createHarness(options: { guard?: Parameters<typeof createRuntimeServices>[0]['guard'] } = {}): Promise<RouteHarness> {
  const extensionDir = await mkdtemp(path.join(os.tmpdir(), 'hc-routes-ext-'));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'hc-routes-ws-'));
  roots.push(extensionDir, workspaceDir);
  const sidecarEntry: HcSidecarCatalogEntry = {
    extensionId: 'ext.fake',
    extensionDir,
    declaration: {
      id: 'fake',
      label: 'Fake sidecar',
      command: [process.execPath, SIDECAR_FIXTURE],
      cwd: 'extension',
      requests: ['echo', 'render', 'slow-cancelable', 'shutdown'].map(method => ({ method })),
    },
  };
  const kernelEntry: HcKernelCatalogEntry = {
    kernel: { id: 'fake', label: 'Fake Kernel', language: 'fake' },
    sidecar: {
      extensionId: 'ext.fake',
      extensionDir,
      declaration: {
        id: 'fake-kernel',
        command: [process.execPath, KERNEL_FIXTURE],
        cwd: 'extension',
        role: 'kernel',
        requests: [{ method: 'kernel/execute' }, { method: 'kernel/interrupt' }, { method: 'kernel/shutdown' }, { method: 'kernel/complete' }, { method: 'kernel/inspect' }],
      },
    },
  };
  const services = createRuntimeServices({
    workspaceDir,
    sidecarCatalog: { resolveSidecar: sidecarId => (sidecarId === 'fake' ? sidecarEntry : null) },
    kernelCatalog: { resolveKernel: kernelId => (kernelId === 'fake' ? kernelEntry : null) },
    ptyLoader: async () => null,
    enforceLimitCaps: false,
    sidecarLimits: { idleTimeoutMs: 0 },
    kernelLimits: { interruptGraceMs: 100, sigintGraceMs: 150, restartDelayMs: 20 },
    ...(options.guard ? { guard: options.guard } : {}),
  });
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = decodeURIComponent(url.pathname);
      const handled = await handleHcRuntimeRoute(services, { req, res, url, pathname, method: req.method ?? 'GET' });
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: 'not_found' }));
      }
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: String(error) }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  closers.push(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await services.close();
  });
  return { services, baseUrl: 'http://127.0.0.1:' + port, extensionDir, workspaceDir };
}

async function api<T>(harness: RouteHarness, route: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(harness.baseUrl + route, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

describe('hcanvas runtime routes', () => {
  it('serves the runtime snapshot and 404s unowned paths', async () => {
    const harness = await createHarness();
    const snapshot = await api<{ ok: boolean; sidecars: unknown[]; kernels: unknown[]; terminal: { available: boolean; probed: boolean } }>(harness, '/api/runtime');
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.ok).toBe(true);
    expect(snapshot.body.sidecars).toEqual([]);
    expect(snapshot.body.kernels).toEqual([]);
    expect(snapshot.body.terminal.available).toBe(false);
    expect(snapshot.body.terminal.probed).toBe(true);
    const missing = await api<{ code: string }>(harness, '/api/whatever');
    expect(missing.status).toBe(404);
  });

  it('drives a sidecar start/request/stop over HTTP', async () => {
    const harness = await createHarness();
    const started = await api<{ ok: boolean; sidecar: { state: string; pid: number } }>(harness, '/api/sidecars/fake/start', { method: 'POST' });
    expect(started.status).toBe(200);
    expect(started.body.sidecar.state).toBe('ready');
    const requested = await api<{ ok: boolean; result: unknown; stdout: string; truncated: boolean }>(harness, '/api/sidecars/fake/request', {
      method: 'POST',
      body: JSON.stringify({ method: 'echo', params: { n: 1 } }),
    });
    expect(requested.status).toBe(200);
    expect(requested.body.result).toEqual({ n: 1 });
    expect(requested.body.truncated).toBe(false);
    const listed = await api<{ sidecars: Array<{ sidecarId: string }> }>(harness, '/api/sidecars');
    expect(listed.body.sidecars.map(item => item.sidecarId)).toContain('fake');
    const stopped = await api<{ ok: boolean }>(harness, '/api/sidecars/fake/stop', { method: 'POST' });
    expect(stopped.status).toBe(200);
    expect(harness.services.broker.snapshot('fake')).toBeNull();
  });

  it('enforces extension ownership and cancels a running sidecar request', async () => {
    const harness = await createHarness();
    const denied = await api<{ code: string }>(harness, '/api/sidecars/fake/start', { method: 'POST', body: JSON.stringify({ extensionId: 'ext.other' }) });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('capability_denied');
    const started = await api<{ ok: boolean }>(harness, '/api/sidecars/fake/start', { method: 'POST', body: JSON.stringify({ extensionId: 'ext.fake' }) });
    expect(started.status).toBe(200);
    const pending = api<{ code?: string }>(harness, '/api/sidecars/fake/request', {
      method: 'POST', body: JSON.stringify({ extensionId: 'ext.fake', clientRequestId: 'sc_route_cancel_1', method: 'slow-cancelable' }),
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    const wrongCancel = await api<{ code: string }>(harness, '/api/runtime/cancel', {
      method: 'POST', body: JSON.stringify({ requestId: 'sc_route_cancel_1', sidecarId: 'fake', extensionId: 'ext.other' }),
    });
    expect(wrongCancel.status).toBe(403);
    const cancelled = await api<{ cancelled: boolean }>(harness, '/api/runtime/cancel', {
      method: 'POST', body: JSON.stringify({ requestId: 'sc_route_cancel_1', sidecarId: 'fake', extensionId: 'ext.fake' }),
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.cancelled).toBe(true);
    const result = await pending;
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('execution_cancelled');
  });

  it('maps sidecar errors onto SPEC-14 codes', async () => {
    const harness = await createHarness();
    const unknown = await api<{ code: string }>(harness, '/api/sidecars/missing/start', { method: 'POST' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('sidecar_not_found');
  });

  it('ensures kernels, executes, interrupts, restarts and disposes', async () => {
    const harness = await createHarness();
    const ensured = await api<{ ok: boolean; session: { sessionId: string; state: string; pid: number } }>(harness, '/api/kernels/ensure', {
      method: 'POST',
      body: JSON.stringify({ kernelId: 'fake', scope: { kind: 'document', key: 'doc_http' } }),
    });
    expect(ensured.status).toBe(200);
    const sessionId = ensured.body.session.sessionId;
    expect(ensured.body.session.state).toBe('ready');
    const completion = await api<{ result: { matches: string[]; cursorEnd: number } }>(harness, '/api/kernels/' + sessionId + '/complete', {
      method: 'POST', body: JSON.stringify({ code: 'pri', cursorPos: 3 }),
    });
    expect(completion.status).toBe(200);
    expect(completion.body.result.matches).toContain('print');
    expect(completion.body.result.cursorEnd).toBe(3);
    const inspection = await api<{ result: { name: string; documentation: string } }>(harness, '/api/kernels/' + sessionId + '/inspect', {
      method: 'POST', body: JSON.stringify({ code: 'print', cursorPos: 5 }),
    });
    expect(inspection.status).toBe(200);
    expect(inspection.body.result.name).toBe('print');
    expect(inspection.body.result.documentation).toContain('Print');
    const executed = await api<{ ok: boolean; execution: { executionId: string; status: string; outputs: { events: unknown[] } } }>(harness, '/api/kernels/' + sessionId + '/execute', {
      method: 'POST',
      body: JSON.stringify({ code: 'print("hi")', wait: true }),
    });
    expect(executed.status).toBe(200);
    expect(executed.body.execution.status).toBe('ok');
    expect(executed.body.execution.outputs.events.length).toBeGreaterThan(0);
    const completed = await api<{ state: string; result: { status: string; outputs: { events: unknown[] } } }>(harness, '/api/kernels/executions/' + executed.body.execution.executionId);
    expect(completed.status).toBe(200);
    expect(completed.body.state).toBe('completed');
    expect(completed.body.result.status).toBe('ok');
    expect(completed.body.result.outputs.events.length).toBeGreaterThan(0);
    const unknownExecution = await api<{ state: string }>(harness, '/api/kernels/executions/exec_missing');
    expect(unknownExecution.body.state).toBe('unknown');
    const queued = await api<{ ok: boolean; executionId: string; queuePosition: number }>(harness, '/api/kernels/' + sessionId + '/execute', {
      method: 'POST',
      body: JSON.stringify({ code: 'print("async")' }),
    });
    expect(queued.status).toBe(202);
    expect(queued.body.executionId.startsWith('exec_')).toBe(true);
    const noInterrupt = await api<{ interrupted: boolean }>(harness, '/api/kernels/' + sessionId + '/interrupt', {
      method: 'POST',
      body: JSON.stringify({ executionId: queued.body.executionId }),
    });
    expect(noInterrupt.status).toBe(200);
    const restarted = await api<{ session: { state: string; pid: number } }>(harness, '/api/kernels/' + sessionId + '/restart', { method: 'POST' });
    expect(restarted.status).toBe(200);
    expect(restarted.body.session.state).toBe('ready');
    expect(restarted.body.session.pid).not.toBe(ensured.body.session.pid);
    const disposed = await api<{ ok: boolean }>(harness, '/api/kernels/' + sessionId, { method: 'DELETE' });
    expect(disposed.status).toBe(200);
    expect(harness.services.kernels.has(sessionId)).toBe(false);
  });

  it('streams runtime events with an after cursor', async () => {
    const harness = await createHarness();
    const controller = new AbortController();
    const response = await fetch(harness.baseUrl + '/api/runtime/events?after=0', { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!text.includes(needle)) {
        if (Date.now() > deadline) throw new Error('SSE timeout waiting for ' + needle + ': ' + text);
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
    };
    await readUntil('event: hello');
    expect(text).toContain('"seq":0');
    await api(harness, '/api/sidecars/fake/start', { method: 'POST' });
    await readUntil('event: runtime');
    expect(text).toContain('"kind":"sidecar"');
    expect(text).toMatch(/id: \d+/u);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });

  it('rejects sidecar cancellation of an unknown request', async () => {
    const harness = await createHarness();
    const cancelled = await api<{ ok: boolean; cancelled: boolean }>(harness, '/api/runtime/cancel', {
      method: 'POST',
      body: JSON.stringify({ requestId: 999 }),
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.cancelled).toBe(false);
    const invalid = await api<{ code: string }>(harness, '/api/runtime/cancel', { method: 'POST', body: JSON.stringify({}) });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('invalid_params');
  });

  it('degrades terminal routes when node-pty is unavailable', async () => {
    const harness = await createHarness();
    const sessions = await api<{ available: boolean; sessions: unknown[] }>(harness, '/api/terminal/sessions');
    expect(sessions.status).toBe(200);
    expect(sessions.body.available).toBe(false);
    const create = await api<{ code: string }>(harness, '/api/terminal/sessions', {
      method: 'POST',
      body: JSON.stringify({ command: ['x'], cols: 80, rows: 24 }),
    });
    expect(create.status).toBe(501);
    expect(create.body.code).toBe('not_supported');
  });

  it('enforces the injected trust guard', async () => {
    const harness = await createHarness({
      guard: action => (action === 'sidecar'
        ? { ok: false, code: 'trusted_required', message: 'Workspace is not trusted' }
        : { ok: true }),
    });
    const denied = await api<{ code: string }>(harness, '/api/sidecars/fake/start', { method: 'POST' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('trusted_required');
  });

  it('serves kernel output assets through the injected port', async () => {
    const harness = await createHarness();
    const noPort = await api<{ code: string }>(harness, '/api/kernel-outputs', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'ks_x', executionId: 'exec_x', mime: 'text/plain', text: 'hi' }),
    });
    expect(noPort.status).toBe(501);
    expect(noPort.body.code).toBe('not_supported');
    expect(harness.services.kernelOutputs).toBeUndefined();
  });
});
