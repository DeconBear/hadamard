// Host-side limits for sidecars, kernels and PTY sessions (SPEC-7.5, 8.4, 9.3).
//
// Every value has a spec default and a global hard cap: a manifest may lower a
// limit but never raise it above the cap. Tests (and future settings UI) can
// opt out of cap enforcement explicitly through `enforceCaps: false`; production
// callers must leave it on.
import type { HcSidecarLimitsDeclaration } from './protocol.js';

// ---------------------------------------------------------------------------
// Tiny bounded collections
// ---------------------------------------------------------------------------

/** Fixed-capacity ring buffer. Drop-oldest, tracks how many entries were lost. */
export class RingBuffer<T> {
  private readonly items: T[] = [];
  private droppedCount = 0;

  constructor(readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) throw new RangeError('RingBuffer capacity must be positive');
  }

  get size(): number {
    return this.items.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  push(item: T): void {
    this.items.push(item);
    while (this.items.length > this.capacity) {
      this.items.shift();
      this.droppedCount += 1;
    }
  }

  toArray(): T[] {
    return [...this.items];
  }

  last(): T | undefined {
    return this.items[this.items.length - 1];
  }

  clear(): void {
    this.items.length = 0;
    this.droppedCount = 0;
  }
}

/** Byte ring for PTY replay buffers; stores raw bytes, exposes a copy. */
export class ByteRing {
  private buffer: Buffer = Buffer.alloc(0);
  private droppedCount = 0;

  constructor(readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) throw new RangeError('ByteRing capacity must be positive');
  }

  get size(): number {
    return this.buffer.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  push(chunk: Buffer | Uint8Array | string): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length === 0) return;
    if (bytes.length >= this.capacity) {
      this.droppedCount += this.buffer.length + (bytes.length - this.capacity);
      this.buffer = Buffer.from(bytes.subarray(bytes.length - this.capacity));
      return;
    }
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length > this.capacity) {
      const overflow = this.buffer.length - this.capacity;
      this.buffer = this.buffer.subarray(overflow);
      this.droppedCount += overflow;
    }
  }

  toBuffer(): Buffer {
    return Buffer.from(this.buffer);
  }

  clear(): void {
    this.buffer = Buffer.alloc(0);
    this.droppedCount = 0;
  }
}

const TRUNCATION_MARKER = '…[truncated]';

export interface TruncatedText {
  text: string;
  truncated: boolean;
  bytes: number;
}

/** Cap a string by UTF-8 byte length without splitting a code point. */
export function truncateTextBytes(text: string, maxBytes: number, marker = TRUNCATION_MARKER): TruncatedText {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { text: '', truncated: bytes > 0, bytes: Math.min(bytes, 0) };
  if (bytes <= maxBytes) return { text, truncated: false, bytes };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return { text: text.slice(0, low) + marker, truncated: true, bytes };
}

/** Cap a single logical line (SPEC-7.5: 64 KB default, 256 KB cap). */
export function capLine(text: string, maxLineBytes: number): TruncatedText {
  return truncateTextBytes(text, maxLineBytes);
}

function clampDown(value: number | undefined, fallback: number, cap: number, enforceCaps: boolean): number {
  const resolved = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const positive = resolved > 0 ? resolved : fallback;
  return enforceCaps ? Math.min(positive, cap) : positive;
}

function pickNumber(value: number | undefined, fallback: number, cap: number, enforceCaps: boolean): number {
  return clampDown(value, fallback, cap, enforceCaps);
}

// ---------------------------------------------------------------------------
// Sidecar limits
// ---------------------------------------------------------------------------

export interface HcSidecarLimits {
  /** Per-request stdout collection cap. */
  maxStdoutBytes: number;
  /** Per-request stderr / log collection cap. */
  maxStderrBytes: number;
  /** Single line cap (stdout lines and log messages). */
  maxLineBytes: number;
  /** Per-artifact byte cap. */
  maxArtifactBytes: number;
  /** Concurrent in-flight requests per process. */
  maxConcurrentRequests: number;
  /** Concurrent sidecar processes per extension. */
  maxProcessesPerExtension: number;
  /** Frames buffered from stdout before pausing the pipe. */
  maxQueueEntries: number;
  /** Estimated bytes buffered from stdout before pausing the pipe. */
  maxQueueBytes: number;
  initializeTimeoutMs: number;
  requestTimeoutMs: number;
  shutdownGraceMs: number;
  killGraceMs: number;
  idleTimeoutMs: number;
  minIdleTimeoutMs: number;
  maxCrashes: number;
  crashBackoffMs: number[];
  auditRingEntries: number;
  logRingEntries: number;
  stderrTailBytes: number;
  maxDiagnostics: number;
}

export const SIDECAR_LIMIT_DEFAULTS: Readonly<HcSidecarLimits> = Object.freeze({
  maxStdoutBytes: 4 * 1024 * 1024,
  maxStderrBytes: 512 * 1024,
  maxLineBytes: 64 * 1024,
  maxArtifactBytes: 256 * 1024 * 1024,
  maxConcurrentRequests: 4,
  maxProcessesPerExtension: 2,
  maxQueueEntries: 64,
  maxQueueBytes: 1024 * 1024,
  initializeTimeoutMs: 15_000,
  requestTimeoutMs: 120_000,
  shutdownGraceMs: 5_000,
  killGraceMs: 5_000,
  idleTimeoutMs: 10 * 60_000,
  minIdleTimeoutMs: 30_000,
  maxCrashes: 3,
  crashBackoffMs: [1_000, 2_000, 4_000],
  auditRingEntries: 1_000,
  logRingEntries: 1_000,
  stderrTailBytes: 8 * 1024,
  maxDiagnostics: 50,
});

/** Global upper bounds; manifest values are clamped down to these (SPEC-7.5). */
export const SIDECAR_LIMIT_CAPS: Readonly<HcSidecarLimits> = Object.freeze({
  maxStdoutBytes: 32 * 1024 * 1024,
  maxStderrBytes: 4 * 1024 * 1024,
  maxLineBytes: 256 * 1024,
  maxArtifactBytes: 1024 * 1024 * 1024,
  maxConcurrentRequests: 8,
  maxProcessesPerExtension: 4,
  maxQueueEntries: 1024,
  maxQueueBytes: 16 * 1024 * 1024,
  initializeTimeoutMs: 120_000,
  requestTimeoutMs: 3_600_000,
  shutdownGraceMs: 30_000,
  killGraceMs: 30_000,
  idleTimeoutMs: 24 * 60 * 60_000,
  minIdleTimeoutMs: 30_000,
  maxCrashes: 10,
  crashBackoffMs: [60_000, 60_000, 60_000],
  auditRingEntries: 10_000,
  logRingEntries: 10_000,
  stderrTailBytes: 64 * 1024,
  maxDiagnostics: 500,
});

export interface HcLimitResolveOptions {
  /** Clamp values to the global caps (default true). Tests may disable. */
  enforceCaps?: boolean;
  /** Clamp idleTimeoutMs up to the spec minimum (default true, tied to enforceCaps unless set). */
  enforceIdleFloor?: boolean;
}

function resolveIdleTimeout(declared: number | undefined, fallback: number, floor: number, options: HcLimitResolveOptions): number {
  const raw = typeof declared === 'number' && Number.isFinite(declared) && declared > 0 ? declared : fallback;
  const enforce = options.enforceIdleFloor ?? options.enforceCaps !== false;
  return enforce ? Math.max(floor, Math.min(raw, SIDECAR_LIMIT_CAPS.idleTimeoutMs)) : raw;
}

/**
 * Merge manifest `limits` and host overrides over the spec defaults, clamping
 * down to the global caps. Never allows a manifest to raise a cap.
 */
export function resolveSidecarLimits(
  declaration?: HcSidecarLimitsDeclaration,
  overrides?: Partial<HcSidecarLimits>,
  options: HcLimitResolveOptions = {},
): HcSidecarLimits {
  const enforceCaps = options.enforceCaps !== false;
  const defaults = SIDECAR_LIMIT_DEFAULTS;
  const caps = SIDECAR_LIMIT_CAPS;
  const pick = (key: keyof HcSidecarLimits, value: number | undefined): number =>
    pickNumber(value, defaults[key] as number, caps[key] as number, enforceCaps);
  const backoff = (overrides?.crashBackoffMs && overrides.crashBackoffMs.length > 0 ? overrides.crashBackoffMs : defaults.crashBackoffMs)
    .map(value => Math.max(0, Math.min(enforceCaps ? caps.crashBackoffMs[0]! : Number.MAX_SAFE_INTEGER, value)));
  return {
    maxStdoutBytes: pick('maxStdoutBytes', declaration?.maxStdoutBytes ?? overrides?.maxStdoutBytes),
    maxStderrBytes: pick('maxStderrBytes', declaration?.maxStderrBytes ?? overrides?.maxStderrBytes),
    maxLineBytes: pick('maxLineBytes', declaration?.maxLineBytes ?? overrides?.maxLineBytes),
    maxArtifactBytes: pick('maxArtifactBytes', declaration?.maxArtifactBytes ?? overrides?.maxArtifactBytes),
    maxConcurrentRequests: Math.max(1, Math.floor(pick('maxConcurrentRequests', declaration?.maxConcurrentRequests ?? overrides?.maxConcurrentRequests))),
    maxProcessesPerExtension: Math.max(1, Math.floor(pick('maxProcessesPerExtension', overrides?.maxProcessesPerExtension))),
    maxQueueEntries: Math.max(1, Math.floor(pick('maxQueueEntries', overrides?.maxQueueEntries))),
    maxQueueBytes: Math.max(1024, Math.floor(pick('maxQueueBytes', overrides?.maxQueueBytes))),
    initializeTimeoutMs: Math.max(1, Math.floor(pick('initializeTimeoutMs', overrides?.initializeTimeoutMs))),
    requestTimeoutMs: Math.max(0, Math.floor(pick('requestTimeoutMs', overrides?.requestTimeoutMs))),
    shutdownGraceMs: Math.max(0, Math.floor(pick('shutdownGraceMs', overrides?.shutdownGraceMs))),
    killGraceMs: Math.max(0, Math.floor(pick('killGraceMs', overrides?.killGraceMs))),
    idleTimeoutMs: resolveIdleTimeout(overrides?.idleTimeoutMs, defaults.idleTimeoutMs, defaults.minIdleTimeoutMs, options),
    minIdleTimeoutMs: defaults.minIdleTimeoutMs,
    maxCrashes: Math.max(0, Math.floor(
      typeof overrides?.maxCrashes === 'number' && Number.isFinite(overrides.maxCrashes)
        ? overrides.maxCrashes
        : pick('maxCrashes', undefined),
    )),
    crashBackoffMs: backoff,
    auditRingEntries: Math.max(1, Math.floor(pick('auditRingEntries', overrides?.auditRingEntries))),
    logRingEntries: Math.max(1, Math.floor(pick('logRingEntries', overrides?.logRingEntries))),
    stderrTailBytes: Math.max(1024, Math.floor(pick('stderrTailBytes', overrides?.stderrTailBytes))),
    maxDiagnostics: Math.max(1, Math.floor(pick('maxDiagnostics', overrides?.maxDiagnostics))),
  };
}

// ---------------------------------------------------------------------------
// Kernel limits (SPEC-8.4/8.5)
// ---------------------------------------------------------------------------

export interface HcKernelLimits {
  /** 0 = unlimited execution time (users stop manually). */
  executionTimeoutMs: number;
  /** kernel/interrupt → escalation grace (SPEC-8.5: 3 s). */
  interruptGraceMs: number;
  /** SIGINT fallback grace before kill+restart (SPEC-8.5: 5 s). */
  sigintGraceMs: number;
  killGraceMs: number;
  /** Total bytes retained per execution; further output is dropped + flagged. */
  maxOutputBytes: number;
  /** Single stream chunk forwarded to clients (SPEC-8.3: ≤64 KB). */
  maxStreamChunkBytes: number;
  /** Single MIME value cap (SPEC-8.4: 2 MB). */
  maxMimeValueBytes: number;
  /** text/html cap (SPEC-8.4: 256 KB). */
  maxHtmlBytes: number;
  /** application/json cap (SPEC-8.4: 1 MB). */
  maxJsonBytes: number;
  /** Max display_data bundles retained per execution. */
  maxDisplays: number;
  /** Automatic restarts after a crash (design doc §3.2: once). */
  maxCrashRestarts: number;
  restartDelayMs: number;
  shutdownGraceMs: number;
}

export const KERNEL_LIMIT_DEFAULTS: Readonly<HcKernelLimits> = Object.freeze({
  executionTimeoutMs: 0,
  interruptGraceMs: 3_000,
  sigintGraceMs: 5_000,
  killGraceMs: 5_000,
  maxOutputBytes: 8 * 1024 * 1024,
  maxStreamChunkBytes: 64 * 1024,
  maxMimeValueBytes: 2 * 1024 * 1024,
  maxHtmlBytes: 256 * 1024,
  maxJsonBytes: 1024 * 1024,
  maxDisplays: 100,
  maxCrashRestarts: 1,
  restartDelayMs: 250,
  shutdownGraceMs: 5_000,
});

export const KERNEL_LIMIT_CAPS: Readonly<HcKernelLimits> = Object.freeze({
  executionTimeoutMs: 24 * 60 * 60_000,
  interruptGraceMs: 30_000,
  sigintGraceMs: 60_000,
  killGraceMs: 60_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxStreamChunkBytes: 256 * 1024,
  maxMimeValueBytes: 16 * 1024 * 1024,
  maxHtmlBytes: 2 * 1024 * 1024,
  maxJsonBytes: 8 * 1024 * 1024,
  maxDisplays: 1_000,
  maxCrashRestarts: 3,
  restartDelayMs: 30_000,
  shutdownGraceMs: 60_000,
});

export function resolveKernelLimits(overrides?: Partial<HcKernelLimits>, options: HcLimitResolveOptions = {}): HcKernelLimits {
  const enforceCaps = options.enforceCaps !== false;
  const defaults = KERNEL_LIMIT_DEFAULTS;
  const caps = KERNEL_LIMIT_CAPS;
  const result = {} as Mutable<HcKernelLimits>;
  for (const key of Object.keys(defaults) as Array<keyof HcKernelLimits>) {
    const raw = overrides?.[key];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : (defaults[key] as number);
    const cap = caps[key] as number;
    // executionTimeoutMs 0 means unlimited and must stay 0.
    const positive = key === 'executionTimeoutMs' && value <= 0 ? 0 : Math.max(0, value);
    result[key] = enforceCaps ? Math.min(positive, cap) : positive;
  }
  return result;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// ---------------------------------------------------------------------------
// PTY limits (SPEC-9.3)
// ---------------------------------------------------------------------------

export interface HcPtyLimits {
  maxSessions: number;
  /** Replay ring per session (SPEC-9.3: 64 KiB). */
  ringBytes: number;
  /** Input rate limit per session (SPEC-9.2: 200 KB/s). */
  inputBytesPerSecond: number;
  minCols: number;
  maxCols: number;
  minRows: number;
  maxRows: number;
  killGraceMs: number;
}

export const PTY_LIMIT_DEFAULTS: Readonly<HcPtyLimits> = Object.freeze({
  maxSessions: 8,
  ringBytes: 64 * 1024,
  inputBytesPerSecond: 200 * 1024,
  minCols: 2,
  maxCols: 500,
  minRows: 1,
  maxRows: 300,
  killGraceMs: 3_000,
});

export const PTY_LIMIT_CAPS: Readonly<HcPtyLimits> = Object.freeze({
  maxSessions: 16,
  ringBytes: 1024 * 1024,
  inputBytesPerSecond: 4 * 1024 * 1024,
  minCols: 2,
  maxCols: 1000,
  minRows: 1,
  maxRows: 500,
  killGraceMs: 30_000,
});

export function resolvePtyLimits(overrides?: Partial<HcPtyLimits>, options: HcLimitResolveOptions = {}): HcPtyLimits {
  const enforceCaps = options.enforceCaps !== false;
  const defaults = PTY_LIMIT_DEFAULTS;
  const caps = PTY_LIMIT_CAPS;
  const resolve = (key: keyof HcPtyLimits): number => {
    const raw = overrides?.[key];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : (defaults[key] as number);
    return enforceCaps ? Math.min(Math.max(0, value), caps[key]) : Math.max(0, value);
  };
  return {
    maxSessions: Math.max(1, Math.floor(resolve('maxSessions'))),
    ringBytes: Math.max(1024, Math.floor(resolve('ringBytes'))),
    inputBytesPerSecond: Math.max(1024, Math.floor(resolve('inputBytesPerSecond'))),
    minCols: Math.max(1, Math.floor(resolve('minCols'))),
    maxCols: Math.max(2, Math.floor(resolve('maxCols'))),
    minRows: Math.max(1, Math.floor(resolve('minRows'))),
    maxRows: Math.max(2, Math.floor(resolve('maxRows'))),
    killGraceMs: Math.max(0, Math.floor(resolve('killGraceMs'))),
  };
}
