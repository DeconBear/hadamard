// HcKernelManager — HKP kernel sessions on top of the sidecar broker (SPEC-8).
//
// Per session: one kernel sidecar process (broker handle id = session id), one
// running execution at a time with a FIFO queue, stream/display/error/finished
// ordering, interrupt escalation (kernel/interrupt → SIGINT → kill+restart),
// restart, crash auto-restart (once by default), status and output caps.
//
// Session key: sha256(workspace + kernelId + scope) per SPEC-8.6; the same key is
// reused until the process dies and the session is disposed.
import { randomUUID } from 'node:crypto';

import {
  HcRuntimeError,
  HKP_METHODS,
  normalizeHkpInitializeResult,
  normalizeHkpNotification,
  type HcKernelCatalogEntry,
  type HcKernelCatalogPort,
  type HcKernelErrorOutput,
  type HcKernelExecutionLookup,
  type HcKernelExecutionResult,
  type HcKernelExecutionStatus,
  type HcKernelOutputItem,
  type HcKernelRuntimeEvent,
  type HcKernelScope,
  type HcKernelScopeKind,
  type HcKernelSessionSnapshot,
  type HcKernelSessionState,
  type HcSidecarRuntimeEvent,
  type HkpExecuteResult,
  type HkpInitializeResult,
  type HkpMimeBundle,
} from './protocol.js';
import { resolveKernelLimits, truncateTextBytes, type HcKernelLimits } from './limits.js';
import { sha256Short } from './spawn.js';
import type { SidecarBroker } from './broker.js';

const EXECUTION_ID_PREFIX = 'exec_';
const SESSION_ID_PREFIX = 'ks_';
const SCOPE_KINDS: readonly HcKernelScopeKind[] = ['document', 'page', 'file', 'custom'];
const MIME_TRUNCATION_SUFFIX = '…[truncated]';
/** Completed execution cache bounds: count alone is not enough (each result ≤ 8 MiB). */
const MAX_COMPLETED_EXECUTIONS = 100;
const MAX_COMPLETED_EXECUTION_BYTES = 32 * 1024 * 1024;

export interface HcKernelManagerOptions {
  broker: SidecarBroker;
  catalog?: HcKernelCatalogPort;
  workspaceDir: string;
  limits?: Partial<HcKernelLimits>;
  onEvent?: (event: HcKernelRuntimeEvent) => void;
  /** Clamp limits to global spec caps (default true; tests may disable). */
  enforceLimitCaps?: boolean;
  now?: () => Date;
  /** Completed execution cache entry budget (default 100; tests may shrink it). */
  completedExecutionMaxEntries?: number;
  /** Completed execution cache total output-byte budget (default 32 MiB; tests may shrink it). */
  completedExecutionMaxBytes?: number;
}

export interface HcKernelExecuteOptions {
  cellId?: string;
  silent?: boolean;
  variables?: Record<string, unknown>;
}

export interface HcKernelStartedExecution {
  executionId: string;
  sessionId: string;
  /** 1-based queue position at enqueue time (0 = started immediately). */
  queuePosition: number;
  completion: Promise<HcKernelExecutionResult>;
}

interface KernelExecutionRecord {
  executionId: string;
  sessionId: string;
  code: string;
  cellId?: string;
  silent?: boolean;
  variables?: HkpMimeBundle;
  startedAt: number;
  settled: boolean;
  events: HcKernelOutputItem[];
  totalBytes: number;
  displayCount: number;
  truncated: boolean;
  limitNotified: boolean;
  error?: HcKernelErrorOutput;
  resolve: (result: HcKernelExecutionResult) => void;
  completion: Promise<HcKernelExecutionResult>;
  timers: NodeJS.Timeout[];
  requestSettled: boolean;
  kernelResponse?: HkpExecuteResult;
  /** One automatic restart retry when the sidecar disappeared under us. */
  retried?: boolean;
}

interface KernelSessionRecord {
  sessionId: string;
  kernelId: string;
  scope: HcKernelScope;
  entry: HcKernelCatalogEntry;
  state: HcKernelSessionState;
  active: KernelExecutionRecord | null;
  queued: KernelExecutionRecord[];
  crashes: number;
  createdAt: string;
  lastActivityAt?: string;
  initialize?: HkpInitializeResult;
  unsubscribeNotifications?: () => void;
  /** True when the current process exit is already being handled as a crash. */
  sawCrash?: boolean;
  /** Incremented on every process launch; stale exit timers are ignored. */
  generation: number;
}

function callSafely<T>(callback: ((value: T) => void) | undefined, value: T): void {
  if (!callback) return;
  try {
    callback(value);
  } catch {
    /* listeners must never break the kernel manager */
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

/** SPEC-8.6 server key: sha256(workspace + kernelId + scope). */
export function kernelSessionKey(workspaceDir: string, kernelId: string, scope: HcKernelScope): string {
  const payload = JSON.stringify([workspaceDir, kernelId, scope.kind, scope.key]);
  return SESSION_ID_PREFIX + sha256Short(payload, 16);
}

export function normalizeKernelScope(scope: unknown): HcKernelScope {
  const record = (scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : {}) as Record<string, unknown>;
  const kind = SCOPE_KINDS.includes(record.kind as HcKernelScopeKind) ? record.kind as HcKernelScopeKind : 'document';
  const key = typeof record.key === 'string' ? record.key : '';
  return { kind, key };
}

function executionId(): string {
  return EXECUTION_ID_PREFIX + randomUUID().replace(/-/gu, '').slice(0, 16);
}

function measureMimeValue(value: unknown): number {
  try {
    return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

interface CappedBundle {
  data: HkpMimeBundle;
  bytes: number;
  truncated: boolean;
}

/** Apply SPEC-8.4 MIME caps to one bundle; drops/truncates oversized values. */
export function capHkpMimeBundle(bundle: HkpMimeBundle, limits: HcKernelLimits): CappedBundle {
  const data: HkpMimeBundle = {};
  let bytes = 0;
  let truncated = false;
  for (const [mime, value] of Object.entries(bundle)) {
    let candidate: HkpMimeBundle[string] = value;
    let size = measureMimeValue(candidate);
    if (mime === 'text/html' && typeof candidate === 'string' && size > limits.maxHtmlBytes) {
      candidate = truncateTextBytes(candidate, limits.maxHtmlBytes, MIME_TRUNCATION_SUFFIX).text;
      size = measureMimeValue(candidate);
      truncated = true;
    } else if (mime === 'application/json' && size > limits.maxJsonBytes) {
      const marker = truncateTextBytes(JSON.stringify(candidate), limits.maxJsonBytes, MIME_TRUNCATION_SUFFIX).text;
      candidate = marker;
      size = measureMimeValue(marker);
      truncated = true;
    }
    if (size > limits.maxMimeValueBytes) {
      truncated = true;
      continue;
    }
    data[mime] = candidate;
    bytes += size;
  }
  return { data, bytes, truncated };
}

function splitByChunkBytes(text: string, maxBytes: number): string[] {
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= maxBytes) return text.length > 0 ? [text] : [];
  const pieces: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let low = 1;
    let high = text.length - offset;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(text.slice(offset, offset + mid), 'utf8') <= maxBytes) low = mid;
      else high = mid - 1;
    }
    pieces.push(text.slice(offset, offset + low));
    offset += low;
  }
  return pieces;
}

/**
 * Kernel session manager. Owns sessions in memory; call `disposeAll()` on
 * server shutdown. Queued/running executions always settle (never hang).
 */
export class HcKernelManager {
  private readonly broker: SidecarBroker;
  private readonly catalog: HcKernelCatalogPort | undefined;
  private readonly workspaceDir: string;
  private readonly limits: HcKernelLimits;
  private readonly now: () => Date;
  private readonly onEventCallback: ((event: HcKernelRuntimeEvent) => void) | undefined;
  private readonly sessions = new Map<string, KernelSessionRecord>();
  private readonly executionIndex = new Map<string, string>();
  private readonly completedExecutions = new Map<string, { sessionId: string; result: HcKernelExecutionResult; bytes: number }>();
  private completedExecutionBytes = 0;
  private readonly completedExecutionMaxEntries: number;
  private readonly completedExecutionMaxBytes: number;
  private readonly unsubscribeBroker: () => void;

  constructor(options: HcKernelManagerOptions) {
    this.broker = options.broker;
    this.catalog = options.catalog;
    this.workspaceDir = options.workspaceDir;
    this.limits = resolveKernelLimits(options.limits, { enforceCaps: options.enforceLimitCaps !== false });
    this.now = options.now ?? (() => new Date());
    this.onEventCallback = options.onEvent;
    this.completedExecutionMaxEntries = typeof options.completedExecutionMaxEntries === 'number'
      && Number.isFinite(options.completedExecutionMaxEntries) && options.completedExecutionMaxEntries > 0
      ? Math.floor(options.completedExecutionMaxEntries)
      : MAX_COMPLETED_EXECUTIONS;
    this.completedExecutionMaxBytes = typeof options.completedExecutionMaxBytes === 'number'
      && Number.isFinite(options.completedExecutionMaxBytes) && options.completedExecutionMaxBytes > 0
      ? Math.floor(options.completedExecutionMaxBytes)
      : MAX_COMPLETED_EXECUTION_BYTES;
    this.unsubscribeBroker = this.broker.subscribe(event => this.handleBrokerEvent(event));
  }

  /** Ensure (or reuse) a session for kernelId + scope. */
  async ensure(kernelId: string, scope: unknown): Promise<HcKernelSessionSnapshot> {
    if (typeof kernelId !== 'string' || !kernelId) throw new HcRuntimeError('invalid_params', 'kernelId is required');
    const normalizedScope = normalizeKernelScope(scope);
    const sessionId = kernelSessionKey(this.workspaceDir, kernelId, normalizedScope);
    const existing = this.sessions.get(sessionId);
    if (existing && existing.state !== 'dead') return this.snapshotOf(existing);
    if (existing) this.dropSession(existing);
    const entry = await this.resolveKernelEntry(kernelId);
    const session: KernelSessionRecord = {
      sessionId,
      kernelId,
      scope: normalizedScope,
      entry,
      state: 'starting',
      active: null,
      queued: [],
      crashes: 0,
      generation: 0,
      createdAt: this.nowIso(),
      lastActivityAt: this.nowIso(),
    };
    this.sessions.set(sessionId, session);
    this.emitState(session);
    try {
      await this.launchKernel(session);
    } catch (error) {
      session.state = 'dead';
      this.emitState(session);
      this.failQueued(session, error instanceof HcRuntimeError ? error.message : String(error));
      throw error instanceof HcRuntimeError ? error : new HcRuntimeError('kernel_crash', error instanceof Error ? error.message : String(error));
    }
    return this.snapshotOf(session);
  }

  list(): HcKernelSessionSnapshot[] {
    return [...this.sessions.values()].map(session => this.snapshotOf(session));
  }

  snapshot(sessionId: string): HcKernelSessionSnapshot {
    return this.snapshotOf(this.requireSession(sessionId));
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  execution(executionId: string): HcKernelExecutionLookup {
    const completed = this.completedExecutions.get(executionId);
    if (completed) return { state: 'completed', sessionId: completed.sessionId, result: completed.result };
    const sessionId = this.executionIndex.get(executionId);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!sessionId || !session) return { state: 'unknown' };
    if (session.active?.executionId === executionId) return { state: 'running', sessionId };
    if (session.queued.some(item => item.executionId === executionId)) return { state: 'queued', sessionId };
    return { state: 'unknown' };
  }

  /** Enqueue an execution; resolves through `completion` when finished/aborted. */
  startExecution(sessionId: string, code: unknown, options: HcKernelExecuteOptions = {}): HcKernelStartedExecution {
    if (typeof code !== 'string') throw new HcRuntimeError('invalid_params', 'code must be a string');
    const session = this.requireSession(sessionId);
    if (session.state === 'dead') throw new HcRuntimeError('kernel_crash', 'Kernel session ' + sessionId + ' is dead');
    const execution = this.createExecutionRecord(session, code, options);
    const position = session.queued.length + (session.active ? 1 : 0) + 1;
    session.queued.push(execution);
    session.lastActivityAt = this.nowIso();
    this.emit(session, execution.executionId, 'execution_queued', {
      queuePosition: session.queued.length + (session.active ? 1 : 0),
      codeLength: code.length,
      ...(options.cellId ? { cellId: options.cellId } : {}),
    });
    this.pump(session);
    return {
      executionId: execution.executionId,
      sessionId,
      queuePosition: position,
      completion: execution.completion,
    };
  }

  /** Enqueue and await completion (route convenience helper). */
  execute(sessionId: string, code: unknown, options: HcKernelExecuteOptions = {}): Promise<HcKernelExecutionResult> {
    return this.startExecution(sessionId, code, options).completion;
  }

  async complete(sessionId: string, code: string, cursorPos: number, variables?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = this.requireSession(sessionId);
    const outcome = await this.broker.request(session.sessionId, HKP_METHODS.complete, { code, cursorPos, ...(variables ? { variables } : {}) }, { timeoutMs: 5000 });
    return outcome.result && typeof outcome.result === 'object' ? outcome.result as Record<string, unknown> : {};
  }

  async inspect(sessionId: string, code: string, cursorPos: number, variables?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = this.requireSession(sessionId);
    const outcome = await this.broker.request(session.sessionId, HKP_METHODS.inspect, { code, cursorPos, ...(variables ? { variables } : {}) }, { timeoutMs: 5000 });
    return outcome.result && typeof outcome.result === 'object' ? outcome.result as Record<string, unknown> : {};
  }

  /** Interrupt the running execution; escalates when the kernel does not comply. */
  async interrupt(sessionId: string, targetExecutionId?: string): Promise<boolean> {
    const session = this.requireSession(sessionId);
    const active = session.active;
    if (!active) return false;
    if (targetExecutionId && active.executionId !== targetExecutionId) return false;
    if (active.settled) return false;
    this.clearExecutionTimers(active);
    this.diagnose(session, 'interrupt', 'Interrupting execution ' + active.executionId);
    try {
      await this.broker.request(session.sessionId, HKP_METHODS.interrupt, { executionId: active.executionId }, {
        timeoutMs: Math.max(500, this.limits.interruptGraceMs),
      });
    } catch (error) {
      this.diagnose(session, 'interrupt_failed', error instanceof Error ? error.message : String(error));
    }
    if (active.settled) return true;
    const first = setTimeout(() => {
      if (active.settled || session.active !== active) return;
      this.diagnose(session, 'interrupt_escalate', 'kernel/interrupt did not finish; sending SIGINT (POSIX)');
      if (process.platform !== 'win32') {
        try {
          this.broker.signal(session.sessionId, 'SIGINT');
        } catch {
          /* ignore */
        }
      }
      const second = setTimeout(() => {
        if (active.settled || session.active !== active) return;
        this.diagnose(session, 'interrupt_kill', 'Kernel unresponsive; killing and restarting the kernel');
        void this.restart(sessionId).catch(() => undefined);
      }, this.limits.sigintGraceMs);
      second.unref?.();
      active.timers.push(second);
    }, this.limits.interruptGraceMs);
    first.unref?.();
    active.timers.push(first);
    return true;
  }

  /** Cancel a queued execution, or interrupt it when it is running. */
  cancel(sessionId: string, targetExecutionId?: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const queuedIndex = session.queued.findIndex(item => !targetExecutionId || item.executionId === targetExecutionId);
    if (queuedIndex >= 0) {
      const [record] = session.queued.splice(queuedIndex, 1);
      if (record) {
        this.executionIndex.delete(record.executionId);
        this.settleExecution(session, record, 'cancelled', { reason: 'cancelled while queued' });
      }
      return true;
    }
    const active = session.active;
    if (active && (!targetExecutionId || active.executionId === targetExecutionId)) {
      void this.interrupt(sessionId, active.executionId).catch(() => undefined);
      return true;
    }
    return false;
  }

  /** /api/runtime/cancel lookup by executionId (queued or running). */
  cancelByExecutionId(targetExecutionId: string): boolean {
    const sessionId = this.executionIndex.get(targetExecutionId);
    if (!sessionId) return false;
    return this.cancel(sessionId, targetExecutionId);
  }

  /** Restart: abort the active execution, kill the process, launch a new one. */
  async restart(sessionId: string): Promise<HcKernelSessionSnapshot> {
    const session = this.requireSession(sessionId);
    const active = session.active;
    session.state = 'restarting';
    if (active && !active.settled) {
      this.settleExecution(session, active, 'aborted', { error: { ename: 'KernelRestarted', evalue: 'Kernel was restarted', traceback: [] } });
    }
    this.emitState(session);
    session.unsubscribeNotifications?.();
    session.unsubscribeNotifications = undefined;
    await this.broker.stop(session.sessionId, 'kernel restart').catch(() => undefined);
    session.initialize = undefined;
    try {
      await this.launchKernel(session);
    } catch (error) {
      session.state = 'dead';
      this.emitState(session);
      this.failQueued(session, error instanceof HcRuntimeError ? error.message : String(error));
      throw error instanceof HcRuntimeError ? error : new HcRuntimeError('kernel_crash', error instanceof Error ? error.message : String(error));
    }
    return this.snapshotOf(session);
  }

  /** Shutdown a session: kernel/shutdown best effort, abort executions, stop process. */
  async dispose(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new HcRuntimeError('kernel_not_found', 'Unknown kernel session ' + JSON.stringify(sessionId));
    const active = session.active;
    if (active && !active.settled) {
      this.settleExecution(session, active, 'aborted', { error: { ename: 'KernelDisposed', evalue: 'Kernel session was shut down', traceback: [] } });
    }
    this.failQueued(session, 'kernel session shut down');
    session.state = 'dead';
    this.emitState(session);
    try {
      await this.broker.request(session.sessionId, HKP_METHODS.shutdown, {}, { timeoutMs: this.limits.shutdownGraceMs });
    } catch {
      /* kernels do not have to accept kernel/shutdown before a kill */
    }
    session.unsubscribeNotifications?.();
    session.unsubscribeNotifications = undefined;
    await this.broker.stop(session.sessionId, 'dispose').catch(() => undefined);
    this.dropSession(session);
  }

  /** Dispose every session (server shutdown). */
  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map(id => this.dispose(id).catch(() => undefined)));
    this.completedExecutions.clear();
    this.completedExecutionBytes = 0;
    this.unsubscribeBroker();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private createExecutionRecord(session: KernelSessionRecord, code: string, options: HcKernelExecuteOptions): KernelExecutionRecord {
    const id = executionId();
    let resolveCompletion: (result: HcKernelExecutionResult) => void = () => undefined;
    const completion = new Promise<HcKernelExecutionResult>(resolve => {
      resolveCompletion = resolve;
    });
    const record: KernelExecutionRecord = {
      executionId: id,
      sessionId: session.sessionId,
      code,
      ...(options.cellId ? { cellId: options.cellId } : {}),
      ...(options.silent === true ? { silent: true } : {}),
      ...(options.variables ? { variables: options.variables as HkpMimeBundle } : {}),
      startedAt: this.now().getTime(),
      settled: false,
      events: [],
      totalBytes: 0,
      displayCount: 0,
      truncated: false,
      limitNotified: false,
      resolve: resolveCompletion,
      timers: [],
      requestSettled: false,
      completion,
    };
    this.executionIndex.set(id, session.sessionId);
    return record;
  }

  private async resolveKernelEntry(kernelId: string): Promise<HcKernelCatalogEntry> {
    if (!this.catalog) throw new HcRuntimeError('not_supported', 'No kernel catalog is configured');
    const entry = await this.catalog.resolveKernel(kernelId);
    if (!entry) throw new HcRuntimeError('kernel_not_found', 'Unknown kernel ' + JSON.stringify(kernelId));
    return entry;
  }

  private async launchKernel(session: KernelSessionRecord): Promise<void> {
    session.generation += 1;
    session.state = 'starting';
    this.emitState(session);
    const sidecar = session.entry.sidecar;
    try {
      await this.broker.startDeclared(
        {
          ...sidecar,
          declaration: { ...sidecar.declaration, role: 'kernel' },
        },
        { handleId: session.sessionId, dedupe: false, autoRestart: false },
      );
    } catch (error) {
      throw error instanceof HcRuntimeError ? error : new HcRuntimeError('kernel_crash', error instanceof Error ? error.message : String(error));
    }
    let initialize: HkpInitializeResult;
    try {
      initialize = normalizeHkpInitializeResult(this.broker.initializeResult(session.sessionId));
    } catch (error) {
      await this.broker.stop(session.sessionId, 'invalid initialize').catch(() => undefined);
      throw error instanceof HcRuntimeError ? error : new HcRuntimeError('kernel_crash', error instanceof Error ? error.message : String(error));
    }
    session.initialize = initialize;
    session.unsubscribeNotifications?.();
    session.unsubscribeNotifications = this.broker.subscribeNotifications(session.sessionId, (method, params) => {
      this.handleKernelNotification(session, method, params);
    });
    session.sawCrash = false;
    session.state = 'ready';
    session.lastActivityAt = this.nowIso();
    this.emitState(session);
    this.emit(session, undefined, 'log', { level: 'info', message: 'kernel ready: ' + (initialize.displayName ?? initialize.language) });
    this.pump(session);
  }

  private handleBrokerEvent(event: HcSidecarRuntimeEvent): void {
    const session = this.sessions.get(event.handleId);
    if (!session) return;
    if (event.event === 'crash') {
      void this.handleKernelCrash(session);
      return;
    }
    if (event.event === 'exit') {
      // Expected exits happen while restarting/disposing; ignore those. An
      // unexpected exit is followed by a crash event from the broker, so defer
      // the "dead kernel" decision briefly and let crash handling win.
      if (session.state === 'restarting' || session.state === 'dead') return;
      const code = typeof event.payload.code === 'number' ? event.payload.code : null;
      const exitGeneration = session.generation;
      const timer = setTimeout(() => {
        if (session.state === 'restarting' || session.state === 'dead' || session.sawCrash) return;
        if (session.generation !== exitGeneration) return;
        const active = session.active;
        const message = 'Kernel sidecar exited' + (code === null ? '' : ' with code ' + code) + '; rerun the cell to start a fresh kernel';
        if (active && !active.settled) {
          this.settleExecution(session, active, 'aborted', {
            error: { ename: 'KernelExited', evalue: message, traceback: [] },
          });
        }
        session.state = 'dead';
        this.emitState(session);
        this.failQueued(session, message);
      }, 120);
      timer.unref?.();
      return;
    }
    if (event.event === 'diagnostic') {
      this.emit(session, session.active?.executionId, 'diagnostic', {
        code: typeof event.payload.code === 'string' ? event.payload.code : 'sidecar',
        message: typeof event.payload.message === 'string' ? event.payload.message : '',
      });
      return;
    }
    if (event.event === 'log') {
      this.emit(session, session.active?.executionId, 'log', {
        level: typeof event.payload.level === 'string' ? event.payload.level : 'info',
        message: typeof event.payload.message === 'string' ? event.payload.message : '',
        ...(typeof event.payload.source === 'string' ? { source: event.payload.source } : {}),
      });
    }
  }

  private async handleKernelCrash(session: KernelSessionRecord): Promise<void> {
    if (session.state === 'dead') return;
    session.sawCrash = true;
    session.state = 'restarting';
    const active = session.active;
    session.crashes += 1;
    const crashMessage = 'Kernel ' + session.kernelId + ' crashed (crash #' + session.crashes + ')';
    this.diagnose(session, 'kernel_crash', crashMessage);
    if (active && !active.settled) {
      this.settleExecution(session, active, 'aborted', { error: { ename: 'KernelCrash', evalue: crashMessage, traceback: [] } });
    }
    if (session.crashes > this.limits.maxCrashRestarts) {
      session.state = 'dead';
      this.emitState(session);
      this.failQueued(session, crashMessage);
      return;
    }
    session.state = 'restarting';
    this.emitState(session);
    await delay(this.limits.restartDelayMs);
    session.unsubscribeNotifications?.();
    session.unsubscribeNotifications = undefined;
    try {
      await this.launchKernel(session);
      this.diagnose(session, 'kernel_restarted', 'Kernel auto-restarted after crash; variables were reset');
    } catch (error) {
      session.state = 'dead';
      this.emitState(session);
      this.failQueued(session, error instanceof Error ? error.message : String(error));
    }
  }

  private handleKernelNotification(session: KernelSessionRecord, method: string, params: unknown): void {
    const normalized = normalizeHkpNotification(method, params);
    if (!normalized) {
      if (method.startsWith('kernel/')) this.diagnose(session, 'unknown_kernel_notification', 'Unhandled kernel notification ' + method);
      return;
    }
    if (normalized.type === 'log') {
      this.emit(session, session.active?.executionId, 'log', { level: normalized.level, message: normalized.message });
      return;
    }
    if (normalized.type === 'status') {
      this.emit(session, session.active?.executionId, 'kernel_status', { state: normalized.state });
      return;
    }
    const active = session.active;
    const execution = active && active.executionId === normalized.executionId ? active : undefined;
    if (!execution) {
      if (normalized.type !== 'execution_finished') {
        this.diagnose(session, 'unknown_execution', 'Notification for unknown execution ' + normalized.executionId);
      }
      return;
    }
    switch (normalized.type) {
      case 'execution_started':
        this.emit(session, execution.executionId, 'execution_started', {
          ...(normalized.cellId ? { cellId: normalized.cellId } : {}),
        });
        return;
      case 'stream':
        this.appendStream(session, execution, normalized.name, normalized.text);
        return;
      case 'display_data':
        this.appendDisplay(session, execution, normalized.data, normalized.metadata);
        return;
      case 'execute_result':
        this.appendExecuteResult(session, execution, normalized.data);
        return;
      case 'error':
        execution.error = { ename: normalized.ename, evalue: normalized.evalue, traceback: normalized.traceback };
        this.pushOutputItem(session, execution, { type: 'error', error: execution.error }, measureMimeValue(normalized.traceback.join('\n')));
        this.emit(session, execution.executionId, 'error', {
          ename: normalized.ename,
          evalue: normalized.evalue,
          traceback: normalized.traceback,
        });
        return;
      case 'execution_finished':
        this.settleExecution(session, execution, normalized.status, {});
        return;
      default:
        return;
    }
  }

  private appendStream(session: KernelSessionRecord, execution: KernelExecutionRecord, name: 'stdout' | 'stderr', text: string): void {
    if (!text) return;
    for (const piece of splitByChunkBytes(text, this.limits.maxStreamChunkBytes)) {
      if (!this.pushOutputItem(session, execution, { type: 'stream', name, text: piece }, Buffer.byteLength(piece, 'utf8'))) break;
      this.emit(session, execution.executionId, 'stream', { stream: name, text: piece });
    }
  }

  private appendDisplay(
    session: KernelSessionRecord,
    execution: KernelExecutionRecord,
    data: HkpMimeBundle,
    metadata?: Record<string, unknown>,
  ): void {
    if (execution.displayCount >= this.limits.maxDisplays) {
      this.noteTruncated(session, execution, 'display_data cap reached');
      return;
    }
    const capped = capHkpMimeBundle(data, this.limits);
    if (Object.keys(capped.data).length === 0) {
      this.noteTruncated(session, execution, 'display_data exceeds MIME limits');
      return;
    }
    const item: HcKernelOutputItem = { type: 'display_data', data: capped.data, ...(metadata ? { metadata } : {}) };
    if (!this.pushOutputItem(session, execution, item, capped.bytes)) return;
    execution.displayCount += 1;
    if (capped.truncated) this.noteTruncated(session, execution, 'display_data value truncated');
    this.emit(session, execution.executionId, 'display_data', {
      data: capped.data,
      ...(metadata ? { metadata } : {}),
      truncated: capped.truncated,
    });
  }

  private appendExecuteResult(session: KernelSessionRecord, execution: KernelExecutionRecord, data: HkpMimeBundle): void {
    const capped = capHkpMimeBundle(data, this.limits);
    if (Object.keys(capped.data).length === 0) {
      this.noteTruncated(session, execution, 'execute_result exceeds MIME limits');
      return;
    }
    if (!this.pushOutputItem(session, execution, { type: 'execute_result', data: capped.data }, capped.bytes)) return;
    if (capped.truncated) this.noteTruncated(session, execution, 'execute_result value truncated');
    this.emit(session, execution.executionId, 'execute_result', { data: capped.data, truncated: capped.truncated });
  }

  private pushOutputItem(session: KernelSessionRecord, execution: KernelExecutionRecord, item: HcKernelOutputItem, bytes: number): boolean {
    if (execution.totalBytes + bytes > this.limits.maxOutputBytes) {
      this.noteTruncated(session, execution, 'execution output cap reached');
      return false;
    }
    execution.events.push(item);
    execution.totalBytes += bytes;
    return true;
  }

  private noteTruncated(session: KernelSessionRecord, execution: KernelExecutionRecord, reason: string): void {
    execution.truncated = true;
    if (execution.limitNotified) return;
    execution.limitNotified = true;
    this.diagnose(session, 'limit_exceeded', 'Execution ' + execution.executionId + ' output truncated: ' + reason);
  }

  private pump(session: KernelSessionRecord): void {
    if (session.active || session.state !== 'ready') return;
    const next = session.queued.shift();
    if (!next) return;
    session.active = next;
    session.state = 'busy';
    next.startedAt = this.now().getTime();
    this.emitState(session);
    const params = {
      executionId: next.executionId,
      code: next.code,
      ...(next.cellId ? { cellId: next.cellId } : {}),
      ...(next.silent === true ? { silent: true } : {}),
      ...(next.variables ? { variables: next.variables } : {}),
    };
    const timeoutMs = this.limits.executionTimeoutMs > 0 ? this.limits.executionTimeoutMs : 0;
    void this.broker
      .request(session.sessionId, HKP_METHODS.execute, params, { timeoutMs })
      .then(outcome => this.handleExecuteResponse(session, next, outcome.result))
      .catch(error => this.handleExecuteRequestError(session, next, error));
    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (next.settled) return;
        this.diagnose(session, 'execution_timeout', 'Execution ' + next.executionId + ' exceeded ' + timeoutMs + 'ms; interrupting');
        void this.interrupt(session.sessionId, next.executionId).catch(() => undefined);
      }, timeoutMs);
      timer.unref?.();
      next.timers.push(timer);
    }
  }

  private handleExecuteResponse(session: KernelSessionRecord, execution: KernelExecutionRecord, result: unknown): void {
    execution.requestSettled = true;
    const response = (result && typeof result === 'object' ? result : {}) as HkpExecuteResult;
    execution.kernelResponse = response;
    if (execution.settled) return;
    // SPEC-8.3: execution_finished must precede the response. Fallback only for
    // non-conforming kernels so a completion can never hang.
    const fallback = setTimeout(() => {
      if (execution.settled) return;
      const status: HcKernelExecutionStatus = response.status === 'error' ? 'error' : response.status === 'aborted' ? 'aborted' : 'ok';
      this.settleExecution(session, execution, status, {});
    }, 1_000);
    fallback.unref?.();
    execution.timers.push(fallback);
  }

  private handleExecuteRequestError(session: KernelSessionRecord, execution: KernelExecutionRecord, error: unknown): void {
    execution.requestSettled = true;
    if (execution.settled) return;
    const message = error instanceof Error ? error.message : String(error);
    this.diagnose(session, 'execute_failed', 'kernel/execute failed: ' + message);
    // A service sidecar can disappear while the kernel session still believes it
    // is ready (sleep/idle/process cleanup). Restart the kernel and retry once
    // instead of leaving the client waiting or forcing a manual rerun.
    if (!execution.retried && /(?:Unknown sidecar|sidecar_not_found|Unknown handle|not running)/i.test(message)) {
      execution.retried = true;
      execution.requestSettled = false;
      if (session.active === execution) session.active = null;
      session.queued.unshift(execution);
      session.state = 'restarting';
      this.emitState(session);
      void this.restart(session.sessionId).catch(restartError => {
        const queuedIndex = session.queued.indexOf(execution);
        if (queuedIndex >= 0) session.queued.splice(queuedIndex, 1);
        if (!execution.settled) {
          this.settleExecution(session, execution, 'aborted', {
            error: { ename: 'KernelError', evalue: restartError instanceof Error ? restartError.message : String(restartError), traceback: [] },
          });
        }
      });
      return;
    }
    this.settleExecution(session, execution, 'aborted', {
      error: { ename: 'KernelError', evalue: message, traceback: [] },
    });
  }

  private settleExecution(
    session: KernelSessionRecord,
    execution: KernelExecutionRecord,
    status: HcKernelExecutionStatus,
    extras: { error?: HcKernelErrorOutput; reason?: string },
  ): void {
    if (execution.settled) return;
    execution.settled = true;
    this.clearExecutionTimers(execution);
    this.executionIndex.delete(execution.executionId);
    if (session.active === execution) session.active = null;
    const error = extras.error ?? execution.error;
    const durationMs = Math.max(0, this.now().getTime() - execution.startedAt);
    const result: HcKernelExecutionResult = {
      sessionId: session.sessionId,
      executionId: execution.executionId,
      status,
      durationMs,
      outputs: { events: [...execution.events], truncated: execution.truncated, totalBytes: execution.totalBytes },
      ...(error ? { error } : {}),
    };
    this.rememberCompletedExecution(execution.executionId, session.sessionId, result);
    this.emit(session, execution.executionId, 'execution_finished', {
      status,
      durationMs,
      truncated: execution.truncated,
      totalBytes: execution.totalBytes,
      eventCount: execution.events.length,
      ...(extras.reason ? { reason: extras.reason } : {}),
      ...(error ? { error } : {}),
    });
    if (session.state === 'busy') {
      session.state = 'ready';
      this.emitState(session);
    }
    try {
      execution.resolve(result);
    } catch {
      /* ignore */
    }
    this.pump(session);
  }

  /** Cache a settled result under a count and a byte budget; evict oldest first. */
  private rememberCompletedExecution(executionId: string, sessionId: string, result: HcKernelExecutionResult): void {
    const totalBytes = result.outputs && typeof result.outputs === 'object' && typeof result.outputs.totalBytes === 'number' && Number.isFinite(result.outputs.totalBytes)
      ? Math.max(0, Math.floor(result.outputs.totalBytes))
      : 0;
    this.completedExecutions.set(executionId, { sessionId, result, bytes: totalBytes });
    this.completedExecutionBytes += totalBytes;
    while (this.completedExecutions.size > this.completedExecutionMaxEntries || this.completedExecutionBytes > this.completedExecutionMaxBytes) {
      const oldestId = this.completedExecutions.keys().next().value;
      if (!oldestId) break;
      const oldest = this.completedExecutions.get(oldestId);
      this.completedExecutions.delete(oldestId);
      this.completedExecutionBytes = Math.max(0, this.completedExecutionBytes - (oldest?.bytes ?? 0));
    }
  }

  private failQueued(session: KernelSessionRecord, reason: string): void {
    const queued = session.queued.splice(0);
    for (const execution of queued) {
      this.settleExecution(session, execution, 'cancelled', { reason });
    }
  }

  private clearExecutionTimers(execution: KernelExecutionRecord): void {
    for (const timer of execution.timers.splice(0)) clearTimeout(timer);
  }

  private requireSession(sessionId: string): KernelSessionRecord {
    if (typeof sessionId !== 'string' || !sessionId) throw new HcRuntimeError('invalid_params', 'sessionId is required');
    const session = this.sessions.get(sessionId);
    if (!session) throw new HcRuntimeError('kernel_not_found', 'Unknown kernel session ' + JSON.stringify(sessionId));
    return session;
  }

  private dropSession(session: KernelSessionRecord): void {
    session.unsubscribeNotifications?.();
    session.unsubscribeNotifications = undefined;
    this.sessions.delete(session.sessionId);
    for (const [executionIdKey, sessionId] of [...this.executionIndex.entries()]) {
      if (sessionId === session.sessionId) this.executionIndex.delete(executionIdKey);
    }
  }

  private snapshotOf(session: KernelSessionRecord): HcKernelSessionSnapshot {
    const initialize = session.initialize;
    const descriptor = session.entry.kernel;
    const processPid = this.broker.snapshot(session.sessionId)?.pid ?? null;
    return {
      sessionId: session.sessionId,
      kernelId: session.kernelId,
      ...(descriptor.label ? { label: descriptor.label } : {}),
      language: initialize?.language ?? descriptor.language,
      ...(initialize?.languageVersion ?? descriptor.languageVersion
        ? { languageVersion: initialize?.languageVersion ?? descriptor.languageVersion }
        : {}),
      ...(initialize?.displayName ? { displayName: initialize.displayName } : {}),
      scope: { ...session.scope },
      state: session.state,
      pid: processPid,
      queued: session.queued.length,
      ...(session.active ? { activeExecutionId: session.active.executionId } : {}),
      crashes: session.crashes,
      mimeTypes: [...(initialize?.mimeTypes ?? ['text/plain'])],
      ...(initialize?.features ? { features: { ...initialize.features } } : {}),
      createdAt: session.createdAt,
      ...(session.lastActivityAt ? { lastActivityAt: session.lastActivityAt } : {}),
    };
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private diagnose(session: KernelSessionRecord, code: string, message: string): void {
    this.emit(session, session.active?.executionId, 'diagnostic', { code, message });
  }

  private emitState(session: KernelSessionRecord): void {
    this.emit(session, session.active?.executionId, 'state', {
      state: session.state,
      pid: this.broker.snapshot(session.sessionId)?.pid ?? null,
      queued: session.queued.length,
    });
  }

  private emit(
    session: KernelSessionRecord,
    executionId: string | undefined,
    event: HcKernelRuntimeEvent['event'],
    payload: Record<string, unknown>,
  ): void {
    const runtimeEvent: HcKernelRuntimeEvent = {
      kind: 'kernel',
      at: this.nowIso(),
      sessionId: session.sessionId,
      kernelId: session.kernelId,
      ...(executionId ? { executionId } : {}),
      event,
      payload,
    };
    callSafely(this.onEventCallback, runtimeEvent);
  }
}
