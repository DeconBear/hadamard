// Hcanvas runtime HTTP routes (SPEC-10): runtime snapshot + SSE, sidecar
// start/stop/request, runtime cancel, kernel ensure/execute/interrupt/restart/
// delete, kernel output assets, and terminal sessions.
//
// Handlers are injected-in (broker/pty/kernel manager/event hub) and return true
// when they owned the request; the caller (server.ts) wires them into its route
// chain. This module never imports server.ts and brings its own json/readBody
// helpers so it stays independently testable.
import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  HcRuntimeError,
  HC_RUNTIME_ERROR_STATUS,
  type HcKernelCatalogPort,
  type HcKernelRuntimeEvent,
  type HcKernelScope,
  type HcRuntimeErrorCode,
  type HcSidecarCatalogPort,
  type HcSidecarClientInfo,
  type HcSidecarRuntimeEvent,
  type HcTerminalRuntimeEvent,
  type SidecarRequestOptions,
} from './protocol.js';
import { RingBuffer, resolveKernelLimits, type HcKernelLimits, type HcPtyLimits, type HcSidecarLimits } from './limits.js';
import { SidecarBroker, type SidecarBrokerOptions } from './broker.js';
import { HcKernelManager } from './kernelSession.js';
import { HcPtyManager, type HcPtyLoader } from './pty.js';
import type { SidecarSpawnImpl } from './spawn.js';

const MAX_BODY = 8 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 25_000;
const DEFAULT_EVENT_BUFFER = 1_000;

// ---------------------------------------------------------------------------
// Runtime event hub (SSE with `after` cursor replay, SPEC-10)
// ---------------------------------------------------------------------------

export type HcRuntimeEventInput = HcSidecarRuntimeEvent | HcKernelRuntimeEvent | HcTerminalRuntimeEvent;
export type HcRuntimeEventRecord = HcRuntimeEventInput & { seq: number };

export interface HcRuntimeEventHubOptions {
  maxEvents?: number;
}

/** Sequenced, bounded, replayable event stream backing `/api/runtime/events`. */
export class HcRuntimeEventHub {
  private readonly buffer: RingBuffer<HcRuntimeEventRecord>;
  private readonly listeners = new Set<(event: HcRuntimeEventRecord) => void>();
  private nextSeq = 1;

  constructor(options: HcRuntimeEventHubOptions = {}) {
    this.buffer = new RingBuffer<HcRuntimeEventRecord>(options.maxEvents ?? DEFAULT_EVENT_BUFFER);
  }

  /** Latest assigned sequence number (0 before any event). */
  get seq(): number {
    return this.nextSeq - 1;
  }

  get buffered(): number {
    return this.buffer.size;
  }

  get dropped(): number {
    return this.buffer.dropped;
  }

  publish(event: HcRuntimeEventInput): HcRuntimeEventRecord {
    const record = { ...event, seq: this.nextSeq } as HcRuntimeEventRecord;
    this.nextSeq += 1;
    this.buffer.push(record);
    for (const listener of [...this.listeners]) {
      try {
        listener(record);
      } catch {
        /* a slow consumer must not break publishing */
      }
    }
    return record;
  }

  /** Events with `seq > cursor`, oldest first (reconnect replay). */
  after(cursor: number): HcRuntimeEventRecord[] {
    const from = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
    return this.buffer.toArray().filter(event => event.seq > from);
  }

  subscribe(listener: (event: HcRuntimeEventRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

// ---------------------------------------------------------------------------
// Services + factory
// ---------------------------------------------------------------------------

export type HcRuntimeAction = 'sidecar' | 'kernel' | 'terminal';

export type HcRuntimeGuardResult =
  | { ok: true }
  | { ok: false; code?: HcRuntimeErrorCode; message?: string; status?: number };

/** Injected trust/capability gate (Restricted Mode / consent), checked per action. */
export type HcRuntimeGuard = (action: HcRuntimeAction) => HcRuntimeGuardResult | Promise<HcRuntimeGuardResult>;

export interface HcTerminalProfile {
  id: string;
  label?: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  allowedDirs?: string[];
}

/** Manifest `terminals[]` resolver injected by the extension registry. */
export type HcTerminalProfileResolver = (profileId: string) => Promise<HcTerminalProfile | null> | HcTerminalProfile | null;

export interface HcKernelOutputAsset {
  id: string;
  url?: string;
  mime: string;
  size: number;
}

/** Injected asset sink for `POST /api/kernel-outputs` (owned by server assets). */
export interface HcKernelOutputPort {
  save(input: { sessionId: string; executionId: string; mime: string; data: Buffer; name: string }): Promise<HcKernelOutputAsset>;
}

export interface HcRuntimeServices {
  workspaceDir: string;
  events: HcRuntimeEventHub;
  broker: SidecarBroker;
  kernels: HcKernelManager;
  pty: HcPtyManager;
  kernelLimits: HcKernelLimits;
  guard?: HcRuntimeGuard;
  resolveTerminalProfile?: HcTerminalProfileResolver;
  kernelOutputs?: HcKernelOutputPort;
  sidecarCatalog?: HcSidecarCatalogPort;
  /** Stop kernel sessions and sidecar processes owned by an extension. */
  stopExtension(extensionId: string, reason?: string): Promise<{ kernels: number; sidecars: number }>;
  close(): Promise<void>;
}

export interface HcRuntimeSetup {
  workspaceDir: string;
  sidecarCatalog?: HcSidecarCatalogPort;
  kernelCatalog?: HcKernelCatalogPort;
  sidecarLimits?: Partial<HcSidecarLimits>;
  kernelLimits?: Partial<HcKernelLimits>;
  ptyLimits?: Partial<HcPtyLimits>;
  enforceLimitCaps?: boolean;
  clientInfo?: HcSidecarClientInfo;
  version?: string;
  spawnImpl?: SidecarSpawnImpl;
  ptyLoader?: HcPtyLoader;
  ptyAllowedDirs?: string[];
  events?: HcRuntimeEventHub;
  maxEvents?: number;
  guard?: HcRuntimeGuard;
  resolveTerminalProfile?: HcTerminalProfileResolver;
  kernelOutputs?: HcKernelOutputPort;
  now?: () => Date;
}

/**
 * Build the broker / kernel manager / PTY manager / event hub and wire their
 * events into the SSE hub. Call `services.close()` on server shutdown.
 */
export function createRuntimeServices(setup: HcRuntimeSetup): HcRuntimeServices {
  const events = setup.events ?? new HcRuntimeEventHub({ maxEvents: setup.maxEvents });
  const enforceLimitCaps = setup.enforceLimitCaps !== false;
  const brokerOptions: SidecarBrokerOptions = {
    workspaceDir: setup.workspaceDir,
    ...(setup.sidecarCatalog ? { catalog: setup.sidecarCatalog } : {}),
    ...(setup.sidecarLimits ? { limits: setup.sidecarLimits } : {}),
    enforceLimitCaps,
    ...(setup.clientInfo ? { clientInfo: setup.clientInfo } : {}),
    ...(setup.version ? { version: setup.version } : {}),
    ...(setup.spawnImpl ? { spawnImpl: setup.spawnImpl } : {}),
    ...(setup.now ? { now: setup.now } : {}),
    onEvent: event => events.publish(event),
  };
  const broker = new SidecarBroker(brokerOptions);
  const kernels = new HcKernelManager({
    broker,
    ...(setup.kernelCatalog ? { catalog: setup.kernelCatalog } : {}),
    workspaceDir: setup.workspaceDir,
    ...(setup.kernelLimits ? { limits: setup.kernelLimits } : {}),
    enforceLimitCaps,
    ...(setup.now ? { now: setup.now } : {}),
    onEvent: event => events.publish(event),
  });
  const pty = new HcPtyManager({
    workspaceDir: setup.workspaceDir,
    ...(setup.ptyLimits ? { limits: setup.ptyLimits } : {}),
    ...(setup.ptyLoader ? { loadPty: setup.ptyLoader } : {}),
    ...(setup.ptyAllowedDirs ? { allowedDirs: setup.ptyAllowedDirs } : {}),
    enforceLimitCaps,
    ...(setup.now ? { now: setup.now } : {}),
    onEvent: event => events.publish(event),
  });
  const kernelLimits = resolveKernelLimits(setup.kernelLimits, { enforceCaps: enforceLimitCaps });
  const services: HcRuntimeServices = {
    workspaceDir: setup.workspaceDir,
    events,
    broker,
    kernels,
    pty,
    kernelLimits,
    ...(setup.guard ? { guard: setup.guard } : {}),
    ...(setup.resolveTerminalProfile ? { resolveTerminalProfile: setup.resolveTerminalProfile } : {}),
    ...(setup.kernelOutputs ? { kernelOutputs: setup.kernelOutputs } : {}),
    ...(setup.sidecarCatalog ? { sidecarCatalog: setup.sidecarCatalog } : {}),
    async stopExtension(extensionId: string, reason = 'extension removed'): Promise<{ kernels: number; sidecars: number }> {
      const kernelCount = await kernels.disposeForExtension(extensionId).catch(() => 0);
      const sidecars = await broker.stopExtension(extensionId, reason).catch(() => 0);
      return { kernels: kernelCount, sidecars };
    },
    async close(): Promise<void> {
      await kernels.disposeAll().catch(() => undefined);
      await broker.stopAll('server shutdown').catch(() => undefined);
      await pty.closeAll().catch(() => undefined);
    },
  };
  return services;
}

// ---------------------------------------------------------------------------
// Route context + tiny response helpers (server.ts owns its own copies)
// ---------------------------------------------------------------------------

export interface HcRuntimeRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  pathname: string;
  method: string;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new HcRuntimeError('limit_exceeded', 'Request body too large');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HcRuntimeError('invalid_params', 'Invalid JSON body');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HcRuntimeError('invalid_params', 'Body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function writeRouteError(res: ServerResponse, error: unknown): void {
  if (res.writableEnded) return;
  if (error instanceof HcRuntimeError) {
    json(res, error.status, {
      ok: false,
      code: error.code,
      error: error.message,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  json(res, HC_RUNTIME_ERROR_STATUS.internal_error, { ok: false, code: 'internal_error', error: message });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function assertAllowed(services: HcRuntimeServices, action: HcRuntimeAction): Promise<void> {
  if (!services.guard) return;
  const result = await services.guard(action);
  if (result.ok) return;
  const code = (result.code ?? 'capability_denied') as HcRuntimeErrorCode;
  throw new HcRuntimeError(code, result.message ?? 'Action denied by workspace trust settings', { ...(result.status ? { status: result.status } : {}) });
}

async function assertSidecarOwnership(services: HcRuntimeServices, sidecarId: string, extensionId?: string): Promise<void> {
  if (!extensionId) return;
  const entry = await services.sidecarCatalog?.resolveSidecar(sidecarId);
  if (!entry || entry.extensionId !== extensionId) {
    throw new HcRuntimeError('capability_denied', 'Extension ' + extensionId + ' cannot access sidecar ' + sidecarId);
  }
}

// ---------------------------------------------------------------------------
// Runtime routes
// ---------------------------------------------------------------------------

/** GET /api/runtime, GET /api/runtime/events, POST /api/runtime/cancel. */
export async function handleRuntimeRoute(services: HcRuntimeServices, ctx: HcRuntimeRouteContext): Promise<boolean> {
  if (ctx.pathname === '/api/runtime' && ctx.method === 'GET') {
    try {
      await services.pty.probe();
      json(ctx.res, 200, {
        ok: true,
        workspace: services.workspaceDir,
        seq: services.events.seq,
        events: { buffered: services.events.buffered, dropped: services.events.dropped },
        sidecars: services.broker.list(),
        kernels: services.kernels.list(),
        terminal: services.pty.snapshot(),
      });
    } catch (error) {
      writeRouteError(ctx.res, error);
    }
    return true;
  }
  if (ctx.pathname === '/api/runtime/events' && ctx.method === 'GET') {
    try {
      streamRuntimeEvents(services, ctx);
    } catch (error) {
      writeRouteError(ctx.res, error);
    }
    return true;
  }
  if (ctx.pathname === '/api/runtime/cancel' && ctx.method === 'POST') {
    try {
      const body = await readBody(ctx.req);
      const requestId = body.requestId;
      const executionId = asString(body.executionId);
      let cancelled = false;
      if (typeof requestId === 'string' || typeof requestId === 'number') {
        const sidecarId = asString(body.sidecarId);
        const extensionId = asString(body.extensionId);
        if (sidecarId) {
          await assertSidecarOwnership(services, sidecarId, extensionId);
          await assertAllowed(services, 'sidecar');
          cancelled = services.broker.cancelFor(sidecarId, requestId, 'api cancel');
        } else cancelled = services.broker.cancel(requestId, 'api cancel');
      } else if (executionId) {
        cancelled = services.kernels.cancelByExecutionId(executionId);
      } else {
        throw new HcRuntimeError('invalid_params', 'requestId or executionId is required');
      }
      json(ctx.res, 200, { ok: true, cancelled });
    } catch (error) {
      writeRouteError(ctx.res, error);
    }
    return true;
  }
  return false;
}

function streamRuntimeEvents(services: HcRuntimeServices, ctx: HcRuntimeRouteContext): void {
  const afterRaw = ctx.url.searchParams.get('after') ?? ctx.req.headers['last-event-id'];
  const after = Number(afterRaw);
  const cursor = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;
  const res = ctx.res;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let lastSeq = cursor;
  const writeEvent = (record: HcRuntimeEventRecord): void => {
    if (res.writableEnded) return;
    res.write('id: ' + record.seq + '\nevent: runtime\ndata: ' + JSON.stringify(record) + '\n\n');
  };
  res.write('event: hello\ndata: ' + JSON.stringify({ ok: true, seq: services.events.seq, after: cursor }) + '\n\n');
  const unsubscribe = services.events.subscribe(record => {
    if (record.seq <= lastSeq) return;
    lastSeq = record.seq;
    writeEvent(record);
  });
  for (const record of services.events.after(cursor)) {
    if (record.seq <= lastSeq) continue;
    lastSeq = record.seq;
    writeEvent(record);
  }
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(': ping\n\n');
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();
  ctx.req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// ---------------------------------------------------------------------------
// Sidecar routes
// ---------------------------------------------------------------------------

/** GET /api/sidecars, POST /api/sidecars/:id/start|stop|request. */
export async function handleSidecarRoute(services: HcRuntimeServices, ctx: HcRuntimeRouteContext): Promise<boolean> {
  try {
    if (ctx.pathname === '/api/sidecars' && ctx.method === 'GET') {
      json(ctx.res, 200, { ok: true, sidecars: services.broker.list() });
      return true;
    }
    const match = /^\/api\/sidecars\/([^/]+)\/(start|stop|request)$/u.exec(ctx.pathname);
    if (!match) return false;
    const sidecarId = decodeURIComponent(match[1]!);
    const action = match[2]!;
    if (ctx.method !== 'POST') {
      json(ctx.res, 405, { ok: false, code: 'invalid_params', error: 'Method not allowed' });
      return true;
    }
    const body = await readBody(ctx.req);
    const extensionId = asString(body.extensionId);
    await assertSidecarOwnership(services, sidecarId, extensionId);
    await assertAllowed(services, 'sidecar');
    if (action === 'start') {
      const snapshot = await services.broker.start(sidecarId);
      json(ctx.res, 200, { ok: true, sidecar: snapshot });
      return true;
    }
    if (action === 'stop') {
      await services.broker.stop(sidecarId, 'api stop');
      json(ctx.res, 200, { ok: true, stopped: true });
      return true;
    }
    const method = asString(body.method);
    if (!method) throw new HcRuntimeError('invalid_params', 'method is required');
    const timeoutMs = typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs) ? body.timeoutMs : undefined;
    const requestId = asString(body.clientRequestId);
    if (requestId && !/^sc_[A-Za-z0-9_-]{8,80}$/u.test(requestId)) throw new HcRuntimeError('invalid_params', 'clientRequestId has an invalid format');
    const options: SidecarRequestOptions = { ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(requestId ? { requestId } : {}) };
    const outcome = await services.broker.request(sidecarId, method, body.params, options);
    json(ctx.res, 200, {
      ok: true,
      requestId: outcome.requestId,
      result: outcome.result,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      truncated: outcome.truncated,
      artifacts: outcome.artifacts,
      progressCount: outcome.progressCount,
      durationMs: outcome.durationMs,
    });
    return true;
  } catch (error) {
    writeRouteError(ctx.res, error);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Kernel routes
// ---------------------------------------------------------------------------

/** POST /api/kernels/ensure, POST /api/kernels/:id/execute|interrupt|restart,
 *  DELETE /api/kernels/:id, POST /api/kernel-outputs. */
export async function handleKernelRoute(services: HcRuntimeServices, ctx: HcRuntimeRouteContext): Promise<boolean> {
  try {
    if (ctx.pathname === '/api/kernels/ensure' && ctx.method === 'POST') {
      await assertAllowed(services, 'kernel');
      const body = await readBody(ctx.req);
      const kernelId = asString(body.kernelId);
      if (!kernelId) throw new HcRuntimeError('invalid_params', 'kernelId is required');
      const scope = body.scope as HcKernelScope | undefined;
      const session = await services.kernels.ensure(kernelId, scope);
      json(ctx.res, 200, { ok: true, session });
      return true;
    }
    if (ctx.pathname === '/api/kernel-outputs' && ctx.method === 'POST') {
      const body = await readBody(ctx.req, 16 * 1024 * 1024);
      await handleKernelOutput(services, body, ctx.res);
      return true;
    }
    const executionMatch = /^\/api\/kernels\/executions\/([^/]+)$/u.exec(ctx.pathname);
    if (executionMatch && ctx.method === 'GET') {
      await assertAllowed(services, 'kernel');
      json(ctx.res, 200, { ok: true, ...services.kernels.execution(decodeURIComponent(executionMatch[1]!)) });
      return true;
    }
    const match = /^\/api\/kernels\/([^/]+)(?:\/(execute|interrupt|restart|complete|inspect))?$/u.exec(ctx.pathname);
    if (!match) return false;
    const sessionId = decodeURIComponent(match[1]!);
    const action = match[2];
    const method = ctx.method;
    if (!action && method === 'DELETE') {
      await services.kernels.dispose(sessionId);
      json(ctx.res, 200, { ok: true });
      return true;
    }
    if (!action || method !== 'POST') {
      json(ctx.res, 405, { ok: false, code: 'invalid_params', error: 'Method not allowed' });
      return true;
    }
    await assertAllowed(services, 'kernel');
    if (action === 'complete' || action === 'inspect') {
      const body = await readBody(ctx.req);
      if (typeof body.code !== 'string') throw new HcRuntimeError('invalid_params', 'code is required');
      const cursorPos = typeof body.cursorPos === 'number' && Number.isFinite(body.cursorPos) ? Math.max(0, Math.floor(body.cursorPos)) : body.code.length;
      const variables = body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables)
        ? body.variables as Record<string, unknown>
        : undefined;
      const result = action === 'complete'
        ? await services.kernels.complete(sessionId, body.code, cursorPos, variables)
        : await services.kernels.inspect(sessionId, body.code, cursorPos, variables);
      json(ctx.res, 200, { ok: true, result });
      return true;
    }
    if (action === 'execute') {
      const body = await readBody(ctx.req);
      if (typeof body.code !== 'string') throw new HcRuntimeError('invalid_params', 'code is required');
      const cellId = asString(body.cellId);
      const silent = body.silent === true;
      const variables = body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables)
        ? body.variables as Record<string, unknown>
        : undefined;
      if (body.wait === true) {
        const result = await services.kernels.execute(sessionId, body.code, {
          ...(cellId ? { cellId } : {}),
          ...(variables ? { variables } : {}),
          silent,
        });
        json(ctx.res, 200, { ok: true, execution: result });
        return true;
      }
      const started = services.kernels.startExecution(sessionId, body.code, {
        ...(cellId ? { cellId } : {}),
        ...(variables ? { variables } : {}),
        silent,
      });
      json(ctx.res, 202, {
        ok: true,
        sessionId: started.sessionId,
        executionId: started.executionId,
        queuePosition: started.queuePosition,
        status: 'queued',
      });
      return true;
    }
    if (action === 'interrupt') {
      const body = await readBody(ctx.req);
      const target = asString(body.executionId);
      const interrupted = await services.kernels.interrupt(sessionId, target);
      json(ctx.res, 200, { ok: true, interrupted });
      return true;
    }
    const session = await services.kernels.restart(sessionId);
    json(ctx.res, 200, { ok: true, session });
    return true;
  } catch (error) {
    writeRouteError(ctx.res, error);
    return true;
  }
}

async function handleKernelOutput(services: HcRuntimeServices, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  if (!services.kernelOutputs) throw new HcRuntimeError('not_supported', 'Kernel output assets are not configured');
  const sessionId = asString(body.sessionId);
  const executionId = asString(body.executionId);
  const mime = asString(body.mime);
  if (!sessionId || !executionId || !mime) throw new HcRuntimeError('invalid_params', 'sessionId, executionId and mime are required');
  let data: Buffer;
  if (typeof body.base64 === 'string') {
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(body.base64)) throw new HcRuntimeError('invalid_params', 'base64 must be valid base64');
    data = Buffer.from(body.base64, 'base64');
  } else if (typeof body.text === 'string') {
    data = Buffer.from(body.text, 'utf8');
  } else {
    throw new HcRuntimeError('invalid_params', 'base64 or text payload is required');
  }
  const cap = mime === 'text/html' ? services.kernelLimits.maxHtmlBytes
    : mime === 'application/json' ? services.kernelLimits.maxJsonBytes
      : services.kernelLimits.maxMimeValueBytes;
  if (data.length > cap) throw new HcRuntimeError('limit_exceeded', 'Kernel output exceeds the ' + cap + ' byte cap for ' + mime);
  const asset = await services.kernelOutputs.save({
    sessionId,
    executionId,
    mime,
    data,
    name: asString(body.name) ?? 'kernel-output',
  });
  json(res, 201, { ok: true, asset });
}

// ---------------------------------------------------------------------------
// Terminal routes (SPEC-9.2)
// ---------------------------------------------------------------------------

/** GET/POST /api/terminal/sessions, :id/input|resize|buffer, DELETE :id. */
export async function handleTerminalRoute(services: HcRuntimeServices, ctx: HcRuntimeRouteContext): Promise<boolean> {
  try {
    if (ctx.pathname === '/api/terminal/sessions' && ctx.method === 'GET') {
      await services.pty.probe();
      json(ctx.res, 200, { ok: true, ...services.pty.snapshot() });
      return true;
    }
    if (ctx.pathname === '/api/terminal/sessions' && ctx.method === 'POST') {
      await assertAllowed(services, 'terminal');
      const body = await readBody(ctx.req);
      const profileId = asString(body.profileId);
      let command = Array.isArray(body.command) ? body.command.filter((item): item is string => typeof item === 'string') : undefined;
      let cwd = optionalString(body.cwd);
      let env = (body.env && typeof body.env === 'object' && !Array.isArray(body.env)) ? body.env as Record<string, string> : undefined;
      let allowedDirs: string[] | undefined;
      let label = optionalString(body.label);
      if (!command && profileId) {
        if (!services.resolveTerminalProfile) throw new HcRuntimeError('not_supported', 'Terminal profile resolution is not configured');
        const profile = await services.resolveTerminalProfile(profileId);
        if (!profile) throw new HcRuntimeError('unknown_reference', 'Unknown terminal profile ' + JSON.stringify(profileId));
        command = [...profile.command];
        cwd = cwd ?? profile.cwd;
        env = { ...(profile.env ?? {}), ...(env ?? {}) };
        allowedDirs = profile.allowedDirs;
        label = label ?? profile.label;
      }
      if (!command) throw new HcRuntimeError('invalid_params', 'command or profileId is required');
      const session = await services.pty.create({
        command,
        ...(cwd ? { cwd } : {}),
        ...(env ? { env } : {}),
        ...(typeof body.cols === 'number' ? { cols: body.cols } : {}),
        ...(typeof body.rows === 'number' ? { rows: body.rows } : {}),
        ...(label ? { label } : {}),
        ...(profileId ? { profileId } : {}),
        ...(allowedDirs ? { allowedDirs } : {}),
      });
      json(ctx.res, 201, { ok: true, session, buffer: services.pty.buffer(session.sessionId) });
      return true;
    }
    const match = /^\/api\/terminal\/sessions\/([^/]+)(?:\/(input|resize|buffer))?$/u.exec(ctx.pathname);
    if (!match) return false;
    const sessionId = decodeURIComponent(match[1]!);
    const action = match[2];
    if (!action && ctx.method === 'DELETE') {
      await services.pty.close(sessionId);
      json(ctx.res, 200, { ok: true });
      return true;
    }
    if (action === 'buffer' && ctx.method === 'GET') {
      json(ctx.res, 200, { ok: true, buffer: services.pty.buffer(sessionId) });
      return true;
    }
    if (ctx.method !== 'POST') {
      json(ctx.res, 405, { ok: false, code: 'invalid_params', error: 'Method not allowed' });
      return true;
    }
    await assertAllowed(services, 'terminal');
    const body = await readBody(ctx.req);
    if (action === 'input') {
      const data = body.data;
      if (typeof data !== 'string') throw new HcRuntimeError('invalid_params', 'data (base64) is required');
      const result = services.pty.input(sessionId, data);
      json(ctx.res, 200, { ok: true, accepted: result.accepted, seq: result.seq });
      return true;
    }
    if (action === 'resize') {
      if (typeof body.cols !== 'number' || typeof body.rows !== 'number') throw new HcRuntimeError('invalid_params', 'cols and rows are required');
      const session = services.pty.resize(sessionId, body.cols, body.rows);
      json(ctx.res, 200, { ok: true, session });
      return true;
    }
    return false;
  } catch (error) {
    writeRouteError(ctx.res, error);
    return true;
  }
}

/**
 * Try every runtime handler in order. Returns true when one owned the request;
 * the caller should then NOT write its own 404.
 */
export async function handleHcRuntimeRoute(services: HcRuntimeServices, ctx: HcRuntimeRouteContext): Promise<boolean> {
  if (await handleRuntimeRoute(services, ctx)) return true;
  if (await handleSidecarRoute(services, ctx)) return true;
  if (await handleKernelRoute(services, ctx)) return true;
  if (await handleTerminalRoute(services, ctx)) return true;
  return false;
}
