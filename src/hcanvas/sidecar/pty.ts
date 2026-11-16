// HcPtyManager — node-pty terminal sessions for Hcanvas (SPEC-9).
//
// Mirrors src/gui/terminalManager.ts feature-gate semantics: node-pty (and the
// headless xterm renderer) are optional native modules loaded through a dynamic
// import; when they are missing the manager reports unavailable and routes
// degrade with `not_supported` (the UI hides the terminal entry).
//
// Session model: capped byte ring for reconnect replay, live data/exit events
// for the runtime SSE hub, base64 input with a per-session rate limit, resize,
// and tree-kill on close.
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { HcRuntimeError, type HcTerminalRuntimeEvent, type HcTerminalSessionState } from './protocol.js';
import { ByteRing, resolvePtyLimits, type HcPtyLimits } from './limits.js';
import { buildSandboxEnv, isPathInside, killProcessTree } from './spawn.js';

interface NodePtyProcess {
  pid: number;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(file: string, args: string[], options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  }): NodePtyProcess;
}

export type HcPtyLoader = () => Promise<NodePtyModule | null>;

export interface HcPtyManagerOptions {
  workspaceDir: string;
  /** Extra directories a PTY cwd may live in (e.g. extension dirs). */
  allowedDirs?: string[];
  limits?: Partial<HcPtyLimits>;
  loadPty?: HcPtyLoader;
  onEvent?: (event: HcTerminalRuntimeEvent) => void;
  killImpl?: (pid: number, signal: NodeJS.Signals) => Promise<boolean>;
  now?: () => Date;
  /** Clamp limits to global spec caps (default true; tests may disable). */
  enforceLimitCaps?: boolean;
}

export interface HcPtyCreateInput {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  label?: string;
  profileId?: string;
  /** Additional roots the cwd may live in (from the manifest terminal profile). */
  allowedDirs?: string[];
}

export interface HcPtySessionSnapshot {
  sessionId: string;
  profileId?: string;
  label?: string;
  cols: number;
  rows: number;
  cwd: string;
  command: string[];
  state: HcTerminalSessionState;
  pid: number | null;
  createdAt: string;
  exitCode?: number | null;
  seq: number;
  bufferedBytes: number;
}

export interface HcPtyBuffer {
  data: string;
  base64: string;
  seq: number;
  bytes: number;
  dropped: number;
}

interface InputBucket {
  tokens: number;
  lastRefill: number;
}

interface ManagedPty {
  sessionId: string;
  proc: NodePtyProcess;
  cols: number;
  rows: number;
  cwd: string;
  command: string[];
  label?: string;
  profileId?: string;
  state: HcTerminalSessionState;
  exitCode: number | null;
  createdAt: string;
  seq: number;
  ring: ByteRing;
  bucket: InputBucket;
  exited: boolean;
}

const DEFAULT_LOADER: HcPtyLoader = async () => {
  try {
    const mod = (await import('node-pty')) as unknown as NodePtyModule & { default?: NodePtyModule };
    return mod.default ?? mod;
  } catch {
    return null;
  }
};

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

function clampDimension(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, numeric));
}

/**
 * PTY session manager. `probe()` (or `create()`) resolves the optional native
 * module; without node-pty every create call fails with `not_supported`.
 */
export class HcPtyManager {
  private readonly options: HcPtyManagerOptions;
  private readonly limits: HcPtyLimits;
  private readonly loader: HcPtyLoader;
  private readonly now: () => Date;
  private readonly killImpl: (pid: number, signal: NodeJS.Signals) => Promise<boolean>;
  private readonly sessions = new Map<string, ManagedPty>();
  private nodePty: NodePtyModule | null = null;
  private probed = false;
  private probePromise: Promise<boolean> | null = null;

  constructor(options: HcPtyManagerOptions) {
    this.options = options;
    this.limits = resolvePtyLimits(options.limits, { enforceCaps: options.enforceLimitCaps !== false });
    this.loader = options.loadPty ?? DEFAULT_LOADER;
    this.now = options.now ?? (() => new Date());
    this.killImpl = options.killImpl ?? ((pid, signal) => killProcessTree(pid, signal));
  }

  /** True once a successful probe loaded node-pty. */
  get available(): boolean {
    return this.nodePty !== null;
  }

  get probedOnce(): boolean {
    return this.probed;
  }

  /** One-time native module probe; concurrent callers share the same promise. */
  async probe(): Promise<boolean> {
    if (this.probed) return this.nodePty !== null;
    if (this.probePromise) return this.probePromise;
    this.probePromise = (async () => {
      this.nodePty = await this.loader().catch(() => null);
      this.probed = true;
      this.probePromise = null;
      return this.nodePty !== null;
    })();
    return this.probePromise;
  }

  async create(input: HcPtyCreateInput): Promise<HcPtySessionSnapshot> {
    await this.probe();
    if (!this.nodePty) throw new HcRuntimeError('not_supported', 'node-pty is not available on this host; terminal sessions are disabled');
    const command = this.validateCommand(input.command);
    const active = [...this.sessions.values()].filter(session => !session.exited).length;
    if (active >= this.limits.maxSessions) {
      throw new HcRuntimeError('limit_exceeded', 'Terminal session limit reached (' + this.limits.maxSessions + ')');
    }
    const cwd = this.resolveCwd(input.cwd, input.allowedDirs);
    const cols = clampDimension(input.cols, this.limits.minCols, this.limits.maxCols, 80);
    const rows = clampDimension(input.rows, this.limits.minRows, this.limits.maxRows, 24);
    const env = buildSandboxEnv({ literals: input.env });
    const sessionId = 'pty_' + randomUUID().replace(/-/gu, '').slice(0, 16);
    let proc: NodePtyProcess;
    try {
      proc = this.nodePty.spawn(command[0]!, command.slice(1), {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      });
    } catch (error) {
      throw new HcRuntimeError('sidecar_spawn_failed', 'Failed to spawn PTY ' + command[0] + ': ' + (error instanceof Error ? error.message : String(error)));
    }
    const managed: ManagedPty = {
      sessionId,
      proc,
      cols,
      rows,
      cwd,
      command,
      ...(input.label ? { label: input.label } : {}),
      ...(input.profileId ? { profileId: input.profileId } : {}),
      state: 'running',
      exitCode: null,
      createdAt: this.nowIso(),
      seq: 0,
      ring: new ByteRing(this.limits.ringBytes),
      bucket: { tokens: this.limits.inputBytesPerSecond, lastRefill: this.now().getTime() },
      exited: false,
    };
    proc.onData((data: string) => this.handleData(managed, data));
    proc.onExit(({ exitCode }) => this.handleExit(managed, exitCode));
    this.sessions.set(sessionId, managed);
    this.emit(managed, 'state', { state: 'running' });
    return this.snapshotOf(managed);
  }

  /** Feed base64-encoded raw bytes (Ctrl-C is just 0x03) into the session. */
  input(sessionId: string, base64: string): { accepted: number; seq: number } {
    const session = this.requireSession(sessionId);
    if (session.exited) throw new HcRuntimeError('invalid_params', 'Terminal session has exited');
    if (typeof base64 !== 'string' || base64.length === 0) throw new HcRuntimeError('invalid_params', 'data (base64) is required');
    if (!BASE64_PATTERN.test(base64)) throw new HcRuntimeError('invalid_params', 'data must be valid base64');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > this.limits.inputBytesPerSecond) {
      throw new HcRuntimeError('limit_exceeded', 'Single terminal input exceeds ' + this.limits.inputBytesPerSecond + ' bytes');
    }
    if (!this.consumeInputTokens(session, bytes.length)) {
      throw new HcRuntimeError('rate_limited', 'Terminal input rate limit exceeded (' + this.limits.inputBytesPerSecond + ' bytes/s)');
    }
    try {
      session.proc.write(bytes.toString('utf8'));
    } catch (error) {
      throw new HcRuntimeError('internal_error', 'Failed to write to PTY: ' + (error instanceof Error ? error.message : String(error)));
    }
    return { accepted: bytes.length, seq: session.seq };
  }

  resize(sessionId: string, cols: number, rows: number): HcPtySessionSnapshot {
    const session = this.requireSession(sessionId);
    if (session.exited) throw new HcRuntimeError('invalid_params', 'Terminal session has exited');
    const nextCols = clampDimension(cols, this.limits.minCols, this.limits.maxCols, session.cols);
    const nextRows = clampDimension(rows, this.limits.minRows, this.limits.maxRows, session.rows);
    try {
      session.proc.resize(nextCols, nextRows);
    } catch (error) {
      throw new HcRuntimeError('internal_error', 'Failed to resize PTY: ' + (error instanceof Error ? error.message : String(error)));
    }
    session.cols = nextCols;
    session.rows = nextRows;
    this.emit(session, 'state', { state: session.state });
    return this.snapshotOf(session);
  }

  /** Replay ring for reconnects (base64 of the last N bytes). */
  buffer(sessionId: string): HcPtyBuffer {
    const session = this.requireSession(sessionId);
    const bytes = session.ring.toBuffer();
    return {
      data: bytes.toString('utf8'),
      base64: bytes.toString('base64'),
      seq: session.seq,
      bytes: bytes.length,
      dropped: session.ring.dropped,
    };
  }

  /** Close a session and tree-kill its process. */
  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.state = 'closed';
    session.exited = true;
    try {
      session.proc.kill();
    } catch {
      /* ignore */
    }
    const pid = session.proc.pid;
    if (typeof pid === 'number' && pid > 0) {
      await this.killImpl(pid, 'SIGKILL').catch(() => false);
    }
    this.emit(session, 'state', { state: 'closed' });
    this.sessions.delete(sessionId);
  }

  list(): HcPtySessionSnapshot[] {
    return [...this.sessions.values()].map(session => this.snapshotOf(session));
  }

  get(sessionId: string): HcPtySessionSnapshot | null {
    const session = this.sessions.get(sessionId);
    return session ? this.snapshotOf(session) : null;
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map(id => this.close(id).catch(() => undefined)));
  }

  /** Availability + sessions for GET /api/runtime. */
  snapshot(): { available: boolean; probed: boolean; maxSessions: number; sessions: HcPtySessionSnapshot[] } {
    return {
      available: this.nodePty !== null,
      probed: this.probed,
      maxSessions: this.limits.maxSessions,
      sessions: this.list(),
    };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private validateCommand(command: unknown): string[] {
    if (!Array.isArray(command) || command.length === 0) throw new HcRuntimeError('invalid_params', 'command must be a non-empty argv array');
    const result: string[] = [];
    for (const arg of command) {
      if (typeof arg !== 'string') throw new HcRuntimeError('invalid_params', 'command arguments must be strings (no shell)');
      if (arg.includes('\u0000')) throw new HcRuntimeError('invalid_params', 'command arguments must not contain NUL bytes');
      result.push(arg);
    }
    return result;
  }

  private resolveCwd(requested: string | undefined, extraRoots: string[] | undefined): string {
    const roots = [path.resolve(this.options.workspaceDir), ...(this.options.allowedDirs ?? []), ...(extraRoots ?? [])].map(root => path.resolve(root));
    const candidate = requested?.trim() ? path.resolve(this.options.workspaceDir, requested) : roots[0]!;
    for (const root of roots) {
      if (isPathInside(root, candidate)) return candidate;
    }
    throw new HcRuntimeError('path_forbidden', 'Terminal working directory ' + JSON.stringify(requested ?? candidate) + ' is outside the allowed roots');
  }

  private consumeInputTokens(session: ManagedPty, bytes: number): boolean {
    const nowMs = this.now().getTime();
    const elapsed = Math.max(0, nowMs - session.bucket.lastRefill);
    session.bucket.tokens = Math.min(this.limits.inputBytesPerSecond, session.bucket.tokens + (elapsed * this.limits.inputBytesPerSecond) / 1000);
    session.bucket.lastRefill = nowMs;
    if (bytes > session.bucket.tokens) return false;
    session.bucket.tokens -= bytes;
    return true;
  }

  private handleData(session: ManagedPty, data: string): void {
    if (session.exited) return;
    session.ring.push(data);
    session.seq += 1;
    this.emit(session, 'data', { data: Buffer.from(data, 'utf8').toString('base64'), seq: session.seq });
  }

  private handleExit(session: ManagedPty, exitCode: number): void {
    if (session.exited) return;
    session.exited = true;
    session.state = 'exited';
    session.exitCode = exitCode;
    this.emit(session, 'exit', { code: exitCode });
    this.emit(session, 'state', { state: 'exited' });
  }

  private requireSession(sessionId: string): ManagedPty {
    if (typeof sessionId !== 'string' || !sessionId) throw new HcRuntimeError('invalid_params', 'sessionId is required');
    const session = this.sessions.get(sessionId);
    if (!session) throw new HcRuntimeError('terminal_not_found', 'Unknown terminal session ' + JSON.stringify(sessionId));
    return session;
  }

  private snapshotOf(session: ManagedPty): HcPtySessionSnapshot {
    return {
      sessionId: session.sessionId,
      ...(session.profileId ? { profileId: session.profileId } : {}),
      ...(session.label ? { label: session.label } : {}),
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      command: [...session.command],
      state: session.state,
      pid: session.exited ? null : session.proc.pid,
      createdAt: session.createdAt,
      ...(session.exitCode === null ? {} : { exitCode: session.exitCode }),
      seq: session.seq,
      bufferedBytes: session.ring.size,
    };
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private emit(session: ManagedPty, event: 'data' | 'exit' | 'state', payload: Record<string, unknown>): void {
    if (!this.options.onEvent) return;
    const runtimeEvent: HcTerminalRuntimeEvent = {
      kind: 'terminal',
      at: this.nowIso(),
      sessionId: session.sessionId,
      event,
      ...(typeof payload.seq === 'number' ? { seq: payload.seq } : {}),
      ...(typeof payload.data === 'string' ? { data: payload.data } : {}),
      ...(typeof payload.code === 'number' ? { code: payload.code } : {}),
      ...(typeof payload.state === 'string' ? { state: payload.state as HcTerminalSessionState } : {}),
      ...(session.label ? { label: session.label } : {}),
    };
    try {
      this.options.onEvent(runtimeEvent);
    } catch {
      /* listeners must never break the manager */
    }
  }
}
