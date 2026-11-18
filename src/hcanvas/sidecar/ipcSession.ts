// SidecarIpcSession — the JSON-RPC session over one child process' stdio.
//
// Owns stdout framing/decode, the bounded frame queue + backpressure, request
// slots/timeouts, $/cancelRequest, $/progress, output/log/artifact routing with
// per-request caps and seq de-dup, and kernel/unknown notification fan-out.
// Process lifecycle (spawn, initialize validation, crash/restart, stop) lives in
// sidecarProcess.ts; this class reports activity through callbacks so the state
// machine stays in one place.
import { Buffer } from 'node:buffer';
import type { ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import {
  JsonRpcFrameDecoder,
  JSON_RPC_ERROR_CODES,
  encodeJsonRpcFrame,
  errorResponse,
  isJsonRpcRequest,
  notificationMessage,
  requestMessage,
  type JsonRpcId,
  type JsonRpcInboundFrame,
  type JsonRpcMessage,
} from './jsonrpc.js';
import {
  HcRuntimeError,
  SIDECAR_NOTIFY,
  collectSidecarArtifacts,
  isDeclaredSidecarMethod,
  parseSidecarArtifact,
  parseSidecarLogEntry,
  parseSidecarOutputChunk,
  parseSidecarProgress,
  type HcRuntimeErrorCode,
  type HcSidecarArtifact,
  type HcSidecarArtifactRef,
  type HcSidecarAuditKind,
  type HcSidecarDeclaration,
  type HcSidecarLogEntry,
  type HcSidecarProgress,
  type HcSidecarRole,
  type HcSidecarRuntimeEvent,
  type SidecarNotificationListener,
  type SidecarRequestOptions,
  type SidecarRequestOutcome,
} from './protocol.js';
import { ByteRing, RingBuffer, truncateTextBytes, type HcSidecarLimits } from './limits.js';
import { isPathInside } from './spawn.js';

export interface SidecarIpcSessionOptions {
  declaration: HcSidecarDeclaration;
  role: HcSidecarRole;
  extensionDir: string;
  workspaceDir: string;
  cwd: string;
  limits: HcSidecarLimits;
  maxFrameBytes: number;
  now: () => Date;
  emit: (event: HcSidecarRuntimeEvent['event'], payload: Record<string, unknown>) => void;
  audit: (kind: HcSidecarAuditKind, detail?: string, requestId?: JsonRpcId) => void;
  diagnose: (code: string, message: string, detail?: string) => void;
  /** Called when the first in-flight request starts. */
  onRequestStarted?: () => void;
  /** Called after each settle; true when the request completed successfully. */
  onRequestSettled?: (success: boolean) => void;
  onActivity?: () => void;
}

interface PendingRequest {
  id: JsonRpcId;
  method: string;
  startedAt: number;
  resolve: (outcome: SidecarRequestOutcome) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
  onProgress?: (progress: HcSidecarProgress) => void;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  lineState: { stdout: { lineBytes: number }; stderr: { lineBytes: number } };
  lastSeq: { stdout: number; stderr: number };
  progressCount: number;
  artifacts: HcSidecarArtifactRef[];
  truncated: boolean;
  cancelled: boolean;
  limitNotified: boolean;
}

interface QueuedFrame {
  frame: JsonRpcInboundFrame;
  bytes: number;
}

interface SlotWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

const LINE_TRUNCATION_SUFFIX = '…[line truncated]';

function callSafely<T>(callback: ((value: T) => void) | undefined, value: T): void {
  if (!callback) return;
  try {
    callback(value);
  } catch {
    /* listeners must never break the session */
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function estimateFrameBytes(frame: JsonRpcInboundFrame): number {
  if (frame.kind === 'error') return 128;
  try {
    return Buffer.byteLength(JSON.stringify(frame.message), 'utf8') + 64;
  } catch {
    return 256;
  }
}

/** Cap each line in a chunk to `maxLineBytes`, tracking carry across chunks. */
function capChunkLines(chunk: string, state: { lineBytes: number }, maxLineBytes: number): { text: string; truncated: boolean } {
  if (!chunk) return { text: '', truncated: false };
  let truncated = false;
  const parts = chunk.split('\n');
  const out: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const isLast = index === parts.length - 1;
    let piece = parts[index] ?? '';
    const room = maxLineBytes - state.lineBytes;
    if (room <= 0 && piece.length > 0) {
      truncated = true;
      piece = '';
    } else if (piece.length > 0) {
      const capped = truncateTextBytes(piece, room, '');
      if (capped.truncated) truncated = true;
      piece = capped.text;
    }
    state.lineBytes = isLast ? state.lineBytes + Buffer.byteLength(piece, 'utf8') : 0;
    out.push(piece);
  }
  let text = out.join('\n');
  if (truncated) text = text.length > 0 ? text + LINE_TRUNCATION_SUFFIX : LINE_TRUNCATION_SUFFIX;
  return { text, truncated };
}

/**
 * JSON-RPC session for one sidecar child. `attach()` once per child process;
 * `detach()` on exit. Request ids are numeric and per-session.
 */
export class SidecarIpcSession {
  private readonly options: SidecarIpcSessionOptions;
  private child: ChildProcess | null = null;
  private decoder: JsonRpcFrameDecoder;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly cancelledIds = new Set<string>();
  private slotWaiters: SlotWaiter[] = [];
  private stdoutQueue: QueuedFrame[] = [];
  private stdoutQueueBytes = 0;
  private paused = false;
  private draining = false;
  private readonly notificationListeners = new Set<SidecarNotificationListener>();
  private readonly logs: RingBuffer<HcSidecarLogEntry>;
  private readonly stderrRing: ByteRing;
  private stderrCarry = '';
  private nextRequestId = 1;
  private detached = false;

  constructor(options: SidecarIpcSessionOptions) {
    this.options = options;
    this.decoder = new JsonRpcFrameDecoder({ maxFrameBytes: options.maxFrameBytes });
    this.logs = new RingBuffer<HcSidecarLogEntry>(options.limits.logRingEntries);
    this.stderrRing = new ByteRing(options.limits.stderrTailBytes);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get queuedFrames(): number {
    return this.stdoutQueue.length;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get initialized(): boolean {
    return this.detached === false && this.child !== null;
  }

  logsSnapshot(): HcSidecarLogEntry[] {
    return this.logs.toArray();
  }

  stderrTail(): string | undefined {
    const tail = this.stderrRing.toBuffer().toString('utf8').trim();
    return tail ? tail.slice(-this.options.limits.stderrTailBytes) : undefined;
  }

  subscribeNotifications(listener: SidecarNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  /** Bind stdio handlers for a freshly spawned child. */
  attach(child: ChildProcess): void {
    this.detached = false;
    this.child = child;
    this.decoder = new JsonRpcFrameDecoder({ maxFrameBytes: this.options.maxFrameBytes });
    this.stdoutQueue = [];
    this.stdoutQueueBytes = 0;
    this.paused = false;
    child.stdout?.on('data', (chunk: Buffer) => this.handleStdout(child, chunk));
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('data', (chunk: Buffer) => this.handleStderr(child, chunk));
    child.stderr?.on('error', () => undefined);
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.options.diagnose('stdin_error', 'sidecar stdin error: ' + error.message);
    });
  }

  /** Stop processing stdio for the current child (it exited or is being killed). */
  detach(): void {
    this.detached = true;
    this.child = null;
    this.stdoutQueue = [];
    this.stdoutQueueBytes = 0;
    this.paused = false;
  }

  write(message: JsonRpcMessage): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      this.options.diagnose('stdin_unavailable', 'Cannot write to sidecar stdin');
      return false;
    }
    try {
      stdin.write(encodeJsonRpcFrame(message));
      return true;
    } catch (error) {
      this.options.diagnose('write_failed', 'Failed to write frame: ' + (error instanceof Error ? error.message : String(error)));
      return false;
    }
  }

  /** Send a notification without checking request whitelist/state. */
  sendNotification(method: string, params?: unknown): boolean {
    return this.write(notificationMessage(method, params));
  }

  /** Manifest-declared request with timeout/caps. Throws capability_denied if undeclared. */
  request(method: string, params: unknown, options: SidecarRequestOptions = {}): Promise<SidecarRequestOutcome> {
    if (!isDeclaredSidecarMethod(this.options.declaration, method)) {
      this.options.audit('denied', 'method ' + method + ' is not declared by the manifest');
      throw new HcRuntimeError('capability_denied', 'Sidecar method ' + JSON.stringify(method) + ' is not declared in the extension manifest');
    }
    return this.sendRequest(method, params, options);
  }

  /** Internal request used for the initialize handshake and shutdown. */
  internalRequest(method: string, params: unknown, timeoutMs: number): Promise<SidecarRequestOutcome> {
    return this.sendRequest(method, params, { timeoutMs }, true);
  }

  notify(method: string, params?: unknown): boolean {
    if (this.detached || !this.child) return false;
    const sent = this.write(notificationMessage(method, params));
    if (sent) this.options.onActivity?.();
    return sent;
  }

  cancel(requestId: JsonRpcId, reason = 'cancelled'): boolean {
    const key = String(requestId);
    const pending = this.pending.get(key);
    if (!pending) return false;
    this.pending.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    pending.cancelled = true;
    this.rememberCancelled(key);
    this.write(notificationMessage(SIDECAR_NOTIFY.cancel, { id: pending.id }));
    this.options.audit('cancel', reason + ' (method=' + pending.method + ')', pending.id);
    this.releaseSlot();
    pending.reject(new HcRuntimeError('execution_cancelled', 'Request ' + key + ' was cancelled', { detail: { requestId: pending.id } }));
    this.options.onRequestSettled?.(false);
    return true;
  }

  cancelAll(reason: string): number {
    let count = 0;
    for (const [key, pending] of [...this.pending.entries()]) {
      this.pending.delete(key);
      if (pending.timer) clearTimeout(pending.timer);
      this.rememberCancelled(key);
      pending.reject(new HcRuntimeError('execution_cancelled', 'Request ' + key + ' was cancelled: ' + reason, { detail: { requestId: pending.id } }));
      count += 1;
    }
    if (count > 0) this.options.audit('cancel', reason + ' (' + count + ' requests)');
    this.rejectSlotWaiters(new HcRuntimeError('execution_cancelled', 'Session stopped'));
    return count;
  }

  /** Reject all in-flight requests with `error` (crash/stop path). */
  rejectAll(error: Error): void {
    for (const [key, pending] of [...this.pending.entries()]) {
      this.pending.delete(key);
      if (pending.timer) clearTimeout(pending.timer);
      this.rememberCancelled(key);
      try {
        pending.reject(error);
      } catch {
        /* ignore */
      }
    }
    this.rejectSlotWaiters(error);
  }

  private async sendRequest(
    method: string,
    params: unknown,
    options: SidecarRequestOptions,
    internal = false,
  ): Promise<SidecarRequestOutcome> {
    await this.acquireSlot();
    if (this.detached || !this.child) {
      this.releaseSlot();
      throw new HcRuntimeError('sidecar_crash', 'Sidecar process is not running');
    }
    const declaredTimeout = this.options.declaration.requests?.find(item => item.method === method)?.timeoutMs;
    const timeoutMs = options.timeoutMs ?? declaredTimeout ?? this.options.limits.requestTimeoutMs;
    const id = options.requestId ?? this.nextRequestId;
    if (options.requestId === undefined) this.nextRequestId += 1;
    const key = String(id);
    if (this.pending.has(key)) {
      this.releaseSlot();
      throw new HcRuntimeError('invalid_params', 'Duplicate sidecar request id ' + key);
    }
    return new Promise<SidecarRequestOutcome>((resolve, reject) => {
      const record: PendingRequest = {
        id,
        method,
        startedAt: this.options.now().getTime(),
        resolve,
        reject,
        timer: null,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        stdout: '',
        stderr: '',
        stdoutBytes: 0,
        stderrBytes: 0,
        lineState: { stdout: { lineBytes: 0 }, stderr: { lineBytes: 0 } },
        lastSeq: { stdout: 0, stderr: 0 },
        progressCount: 0,
        artifacts: [],
        truncated: false,
        cancelled: false,
        limitNotified: false,
      };
      if (timeoutMs > 0) {
        record.timer = setTimeout(() => {
          if (this.pending.get(key) !== record) return;
          this.pending.delete(key);
          this.releaseSlot();
          this.options.audit('limit', 'request ' + key + ' timed out after ' + timeoutMs + 'ms', id);
          this.options.diagnose('request_timeout', 'Request ' + method + ' timed out after ' + timeoutMs + 'ms');
          record.reject(new HcRuntimeError('sidecar_timeout', 'Sidecar request ' + method + ' timed out after ' + timeoutMs + 'ms', { detail: { requestId: id } }));
          this.options.onRequestSettled?.(false);
        }, timeoutMs);
        record.timer.unref?.();
      }
      this.pending.set(key, record);
      if (!this.write(requestMessage(id, method, params))) {
        this.pending.delete(key);
        if (record.timer) clearTimeout(record.timer);
        this.releaseSlot();
        reject(new HcRuntimeError('sidecar_crash', 'Failed to write request ' + method + ' to the sidecar process'));
        return;
      }
      if (this.pending.size > 0) this.options.onRequestStarted?.();
      this.options.audit('request', (internal ? 'internal ' : '') + method, id);
      this.options.emit('request', { requestId: id, method });
    });
  }

  private async acquireSlot(): Promise<void> {
    if (this.pending.size < this.options.limits.maxConcurrentRequests) return;
    await new Promise<void>((resolve, reject) => {
      this.slotWaiters.push({ resolve, reject });
    });
  }

  private releaseSlot(): void {
    const waiter = this.slotWaiters.shift();
    if (!waiter) return;
    try {
      waiter.resolve();
    } catch {
      /* ignore */
    }
  }

  private rejectSlotWaiters(error: Error): void {
    for (const waiter of this.slotWaiters.splice(0)) {
      try {
        waiter.reject(error);
      } catch {
        /* ignore */
      }
    }
  }

  private rememberCancelled(key: string): void {
    this.cancelledIds.add(key);
    if (this.cancelledIds.size > 64) {
      const first = this.cancelledIds.values().next().value;
      if (first !== undefined) this.cancelledIds.delete(first);
    }
  }

  // -------------------------------------------------------------------------
  // stdout / stderr
  // -------------------------------------------------------------------------

  private handleStdout(child: ChildProcess, chunk: Buffer): void {
    if (this.child !== child) return;
    this.options.onActivity?.();
    let frames: JsonRpcInboundFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.options.diagnose('decoder_failed', 'Frame decoder failed: ' + (error instanceof Error ? error.message : String(error)));
      return;
    }
    for (const frame of frames) {
      const bytes = estimateFrameBytes(frame);
      this.stdoutQueue.push({ frame, bytes });
      this.stdoutQueueBytes += bytes;
    }
    this.updateBackpressure();
    void this.drain();
  }

  private handleStderr(child: ChildProcess, chunk: Buffer): void {
    if (this.child !== child) return;
    this.stderrRing.push(chunk);
    const text = this.stderrCarry + chunk.toString('utf8');
    const lines = text.split(/\r?\n/u);
    this.stderrCarry = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const capped = truncateTextBytes(line, this.options.limits.maxLineBytes, LINE_TRUNCATION_SUFFIX).text;
      const entry: HcSidecarLogEntry = { level: 'info', message: capped, source: 'stderr' };
      this.logs.push(entry);
      this.options.emit('log', { level: entry.level, message: entry.message, source: 'stderr' });
    }
  }

  private updateBackpressure(): void {
    const stdout = this.child?.stdout;
    const overHigh = this.stdoutQueue.length > this.options.limits.maxQueueEntries || this.stdoutQueueBytes > this.options.limits.maxQueueBytes;
    if (!this.paused && overHigh && stdout) {
      this.paused = true;
      try { stdout.pause(); } catch { /* ignore */ }
      this.options.emit('backpressure', { paused: true, entries: this.stdoutQueue.length, bytes: this.stdoutQueueBytes });
      return;
    }
    const lowEntries = Math.max(1, Math.floor(this.options.limits.maxQueueEntries / 2));
    const lowBytes = Math.max(1024, Math.floor(this.options.limits.maxQueueBytes / 2));
    if (this.paused && this.stdoutQueue.length <= lowEntries && this.stdoutQueueBytes <= lowBytes) {
      this.paused = false;
      try { stdout?.resume(); } catch { /* ignore */ }
      this.options.emit('backpressure', { paused: false, entries: this.stdoutQueue.length, bytes: this.stdoutQueueBytes });
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.stdoutQueue.length > 0) {
        const entry = this.stdoutQueue.shift()!;
        this.stdoutQueueBytes = Math.max(0, this.stdoutQueueBytes - entry.bytes);
        try {
          if (entry.frame.kind === 'error') this.handleDecoderError(entry.frame.error);
          else await this.handleMessage(entry.frame.message);
        } catch (error) {
          this.options.diagnose('frame_handler_failed', error instanceof Error ? error.message : String(error));
        }
        this.updateBackpressure();
        await yieldToEventLoop();
      }
    } finally {
      this.draining = false;
      this.updateBackpressure();
    }
  }

  private handleDecoderError(error: { code: number; message: string; data?: unknown }): void {
    this.options.diagnose('protocol_error', 'Invalid sidecar frame: ' + error.message, error.data === undefined ? undefined : JSON.stringify(error.data).slice(0, 512));
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    this.options.onActivity?.();
    if ('method' in message) {
      if (isJsonRpcRequest(message)) {
        this.write(errorResponse(message.id, new HcRuntimeError('capability_denied', 'Host does not accept sidecar-initiated requests'), JSON_RPC_ERROR_CODES.methodNotFound));
        return;
      }
      await this.handleNotification(message.method, message.params);
      return;
    }
    this.handleResponse(message);
  }

  private handleResponse(response: { id: JsonRpcId | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }): void {
    const key = String(response.id);
    const pending = this.pending.get(key);
    if (!pending) {
      if (this.cancelledIds.delete(key)) return;
      this.options.diagnose('unknown_response_id', 'Response for unknown request id ' + key);
      return;
    }
    this.pending.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    this.releaseSlot();
    if (pending.cancelled) return;
    if (response.error) {
      this.options.onRequestSettled?.(false);
      pending.reject(this.jsonRpcErrorToRuntime(response.error, pending.method));
      return;
    }
    void this.settleSuccess(pending, response.result);
  }

  private async settleSuccess(pending: PendingRequest, result: unknown): Promise<void> {
    const artifacts: HcSidecarArtifactRef[] = [];
    for (const descriptor of collectSidecarArtifacts(result)) {
      const resolved = await this.resolveArtifact(descriptor);
      if (resolved) artifacts.push(resolved);
    }
    this.options.onRequestSettled?.(true);
    pending.resolve({
      requestId: pending.id,
      method: pending.method,
      result,
      stdout: pending.stdout,
      stderr: pending.stderr,
      truncated: pending.truncated,
      artifacts,
      progressCount: pending.progressCount,
      durationMs: Math.max(0, this.options.now().getTime() - pending.startedAt),
    });
  }

  private jsonRpcErrorToRuntime(error: { code: number; message: string; data?: unknown }, method: string): HcRuntimeError {
    const mapped: HcRuntimeErrorCode =
      error.code === JSON_RPC_ERROR_CODES.requestCancelled ? 'execution_cancelled'
        : error.code === JSON_RPC_ERROR_CODES.methodNotFound ? 'capability_denied'
          : error.code === JSON_RPC_ERROR_CODES.invalidParams || error.code === JSON_RPC_ERROR_CODES.invalidRequest || error.code === JSON_RPC_ERROR_CODES.parseError ? 'invalid_params'
            : 'internal_error';
    return new HcRuntimeError(mapped, 'Sidecar request ' + method + ' failed: ' + error.message, {
      detail: { jsonRpcCode: error.code, data: error.data },
    });
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    if (method === SIDECAR_NOTIFY.progress) {
      const progress = parseSidecarProgress(params);
      if (!progress) {
        this.options.diagnose('invalid_progress', 'Malformed $/progress notification');
        return;
      }
      const pending = this.pending.get(String(progress.token));
      if (pending) {
        pending.progressCount += 1;
        callSafely(pending.onProgress, progress);
      }
      this.options.emit('progress', { token: progress.token, value: progress.value });
      return;
    }
    if (method === SIDECAR_NOTIFY.output) {
      this.handleOutputNotification(params);
      return;
    }
    if (method === SIDECAR_NOTIFY.log) {
      this.handleLogNotification(params);
      return;
    }
    if (method === SIDECAR_NOTIFY.artifact) {
      const artifact = parseSidecarArtifact(params);
      if (!artifact) {
        this.options.diagnose('invalid_artifact', 'Malformed artifact notification');
        return;
      }
      const resolved = await this.resolveArtifact(artifact);
      if (resolved) this.options.emit('artifact', { artifact: resolved });
      return;
    }
    if (method === SIDECAR_NOTIFY.exit) {
      this.options.diagnose('sidecar_exit_notification', 'Sidecar announced exit');
      return;
    }
    this.options.emit('notification', { method, params: params ?? null });
    for (const listener of [...this.notificationListeners]) {
      try {
        listener(method, params);
      } catch {
        /* listeners must not break the session */
      }
    }
  }

  private handleOutputNotification(params: unknown): void {
    const chunk = parseSidecarOutputChunk(params);
    if (!chunk) {
      this.options.diagnose('invalid_output', 'Malformed output notification');
      return;
    }
    const pending = this.pending.get(String(chunk.requestId));
    if (!pending) {
      this.options.diagnose('output_unknown_request', 'Output notification for unknown request ' + String(chunk.requestId));
      return;
    }
    const lastSeq = pending.lastSeq[chunk.stream];
    if (chunk.seq <= lastSeq) return; // duplicate delivery: drop silently
    if (chunk.seq > lastSeq + 1) this.options.diagnose('seq_gap', 'Output seq gap on ' + chunk.stream + ' (' + lastSeq + ' -> ' + chunk.seq + ')');
    pending.lastSeq[chunk.stream] = chunk.seq;
    const perStreamCap = chunk.stream === 'stdout' ? this.options.limits.maxStdoutBytes : this.options.limits.maxStderrBytes;
    const used = chunk.stream === 'stdout' ? pending.stdoutBytes : pending.stderrBytes;
    const remaining = perStreamCap - used;
    if (remaining <= 0) {
      this.noteRequestLimit(pending, chunk.stream);
      return;
    }
    const lined = capChunkLines(chunk.chunk, pending.lineState[chunk.stream], this.options.limits.maxLineBytes);
    const capped = truncateTextBytes(lined.text, remaining, '');
    if (lined.truncated || capped.truncated) this.noteRequestLimit(pending, chunk.stream);
    const text = capped.text;
    if (chunk.stream === 'stdout') {
      pending.stdout += text;
      pending.stdoutBytes += Buffer.byteLength(text, 'utf8');
    } else {
      pending.stderr += text;
      pending.stderrBytes += Buffer.byteLength(text, 'utf8');
    }
    this.options.emit('output', {
      requestId: pending.id,
      stream: chunk.stream,
      seq: chunk.seq,
      chunk: text,
      truncated: lined.truncated || capped.truncated,
    });
  }

  private noteRequestLimit(pending: PendingRequest, stream: 'stdout' | 'stderr'): void {
    pending.truncated = true;
    if (pending.limitNotified) return;
    pending.limitNotified = true;
    this.options.diagnose('limit_exceeded', 'Request ' + String(pending.id) + ' ' + stream + ' output exceeded the host limit; further output truncated');
    this.options.audit('limit', 'request ' + String(pending.id) + ' ' + stream + ' truncated', pending.id);
  }

  private handleLogNotification(params: unknown): void {
    const log = parseSidecarLogEntry(params);
    if (!log) {
      this.options.diagnose('invalid_log', 'Malformed log notification');
      return;
    }
    const entry: HcSidecarLogEntry = { ...log, message: truncateTextBytes(log.message, this.options.limits.maxLineBytes, LINE_TRUNCATION_SUFFIX).text };
    this.logs.push(entry);
    this.options.emit('log', { level: entry.level, message: entry.message, ...(entry.source ? { source: entry.source } : {}) });
  }

  private async resolveArtifact(artifact: HcSidecarArtifact): Promise<HcSidecarArtifactRef | null> {
    const roots = [this.options.extensionDir, this.options.workspaceDir];
    const candidates: string[] = [];
    if (artifact.path) {
      const raw = artifact.path;
      candidates.push(path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(this.options.cwd, raw));
      if (!path.isAbsolute(raw)) candidates.push(path.resolve(this.options.workspaceDir, raw));
    }
    let resolved: { absolute: string; root: string } | null = null;
    for (const candidate of candidates) {
      for (const root of roots) {
        if (isPathInside(root, candidate)) {
          resolved = { absolute: candidate, root };
          break;
        }
      }
      if (resolved) break;
    }
    if (!resolved) {
      this.options.diagnose('artifact_path_forbidden', 'Artifact path ' + JSON.stringify(artifact.path ?? artifact.name) + ' is outside the extension/workspace roots');
      this.options.audit('denied', 'artifact path ' + JSON.stringify(artifact.path ?? artifact.name));
      return null;
    }
    const info = await stat(resolved.absolute).catch(() => null);
    if (!info || !info.isFile()) {
      this.options.diagnose('artifact_missing', 'Artifact file not found: ' + resolved.absolute);
      return null;
    }
    if (info.size > this.options.limits.maxArtifactBytes) {
      this.options.diagnose('limit_exceeded', 'Artifact ' + artifact.name + ' is ' + info.size + ' bytes (max ' + this.options.limits.maxArtifactBytes + ')');
      this.options.audit('limit', 'artifact ' + artifact.name + ' too large');
      return null;
    }
    const relativePath = path.relative(resolved.root, resolved.absolute).split(path.sep).join('/');
    return { ...artifact, path: resolved.absolute, size: artifact.size ?? info.size, relativePath };
  }
}
