// SidecarProcess — lifecycle state machine for one spawned sidecar/kernel.
//
// Owns spawn, the initialize handshake, ready-waiter bookkeeping, the lifecycle
// state machine, idle timeout, crash backoff/restart and graceful shutdown
// escalation. The stdio JSON-RPC session (framing, requests, output caps,
// backpressure) lives in ipcSession.ts.
//
// Child-process callbacks never throw: every race becomes a diagnostic + audit
// entry, and stop()/request() after exit fails with a typed HcRuntimeError.
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';

import { HcRuntimeError } from './protocol.js';
import {
  SidecarIpcSession,
  type SidecarIpcSessionOptions,
} from './ipcSession.js';
import { RingBuffer, type HcSidecarLimits } from './limits.js';
import { isProcessAlive, type SidecarSpawnImpl } from './spawn.js';
import {
  SIDECAR_PROTOCOL_VERSION,
  normalizeSidecarInitializeResult,
  type HcRuntimeDiagnostic,
  type HcSidecarAuditEvent,
  type HcSidecarAuditKind,
  type HcSidecarCatalogEntry,
  type HcSidecarClientInfo,
  type HcSidecarDeclaration,
  type HcSidecarInitializeParams,
  type HcSidecarLifecycleState,
  type HcSidecarLogEntry,
  type HcSidecarRole,
  type HcSidecarRuntimeEvent,
  type HcSidecarServerInfo,
  type HcSidecarSnapshot,
  type SidecarNotificationListener,
  type SidecarRequestOptions,
  type SidecarRequestOutcome,
} from './protocol.js';
import type { JsonRpcId } from './jsonrpc.js';

export interface SidecarProcessSinks {
  onEvent?: (event: HcSidecarRuntimeEvent) => void;
  onAudit?: (event: HcSidecarAuditEvent) => void;
}

export interface SidecarProcessDeps extends SidecarProcessSinks {
  spawnImpl: SidecarSpawnImpl;
  killImpl: (pid: number, signal: NodeJS.Signals) => Promise<boolean>;
  now: () => Date;
  clientInfo: HcSidecarClientInfo;
  maxFrameBytes: number;
  /** Idle timeout expired; the broker owns the actual stop + map cleanup. */
  onIdleTimeout?: () => void;
}

export interface SidecarProcessInit {
  handleId: string;
  sidecarId: string;
  extensionId: string;
  extensionDir: string;
  workspaceDir: string;
  entry: HcSidecarCatalogEntry;
  declaration: HcSidecarDeclaration;
  role: HcSidecarRole;
  instanceKey: string;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  envKeys: string[];
  limits: HcSidecarLimits;
  autoRestart: boolean;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

function isReadyState(state: HcSidecarLifecycleState): boolean {
  return state === 'ready' || state === 'busy';
}

function isPendingStartState(state: HcSidecarLifecycleState): boolean {
  return state === 'starting' || state === 'initializing' || state === 'restarting';
}

function callSafely<T>(callback: ((value: T) => void) | undefined, value: T): void {
  if (!callback) return;
  try {
    callback(value);
  } catch {
    /* sinks must never break the state machine */
  }
}

/**
 * One sidecar process. Owned by SidecarBroker, which maps instance keys to these
 * objects and owns catalog lookup / dedupe / process caps.
 */
export class SidecarProcess {
  readonly handleId: string;
  readonly sidecarId: string;
  readonly extensionId: string;
  readonly extensionDir: string;
  readonly workspaceDir: string;
  readonly entry: HcSidecarCatalogEntry;
  readonly declaration: HcSidecarDeclaration;
  readonly role: HcSidecarRole;
  readonly instanceKey: string;
  readonly command: string[];
  readonly cwd: string;
  readonly envKeys: string[];
  autoRestart: boolean;
  private readonly env: Record<string, string>;
  private readonly limits: HcSidecarLimits;
  private readonly deps: SidecarProcessDeps;
  private readonly ipc: SidecarIpcSession;

  private lifecycle: HcSidecarLifecycleState = 'declared';
  private child: ChildProcess | null = null;
  private childPid: number | null = null;
  private startedAt?: string;
  private readyAt?: string;
  private lastActivityAt?: string;
  private crashes = 0;
  private readyWaiters: ReadyWaiter[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private initializePayload: unknown;
  private serverInfo?: HcSidecarServerInfo;
  private readonly diagnostics: RingBuffer<HcRuntimeDiagnostic>;
  private exitInfo?: { code: number | null; signal: string | null };

  constructor(init: SidecarProcessInit, deps: SidecarProcessDeps) {
    this.handleId = init.handleId;
    this.sidecarId = init.sidecarId;
    this.extensionId = init.extensionId;
    this.extensionDir = path.resolve(init.extensionDir);
    this.workspaceDir = path.resolve(init.workspaceDir);
    this.entry = init.entry;
    this.declaration = init.declaration;
    this.role = init.role;
    this.instanceKey = init.instanceKey;
    this.command = [...init.command];
    this.cwd = init.cwd;
    this.env = init.env;
    this.envKeys = [...init.envKeys];
    this.limits = init.limits;
    this.autoRestart = init.autoRestart;
    this.deps = deps;
    this.diagnostics = new RingBuffer<HcRuntimeDiagnostic>(init.limits.maxDiagnostics);
    const ipcOptions: SidecarIpcSessionOptions = {
      declaration: init.declaration,
      role: init.role,
      extensionDir: this.extensionDir,
      workspaceDir: this.workspaceDir,
      cwd: this.cwd,
      limits: this.limits,
      maxFrameBytes: deps.maxFrameBytes,
      now: deps.now,
      emit: (event, payload) => this.emit(event, payload),
      audit: (kind, detail, requestId) => this.audit(kind, detail, requestId),
      diagnose: (code, message, detail) => this.diagnose(code, message, detail),
      onRequestStarted: () => this.handleRequestStarted(),
      onRequestSettled: success => this.handleRequestSettled(success),
      onActivity: () => { this.lastActivityAt = this.nowIso(); },
    };
    this.ipc = new SidecarIpcSession(ipcOptions);
  }

  get state(): HcSidecarLifecycleState {
    return this.lifecycle;
  }

  get pid(): number | null {
    return this.childPid;
  }

  get ready(): boolean {
    return isReadyState(this.lifecycle);
  }

  get isPendingStart(): boolean {
    return isPendingStartState(this.lifecycle);
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  get isDead(): boolean {
    return this.lifecycle === 'failed' || this.lifecycle === 'stopped';
  }

  initializeResult(): unknown {
    return this.initializePayload;
  }

  subscribeNotifications(listener: SidecarNotificationListener): () => void {
    return this.ipc.subscribeNotifications(listener);
  }

  logsSnapshot(): HcSidecarLogEntry[] {
    return this.ipc.logsSnapshot();
  }

  diagnosticsSnapshot(): HcRuntimeDiagnostic[] {
    return this.diagnostics.toArray();
  }

  snapshot(): HcSidecarSnapshot {
    return {
      sidecarId: this.sidecarId,
      extensionId: this.extensionId,
      instanceKey: this.instanceKey,
      role: this.role,
      state: this.lifecycle,
      ...(this.declaration.label ? { label: this.declaration.label } : {}),
      command: [...this.command],
      cwd: this.cwd,
      envKeys: [...this.envKeys],
      pid: this.childPid,
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.readyAt ? { readyAt: this.readyAt } : {}),
      ...(this.lastActivityAt ? { lastActivityAt: this.lastActivityAt } : {}),
      crashes: this.crashes,
      queue: {
        pendingRequests: this.ipc.pendingCount,
        queuedFrames: this.ipc.queuedFrames,
        paused: this.ipc.isPaused,
      },
      ...(this.serverInfo ? { serverInfo: this.serverInfo } : {}),
      ...(this.declaration.outputChannel ? { outputChannel: this.declaration.outputChannel } : {}),
      diagnostics: this.diagnostics.toArray(),
      ...(this.exitInfo ? { exitInfo: this.exitInfo } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /** Spawn + initialize handshake. Throws HcRuntimeError when startup fails. */
  async launch(): Promise<void> {
    if (this.stopping) throw new HcRuntimeError('execution_cancelled', 'Sidecar is stopping');
    this.lifecycle = 'starting';
    this.emitState();
    const file = this.command[0]!;
    const args = this.command.slice(1);
    let child: ChildProcess;
    try {
      child = this.deps.spawnImpl(file, args, {
        cwd: this.cwd,
        env: this.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      throw this.failStartup(new HcRuntimeError('sidecar_spawn_failed', 'Failed to spawn ' + file + ': ' + (error instanceof Error ? error.message : String(error))));
    }
    this.child = child;
    this.childPid = typeof child.pid === 'number' ? child.pid : null;
    this.startedAt = this.nowIso();
    this.lastActivityAt = this.startedAt;
    this.exitInfo = undefined;
    this.ipc.attach(child);
    child.on('error', (error: Error) => {
      if (this.child !== child) return;
      this.diagnose('child_error', 'sidecar process error: ' + error.message);
    });
    child.once('exit', (code, signal) => this.handleChildExit(child, code, signal));
    try {
      await this.waitForSpawn(child);
    } catch (error) {
      throw this.failStartup(new HcRuntimeError('sidecar_spawn_failed', 'Failed to spawn ' + file + ': ' + (error instanceof Error ? error.message : String(error))));
    }
    this.audit('spawn', JSON.stringify(this.command) + ' (cwd=' + this.cwd + ')');
    this.lifecycle = 'initializing';
    this.emitState();
    try {
      await this.performInitialize();
    } catch (error) {
      const runtimeError = error instanceof HcRuntimeError ? error : new HcRuntimeError('sidecar_spawn_failed', error instanceof Error ? error.message : String(error));
      this.diagnose(runtimeError.code, runtimeError.message, this.ipc.stderrTail());
      throw this.failStartup(runtimeError);
    }
    this.lifecycle = 'ready';
    this.readyAt = this.nowIso();
    this.lastActivityAt = this.readyAt;
    this.emitState();
    this.emit('ready', { serverInfo: this.serverInfo ?? null });
    this.audit('ready', this.serverInfo?.name ?? this.sidecarId);
    this.resolveReady();
    this.scheduleIdle();
  }

  request(method: string, params?: unknown, options: SidecarRequestOptions = {}): Promise<SidecarRequestOutcome> {
    if (!isReadyState(this.lifecycle)) {
      return Promise.reject(new HcRuntimeError('sidecar_crash', 'Sidecar ' + this.sidecarId + ' is not ready (state=' + this.lifecycle + ')'));
    }
    return this.ipc.request(method, params, options).then(outcome => {
      // A successful public request proves the process is healthy again.
      this.crashes = 0;
      return outcome;
    });
  }

  notify(method: string, params?: unknown): boolean {
    if (!isReadyState(this.lifecycle)) return false;
    return this.ipc.notify(method, params);
  }

  signal(signal: NodeJS.Signals): boolean {
    if (!this.child || this.childPid === null) return false;
    try {
      this.child.kill(signal);
      this.audit('signal', signal);
      return true;
    } catch (error) {
      this.diagnose('signal_failed', 'Failed to send ' + signal + ': ' + (error instanceof Error ? error.message : String(error)));
      return false;
    }
  }

  cancel(requestId: JsonRpcId, reason = 'cancelled'): boolean {
    if (!this.ipc.cancel(requestId, reason)) return false;
    this.scheduleIdle();
    return true;
  }

  cancelAllRequests(reason: string): number {
    const count = this.ipc.cancelAll(reason);
    if (count > 0) this.scheduleIdle();
    return count;
  }

  /** Await readiness; rejects when the instance is already dead. */
  waitForReady(): Promise<void> {
    if (isReadyState(this.lifecycle)) return Promise.resolve();
    if (this.isDead) return Promise.reject(new HcRuntimeError('sidecar_crash', 'Sidecar ' + this.sidecarId + ' is ' + this.lifecycle));
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  /** Graceful shutdown: JSON-RPC shutdown → tree SIGTERM → SIGKILL. */
  async stop(reason = 'requested'): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.clearIdleTimer();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.lifecycle = 'stopping';
    this.emitState();
    this.audit('stop', reason);
    const cancelError = new HcRuntimeError('execution_cancelled', 'Sidecar stopped: ' + reason);
    this.rejectReady(cancelError);
    this.ipc.rejectAll(cancelError);
    const promise = (async (): Promise<void> => {
      const pid = this.childPid;
      const child = this.child;
      const wasRunning = Boolean(child && pid);
      if (child && pid && this.role !== 'kernel') {
        await this.ipc.internalRequest('shutdown', {}, this.limits.shutdownGraceMs).catch(() => undefined);
        await this.waitForExit(this.limits.shutdownGraceMs);
      }
      if (wasRunning && instanceAlive(this.childPid ?? pid)) {
        this.audit('signal', 'SIGTERM tree kill');
        await this.deps.killImpl(pid!, 'SIGTERM').catch(() => false);
        await this.waitForExit(this.limits.killGraceMs);
      }
      if (wasRunning && instanceAlive(this.childPid ?? pid)) {
        this.audit('signal', 'SIGKILL tree kill');
        await this.deps.killImpl(pid!, 'SIGKILL').catch(() => false);
        await this.waitForExit(1_000);
      }
      this.child = null;
      this.childPid = null;
      this.ipc.detach();
      this.lifecycle = 'stopped';
      this.stopping = false;
      this.emitState();
    })();
    this.stopPromise = promise.finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  /** Manual restart: kill the current child and launch a fresh process. */
  async restart(): Promise<void> {
    if (this.stopping) return;
    this.clearIdleTimer();
    const pid = this.childPid;
    if (pid !== null) {
      this.audit('restart', 'manual restart');
      await this.deps.killImpl(pid, 'SIGKILL').catch(() => false);
      await this.waitForExit(1_000);
    }
    this.child = null;
    this.childPid = null;
    this.ipc.detach();
    this.lifecycle = 'crashed';
    this.emitState();
    await this.launch();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async performInitialize(): Promise<void> {
    const params: HcSidecarInitializeParams = {
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      client: this.deps.clientInfo,
      capabilities: {},
    };
    const outcome = await this.ipc.internalRequest('initialize', params, this.limits.initializeTimeoutMs);
    if (this.role === 'kernel') {
      // HKP payload validation happens in the kernel session manager.
      this.initializePayload = outcome.result;
      this.serverInfo = { name: this.sidecarId };
    } else {
      const normalized = normalizeSidecarInitializeResult(outcome.result, this.declaration);
      this.initializePayload = outcome.result;
      this.serverInfo = normalized.serverInfo;
    }
    this.ipc.sendNotification('initialized', {});
  }

  private waitForSpawn(child: ChildProcess): Promise<void> {
    if (typeof child.pid === 'number') return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const onSpawn = (): void => {
        if (settled) return;
        settled = true;
        child.removeListener('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        if (settled) return;
        settled = true;
        child.removeListener('spawn', onSpawn);
        reject(error);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }

  private handleRequestStarted(): void {
    this.clearIdleTimer();
    if (this.lifecycle === 'ready') {
      this.lifecycle = 'busy';
      this.emitState();
    }
  }

  private handleRequestSettled(_success: boolean): void {
    if (this.ipc.pendingCount === 0 && this.lifecycle === 'busy') {
      this.lifecycle = 'ready';
      this.emitState();
    }
    this.scheduleIdle();
  }

  private handleChildExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.childPid = null;
    this.exitInfo = { code, signal: signal ?? null };
    this.clearIdleTimer();
    this.ipc.detach();
    this.emit('exit', { code, signal: signal ?? null });
    this.audit('exit', 'code=' + String(code) + ' signal=' + String(signal));
    if (this.stopping) {
      this.rejectReady(new HcRuntimeError('execution_cancelled', 'Sidecar ' + this.sidecarId + ' stopped'));
      return;
    }
    const crashError = new HcRuntimeError('sidecar_crash', 'Sidecar ' + this.sidecarId + ' exited unexpectedly (code=' + String(code) + ', signal=' + String(signal) + ')');
    this.ipc.rejectAll(crashError);
    this.crashes += 1;
    this.diagnose('sidecar_crash', crashError.message, this.ipc.stderrTail());
    this.audit('crash', 'code=' + String(code) + ' signal=' + String(signal));
    this.emit('crash', { code, signal: signal ?? null, crashes: this.crashes });
    this.lifecycle = 'crashed';
    this.emitState();
    this.rejectReady(crashError);
    if (!this.autoRestart || this.crashes > this.limits.maxCrashes) {
      this.lifecycle = 'failed';
      this.emitState();
      return;
    }
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    this.lifecycle = 'restarting';
    this.emitState();
    const index = Math.min(Math.max(0, this.crashes - 1), this.limits.crashBackoffMs.length - 1);
    const backoff = this.limits.crashBackoffMs[index] ?? 1_000;
    this.audit('restart', 'attempt ' + this.crashes + ' in ' + backoff + 'ms');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.relaunch();
    }, backoff);
    this.restartTimer.unref?.();
  }

  private async relaunch(): Promise<void> {
    if (this.stopping) return;
    try {
      await this.launch();
    } catch (error) {
      if (this.stopping) return;
      this.crashes += 1;
      this.diagnose('restart_failed', error instanceof Error ? error.message : String(error), this.ipc.stderrTail());
      if (this.crashes > this.limits.maxCrashes || !this.autoRestart) {
        this.lifecycle = 'failed';
        this.emitState();
        this.rejectReady(new HcRuntimeError('sidecar_crash', 'Sidecar ' + this.sidecarId + ' failed to restart'));
        return;
      }
      this.scheduleRestart();
    }
  }

  private failStartup(error: HcRuntimeError): HcRuntimeError {
    this.lifecycle = 'failed';
    this.clearIdleTimer();
    this.rejectReady(error);
    this.ipc.rejectAll(error);
    this.diagnose(error.code, error.message, this.ipc.stderrTail());
    this.emitState();
    const pid = this.childPid;
    if (pid !== null) void this.deps.killImpl(pid, 'SIGKILL').catch(() => false);
    return error;
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('exit', onExit);
        resolve(value);
      };
      const onExit = (): void => finish(true);
      child.once('exit', onExit);
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      timer.unref?.();
    });
  }

  private scheduleIdle(): void {
    this.clearIdleTimer();
    if (this.ipc.pendingCount > 0 || this.ipc.queuedFrames > 0) return;
    if (!isReadyState(this.lifecycle)) return;
    const idleTimeoutMs = this.limits.idleTimeoutMs;
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.ipc.pendingCount > 0 || !isReadyState(this.lifecycle)) return;
      if (this.deps.onIdleTimeout) this.deps.onIdleTimeout();
      else void this.stop('idle timeout').catch(() => undefined);
    }, idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private nowIso(): string {
    return this.deps.now().toISOString();
  }

  private resolveReady(): void {
    for (const waiter of this.readyWaiters.splice(0)) {
      try {
        waiter.resolve();
      } catch {
        /* ignore */
      }
    }
  }

  private rejectReady(error: Error): void {
    for (const waiter of this.readyWaiters.splice(0)) {
      try {
        waiter.reject(error);
      } catch {
        /* ignore */
      }
    }
  }

  private diagnose(code: string, message: string, detail?: string): void {
    const diagnostic: HcRuntimeDiagnostic = { code, message, at: this.nowIso(), ...(detail ? { detail: detail.slice(0, 8 * 1024) } : {}) };
    this.diagnostics.push(diagnostic);
    this.emit('diagnostic', { code: diagnostic.code, message: diagnostic.message, ...(diagnostic.detail ? { detail: diagnostic.detail } : {}) });
  }

  private audit(kind: HcSidecarAuditKind, detail?: string, requestId?: JsonRpcId): void {
    const event: HcSidecarAuditEvent = {
      at: this.nowIso(),
      kind,
      extensionId: this.extensionId,
      sidecarId: this.sidecarId,
      instanceKey: this.instanceKey,
      ...(requestId === undefined ? {} : { requestId }),
      ...(detail ? { detail } : {}),
    };
    callSafely(this.deps.onAudit, event);
  }

  private emitState(): void {
    this.emit('state', { state: this.lifecycle });
  }

  private emit(event: HcSidecarRuntimeEvent['event'], payload: Record<string, unknown>): void {
    const runtimeEvent: HcSidecarRuntimeEvent = {
      kind: 'sidecar',
      at: this.nowIso(),
      handleId: this.handleId,
      sidecarId: this.sidecarId,
      instanceKey: this.instanceKey,
      extensionId: this.extensionId,
      event,
      payload,
    };
    callSafely(this.deps.onEvent, runtimeEvent);
  }
}

function instanceAlive(pid: number | null): boolean {
  return isProcessAlive(pid);
}
