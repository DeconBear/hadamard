// Manifest-driven sidecar protocol types (SPEC-7), HKP kernel protocol types
// (SPEC-8), runtime event shapes shared by the broker / kernel manager / PTY
// manager, and the typed runtime error used across the Hcanvas server runtime.
//
// This module is dependency-free apart from the JSON-RPC id type; it must stay
// importable from tests and from client-adjacent adapters without pulling in
// node:child_process.
import type { JsonRpcId } from './jsonrpc.js';

// ---------------------------------------------------------------------------
// Runtime error surface (maps 1:1 onto SPEC-14 error codes)
// ---------------------------------------------------------------------------

export type HcRuntimeErrorCode =
  | 'invalid_params'
  | 'invalid_manifest'
  | 'unknown_reference'
  | 'consent_required'
  | 'trusted_required'
  | 'capability_denied'
  | 'path_forbidden'
  | 'sidecar_not_found'
  | 'sidecar_spawn_failed'
  | 'sidecar_crash'
  | 'sidecar_timeout'
  | 'kernel_not_found'
  | 'terminal_not_found'
  | 'kernel_busy'
  | 'kernel_crash'
  | 'execution_cancelled'
  | 'limit_exceeded'
  | 'rate_limited'
  | 'not_supported'
  | 'internal_error';

export const HC_RUNTIME_ERROR_STATUS: Readonly<Record<HcRuntimeErrorCode, number>> = {
  invalid_params: 400,
  invalid_manifest: 400,
  unknown_reference: 400,
  consent_required: 403,
  trusted_required: 403,
  capability_denied: 403,
  path_forbidden: 403,
  sidecar_not_found: 404,
  sidecar_spawn_failed: 500,
  sidecar_crash: 502,
  sidecar_timeout: 504,
  kernel_not_found: 404,
  terminal_not_found: 404,
  kernel_busy: 409,
  kernel_crash: 502,
  execution_cancelled: 409,
  limit_exceeded: 413,
  rate_limited: 429,
  not_supported: 501,
  internal_error: 500,
};

/** Typed error thrown by the server runtime; routes map it to HTTP + `code`. */
export class HcRuntimeError extends Error {
  readonly code: HcRuntimeErrorCode;
  readonly status: number;
  readonly detail?: unknown;

  constructor(code: HcRuntimeErrorCode, message: string, options: { detail?: unknown; status?: number } = {}) {
    super(message);
    this.name = 'HcRuntimeError';
    this.code = code;
    this.status = options.status ?? HC_RUNTIME_ERROR_STATUS[code] ?? 500;
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

export function isHcRuntimeError(value: unknown): value is HcRuntimeError {
  return value instanceof HcRuntimeError;
}

export function asHcRuntimeError(value: unknown, fallbackCode: HcRuntimeErrorCode = 'internal_error'): HcRuntimeError {
  if (value instanceof HcRuntimeError) return value;
  const message = value instanceof Error ? value.message : String(value);
  return new HcRuntimeError(fallbackCode, message);
}

// ---------------------------------------------------------------------------
// Protocol versions (SPEC-7.2, SPEC-8.2, SPEC-15)
// ---------------------------------------------------------------------------

export const SIDECAR_PROTOCOL_VERSION = '1.0';
export const HKP_PROTOCOL_VERSION = '1.0';
export const DEFAULT_SIDECAR_PROTOCOL_VERSION = SIDECAR_PROTOCOL_VERSION;

/** Major version of a dotted protocol version, or null when unparsable. */
export function protocolMajor(version: unknown): number | null {
  if (typeof version !== 'string') return null;
  const match = /^(\d+)(?:\.|$)/u.exec(version.trim());
  return match ? Number(match[1]) : null;
}

export function isCompatibleProtocolVersion(version: unknown, expected: string = SIDECAR_PROTOCOL_VERSION): boolean {
  const actualMajor = protocolMajor(version);
  const expectedMajor = protocolMajor(expected);
  return actualMajor !== null && expectedMajor !== null && actualMajor === expectedMajor;
}

// ---------------------------------------------------------------------------
// Manifest declarations (SPEC-2.4)
// ---------------------------------------------------------------------------

export type HcSidecarRole = 'service' | 'kernel';

/** `cwd` is either the symbolic 'extension' / 'workspace' root or a relative subdirectory. */
export type HcSidecarCwd = 'extension' | 'workspace' | (string & {});

export interface HcSidecarRequestDeclaration {
  method: string;
  timeoutMs?: number;
  progress?: boolean;
}

export interface HcSidecarLimitsDeclaration {
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxLineBytes?: number;
  maxArtifactBytes?: number;
  maxConcurrentRequests?: number;
}

export interface HcSidecarDeclaration {
  id: string;
  label?: string;
  /** argv array; argv[0] is the executable. Never interpolated into a shell. */
  command: string[];
  cwd?: HcSidecarCwd;
  env?: Record<string, string>;
  role?: HcSidecarRole;
  protocol?: 'jsonrpc-stdio';
  requests?: HcSidecarRequestDeclaration[];
  idleTimeoutMs?: number;
  outputChannel?: string;
  limits?: HcSidecarLimitsDeclaration;
}

/** A manifest sidecar resolved against its extension directory. */
export interface HcSidecarCatalogEntry {
  extensionId: string;
  extensionDir: string;
  declaration: HcSidecarDeclaration;
  enabled?: boolean;
  trusted?: boolean;
  /** Whether the user granted the process capability / manifest hash. */
  granted?: boolean;
}

/** Registry adapter injected into the broker; the registry module owns storage. */
export interface HcSidecarCatalogPort {
  resolveSidecar(sidecarId: string): Promise<HcSidecarCatalogEntry | null> | HcSidecarCatalogEntry | null;
  listSidecars?(): Promise<HcSidecarCatalogEntry[]> | HcSidecarCatalogEntry[];
}

export const SIDECAR_NOTIFY = {
  progress: '$/progress',
  cancel: '$/cancelRequest',
  output: 'output',
  log: 'log',
  artifact: 'artifact',
  initialized: 'initialized',
  shutdown: 'shutdown',
  exit: 'exit',
} as const;

/** Methods the host may call regardless of the manifest request whitelist. */
export const SIDECAR_RESERVED_METHODS: readonly string[] = [SIDECAR_NOTIFY.shutdown];
export const SIDECAR_HOST_INITIALIZE_METHOD = 'initialize';

export function findSidecarRequestDeclaration(
  declaration: HcSidecarDeclaration | undefined,
  method: string,
): HcSidecarRequestDeclaration | undefined {
  return declaration?.requests?.find(item => item.method === method);
}

export function isDeclaredSidecarMethod(declaration: HcSidecarDeclaration | undefined, method: string): boolean {
  if (SIDECAR_RESERVED_METHODS.includes(method)) return true;
  return Boolean(findSidecarRequestDeclaration(declaration, method));
}

// ---------------------------------------------------------------------------
// initialize handshake (SPEC-7.2)
// ---------------------------------------------------------------------------

export interface HcSidecarClientInfo {
  name: string;
  version: string;
}

export interface HcSidecarInitializeParams {
  protocolVersion: string;
  client: HcSidecarClientInfo;
  capabilities: Record<string, unknown>;
}

export interface HcSidecarRequestCapability {
  method: string;
  progress?: boolean;
}

export interface HcSidecarFeatureFlags {
  progress?: boolean;
  cancel?: boolean;
  artifacts?: boolean;
  [feature: string]: unknown;
}

export interface HcSidecarCapabilities {
  requests?: HcSidecarRequestCapability[];
  features?: HcSidecarFeatureFlags;
  [capability: string]: unknown;
}

export interface HcSidecarServerInfo {
  name: string;
  version?: string;
}

export interface HcSidecarInitializeResult {
  protocolVersion?: string;
  serverInfo?: HcSidecarServerInfo;
  capabilities?: HcSidecarCapabilities;
}

export interface NormalizedSidecarInitialize {
  protocolVersion: string;
  serverInfo: HcSidecarServerInfo;
  capabilities: Required<Pick<HcSidecarCapabilities, 'requests' | 'features'>>;
}

/**
 * Validate a sidecar initialize response against the manifest declaration and
 * merge server-advertised capabilities (never widen the manifest whitelist).
 */
export function normalizeSidecarInitializeResult(
  raw: unknown,
  declaration?: HcSidecarDeclaration,
): NormalizedSidecarInitialize {
  const value = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as HcSidecarInitializeResult;
  const version = typeof value.protocolVersion === 'string' ? value.protocolVersion : SIDECAR_PROTOCOL_VERSION;
  if (!isCompatibleProtocolVersion(version)) {
    throw new HcRuntimeError(
      'not_supported',
      'Sidecar protocol version ' + JSON.stringify(value.protocolVersion) + ' is incompatible with ' + SIDECAR_PROTOCOL_VERSION,
    );
  }
  const serverInfoRaw = (value.serverInfo && typeof value.serverInfo === 'object' ? value.serverInfo : {}) as HcSidecarServerInfo;
  const serverInfo: HcSidecarServerInfo = {
    name: typeof serverInfoRaw.name === 'string' && serverInfoRaw.name ? serverInfoRaw.name : declaration?.id ?? 'sidecar',
    ...(typeof serverInfoRaw.version === 'string' ? { version: serverInfoRaw.version } : {}),
  };
  const capabilitiesRaw = (value.capabilities && typeof value.capabilities === 'object' ? value.capabilities : {}) as HcSidecarCapabilities;
  const declared = new Set((declaration?.requests ?? []).map(item => item.method));
  const advertised: HcSidecarRequestCapability[] = [];
  for (const item of Array.isArray(capabilitiesRaw.requests) ? capabilitiesRaw.requests : []) {
    if (!item || typeof item !== 'object' || typeof item.method !== 'string') continue;
    // A sidecar may not advertise methods the manifest did not declare.
    if (declared.size > 0 && !declared.has(item.method)) continue;
    advertised.push({ method: item.method, ...(item.progress === true ? { progress: true } : {}) });
  }
  const features = (capabilitiesRaw.features && typeof capabilitiesRaw.features === 'object' ? capabilitiesRaw.features : {}) as HcSidecarFeatureFlags;
  return {
    protocolVersion: SIDECAR_PROTOCOL_VERSION,
    serverInfo,
    capabilities: {
      requests: advertised,
      features: {
        progress: features.progress === true,
        cancel: features.cancel === true,
        artifacts: features.artifacts === true,
        ...features,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Notifications from a sidecar (SPEC-7.3)
// ---------------------------------------------------------------------------

export type HcSidecarProgressKind = 'begin' | 'report' | 'end';

export interface HcSidecarProgressValue {
  kind: HcSidecarProgressKind;
  message?: string;
  percentage?: number;
}

export interface HcSidecarProgress {
  token: JsonRpcId;
  value: HcSidecarProgressValue;
}

export interface HcSidecarOutputChunk {
  requestId: JsonRpcId;
  stream: 'stdout' | 'stderr';
  seq: number;
  chunk: string;
}

export interface SidecarRequestOptions {
  timeoutMs?: number;
  onProgress?: (progress: HcSidecarProgress) => void;
}

/** Result of one sidecar service request, including collected output. */
export interface SidecarRequestOutcome {
  requestId: JsonRpcId;
  method: string;
  result: unknown;
  stdout: string;
  stderr: string;
  /** True when host caps (bytes/lines) truncated collected output. */
  truncated: boolean;
  artifacts: HcSidecarArtifactRef[];
  progressCount: number;
  durationMs: number;
}

export type SidecarNotificationListener = (method: string, params: unknown) => void;

export type HcSidecarLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface HcSidecarLogEntry {
  level: HcSidecarLogLevel;
  message: string;
  source?: string;
}

export interface HcSidecarArtifact {
  kind: 'artifact';
  path?: string;
  name: string;
  mime: string;
  size?: number;
  sha256?: string;
}

/** An artifact that passed host path validation; `path` is absolute. */
export interface HcSidecarArtifactRef extends HcSidecarArtifact {
  path: string;
  relativePath?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseSidecarProgress(params: unknown): HcSidecarProgress | null {
  const record = asRecord(params);
  if (!record) return null;
  const rawValue = asRecord(record.value);
  if (!rawValue) return null;
  const kind = rawValue.kind;
  if (kind !== 'begin' && kind !== 'report' && kind !== 'end') return null;
  const value: HcSidecarProgressValue = { kind };
  if (typeof rawValue.message === 'string') value.message = rawValue.message;
  if (typeof rawValue.percentage === 'number' && Number.isFinite(rawValue.percentage)) value.percentage = rawValue.percentage;
  return { token: record.token as JsonRpcId, value };
}

export function parseSidecarOutputChunk(params: unknown): HcSidecarOutputChunk | null {
  const record = asRecord(params);
  if (!record) return null;
  const requestId = record.requestId;
  if (typeof requestId !== 'string' && typeof requestId !== 'number') return null;
  const stream = record.stream === 'stderr' ? 'stderr' : record.stream === 'stdout' ? 'stdout' : null;
  if (!stream) return null;
  const seq = Number(record.seq);
  if (!Number.isFinite(seq) || seq < 0) return null;
  if (typeof record.chunk !== 'string') return null;
  return { requestId, stream, seq: Math.floor(seq), chunk: record.chunk };
}

export function parseSidecarLogEntry(params: unknown): HcSidecarLogEntry | null {
  const record = asRecord(params);
  if (!record) return null;
  if (typeof record.message !== 'string') return null;
  const level = record.level === 'warn' || record.level === 'error' || record.level === 'debug' ? record.level : 'info';
  return { level, message: record.message, ...(typeof record.source === 'string' ? { source: record.source } : {}) };
}

export function parseSidecarArtifact(value: unknown): HcSidecarArtifact | null {
  const record = asRecord(value);
  if (!record || record.kind !== 'artifact') return null;
  if (typeof record.name !== 'string' || !record.name) return null;
  if (typeof record.mime !== 'string' || !record.mime) return null;
  const artifact: HcSidecarArtifact = {
    kind: 'artifact',
    name: record.name,
    mime: record.mime,
    ...(typeof record.path === 'string' && record.path ? { path: record.path } : {}),
    ...(typeof record.size === 'number' && Number.isFinite(record.size) ? { size: record.size } : {}),
    ...(typeof record.sha256 === 'string' ? { sha256: record.sha256 } : {}),
  };
  return artifact;
}

/** Collect artifact descriptors embedded anywhere in a request result (depth ≤ 6). */
export function collectSidecarArtifacts(value: unknown, limit = 32): HcSidecarArtifact[] {
  const found: HcSidecarArtifact[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (found.length >= limit || depth > 6 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    if (record.kind === 'artifact') {
      const artifact = parseSidecarArtifact(record);
      if (artifact) found.push(artifact);
    }
    for (const child of Object.values(record)) {
      if (typeof child === 'object' && child !== null) visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return found;
}

// ---------------------------------------------------------------------------
// Sidecar lifecycle, diagnostics, audit, runtime events (SPEC-7.4/7.5/7.6)
// ---------------------------------------------------------------------------

export type HcSidecarLifecycleState =
  | 'declared'
  | 'starting'
  | 'initializing'
  | 'ready'
  | 'busy'
  | 'stopping'
  | 'stopped'
  | 'crashed'
  | 'restarting'
  | 'failed';

export interface HcRuntimeDiagnostic {
  code: string;
  message: string;
  at: string;
  detail?: string;
}

export type HcSidecarAuditKind =
  | 'spawn'
  | 'ready'
  | 'exit'
  | 'signal'
  | 'denied'
  | 'cancel'
  | 'limit'
  | 'crash'
  | 'stop'
  | 'request'
  | 'restart';

export interface HcSidecarAuditEvent {
  at: string;
  kind: HcSidecarAuditKind;
  extensionId: string;
  sidecarId: string;
  instanceKey?: string;
  requestId?: JsonRpcId;
  detail?: string;
}

export type HcSidecarEventName =
  | 'state'
  | 'ready'
  | 'log'
  | 'output'
  | 'progress'
  | 'artifact'
  | 'request'
  | 'notification'
  | 'diagnostic'
  | 'audit'
  | 'crash'
  | 'exit'
  | 'backpressure'
  | 'stderr';

export interface HcSidecarRuntimeEvent {
  kind: 'sidecar';
  at: string;
  /** Broker handle id (unique per process; kernel sessions use their session id). */
  handleId: string;
  sidecarId: string;
  instanceKey: string;
  extensionId: string;
  event: HcSidecarEventName;
  /** Flexible payload; see the broker for the per-event shape. */
  payload: Record<string, unknown>;
}

export interface HcSidecarSnapshot {
  sidecarId: string;
  extensionId: string;
  instanceKey: string;
  role: HcSidecarRole;
  state: HcSidecarLifecycleState;
  label?: string;
  command: string[];
  cwd: string;
  envKeys: string[];
  pid: number | null;
  startedAt?: string;
  readyAt?: string;
  lastActivityAt?: string;
  crashes: number;
  /** Request/stdio queue counters for diagnostics and backpressure. */
  queue: {
    pendingRequests: number;
    queuedFrames: number;
    paused: boolean;
  };
  serverInfo?: HcSidecarServerInfo;
  outputChannel?: string;
  diagnostics: HcRuntimeDiagnostic[];
  exitInfo?: { code: number | null; signal: string | null };
}

export interface HcAuditLogSnapshot {
  events: HcSidecarAuditEvent[];
  dropped: number;
}

// ---------------------------------------------------------------------------
// HKP (SPEC-8)
// ---------------------------------------------------------------------------

export type HkpScalar = string | number | boolean | null;
export type HkpMimeValue = HkpScalar | HkpMimeValue[] | { [key: string]: HkpMimeValue };
export type HkpMimeBundle = Record<string, HkpMimeValue>;

export interface HkpFeatures {
  execute?: boolean;
  interrupt?: boolean;
  complete?: boolean;
  inspect?: boolean;
}

export interface HkpInitializeResult {
  protocolVersion: string;
  language: string;
  languageVersion?: string;
  displayName?: string;
  features: HkpFeatures;
  mimeTypes: string[];
}

export const HKP_METHODS = {
  execute: 'kernel/execute',
  interrupt: 'kernel/interrupt',
  complete: 'kernel/complete',
  inspect: 'kernel/inspect',
  shutdown: 'kernel/shutdown',
} as const;

export const HKP_NOTIFICATIONS = {
  executionStarted: 'kernel/execution_started',
  stream: 'kernel/stream',
  displayData: 'kernel/display_data',
  executeResult: 'kernel/execute_result',
  error: 'kernel/error',
  executionFinished: 'kernel/execution_finished',
  status: 'kernel/status',
  log: 'log',
} as const;

/** Render priority from SPEC-8.4 (first match wins). */
export const HKP_MIME_PRIORITY: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'text/html',
  'application/json',
  'text/markdown',
  'text/plain',
  'application/vnd.hcanvas.error+json',
];

export function selectHkpMimeRepresentation(bundle: unknown): string | null {
  const record = asRecord(bundle);
  if (!record) return null;
  for (const mime of HKP_MIME_PRIORITY) {
    if (Object.prototype.hasOwnProperty.call(record, mime)) return mime;
  }
  return Object.keys(record)[0] ?? null;
}

/** Validate an HKP initialize result. Throws kernel_crash on incompatible payloads. */
export function normalizeHkpInitializeResult(raw: unknown): HkpInitializeResult {
  const value = asRecord(raw);
  if (!value) throw new HcRuntimeError('kernel_crash', 'Kernel initialize result must be an object');
  const version = typeof value.protocolVersion === 'string' ? value.protocolVersion : HKP_PROTOCOL_VERSION;
  if (!isCompatibleProtocolVersion(version, HKP_PROTOCOL_VERSION)) {
    throw new HcRuntimeError('not_supported', 'Kernel protocol version ' + JSON.stringify(value.protocolVersion) + ' is incompatible with ' + HKP_PROTOCOL_VERSION);
  }
  if (typeof value.language !== 'string' || !value.language) throw new HcRuntimeError('kernel_crash', 'Kernel initialize result is missing language');
  const featuresRaw = asRecord(value.features) ?? {};
  const features: HkpFeatures = {
    execute: featuresRaw.execute !== false,
    interrupt: featuresRaw.interrupt === true,
    complete: featuresRaw.complete === true,
    inspect: featuresRaw.inspect === true,
  };
  const mimeTypes = Array.isArray(value.mimeTypes)
    ? value.mimeTypes.filter((item): item is string => typeof item === 'string')
    : ['text/plain'];
  return {
    protocolVersion: HKP_PROTOCOL_VERSION,
    language: value.language,
    languageVersion: typeof value.languageVersion === 'string' ? value.languageVersion : undefined,
    displayName: typeof value.displayName === 'string' ? value.displayName : undefined,
    features,
    mimeTypes,
  };
}

export type HkpExecutionStatus = 'ok' | 'error' | 'aborted';

export interface HkpExecuteParams {
  executionId: string;
  code: string;
  cellId?: string;
  silent?: boolean;
}

export interface HkpExecuteResult {
  executionId?: string;
  status?: HkpExecutionStatus;
  durationMs?: number;
}

export interface HkpExecutionStartedParams {
  executionId: string;
  cellId?: string;
}

export interface HkpStreamParams {
  executionId: string;
  name: 'stdout' | 'stderr';
  text: string;
}

export interface HkpDisplayDataParams {
  executionId: string;
  data: HkpMimeBundle;
  metadata?: Record<string, unknown>;
}

export interface HkpExecuteResultParams {
  executionId: string;
  data: HkpMimeBundle;
}

export interface HkpErrorParams {
  executionId: string;
  ename: string;
  evalue: string;
  traceback: string[];
}

export interface HkpExecutionFinishedParams {
  executionId: string;
  status: HkpExecutionStatus | 'error' | 'aborted';
}

export interface HkpStatusParams {
  state: 'busy' | 'idle';
}

export type HkpNormalizedNotification =
  | { type: 'execution_started'; executionId: string; cellId?: string }
  | { type: 'stream'; executionId: string; name: 'stdout' | 'stderr'; text: string }
  | { type: 'display_data'; executionId: string; data: HkpMimeBundle; metadata?: Record<string, unknown> }
  | { type: 'execute_result'; executionId: string; data: HkpMimeBundle }
  | { type: 'error'; executionId: string; ename: string; evalue: string; traceback: string[] }
  | { type: 'execution_finished'; executionId: string; status: HkpExecutionStatus }
  | { type: 'status'; state: 'busy' | 'idle' }
  | { type: 'log'; level: HcSidecarLogLevel; message: string };

function requireExecutionId(record: Record<string, unknown>): string | null {
  return typeof record.executionId === 'string' && record.executionId ? record.executionId : null;
}

/** Normalize one kernel → host notification. Returns null for unknown methods. */
export function normalizeHkpNotification(method: string, params: unknown): HkpNormalizedNotification | null {
  if (method === HKP_NOTIFICATIONS.log) {
    const log = parseSidecarLogEntry(params);
    return log ? { type: 'log', level: log.level, message: log.message } : null;
  }
  const record = asRecord(params);
  if (!record) return null;
  const executionId = requireExecutionId(record);
  if (method === HKP_NOTIFICATIONS.executionStarted) {
    if (!executionId) return null;
    return { type: 'execution_started', executionId, ...(typeof record.cellId === 'string' ? { cellId: record.cellId } : {}) };
  }
  if (method === HKP_NOTIFICATIONS.stream) {
    if (!executionId || (record.name !== 'stdout' && record.name !== 'stderr') || typeof record.text !== 'string') return null;
    return { type: 'stream', executionId, name: record.name, text: record.text };
  }
  if (method === HKP_NOTIFICATIONS.displayData) {
    if (!executionId) return null;
    const data = asRecord(record.data);
    if (!data) return null;
    const metadata = asRecord(record.metadata);
    return { type: 'display_data', executionId, data: data as HkpMimeBundle, ...(metadata ? { metadata } : {}) };
  }
  if (method === HKP_NOTIFICATIONS.executeResult) {
    if (!executionId) return null;
    const data = asRecord(record.data);
    if (!data) return null;
    return { type: 'execute_result', executionId, data: data as HkpMimeBundle };
  }
  if (method === HKP_NOTIFICATIONS.error) {
    if (!executionId || typeof record.ename !== 'string') return null;
    const traceback = Array.isArray(record.traceback) ? record.traceback.filter((item): item is string => typeof item === 'string') : [];
    return { type: 'error', executionId, ename: record.ename, evalue: typeof record.evalue === 'string' ? record.evalue : '', traceback };
  }
  if (method === HKP_NOTIFICATIONS.executionFinished) {
    if (!executionId) return null;
    const status = record.status === 'error' ? 'error' : record.status === 'aborted' ? 'aborted' : 'ok';
    return { type: 'execution_finished', executionId, status };
  }
  if (method === HKP_NOTIFICATIONS.status) {
    return { type: 'status', state: record.state === 'busy' ? 'busy' : 'idle' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Kernel catalog / session / execution (SPEC-8.5, SPEC-8.6)
// ---------------------------------------------------------------------------

export type HcKernelScopeKind = 'document' | 'page' | 'file' | 'custom';

export interface HcKernelScope {
  kind: HcKernelScopeKind;
  key: string;
}

export interface HcKernelDescriptor {
  id: string;
  label?: string;
  language: string;
  languageVersion?: string;
  features?: string[];
  defaultFor?: string[];
}

export interface HcKernelCatalogEntry {
  kernel: HcKernelDescriptor;
  /** Resolved sidecar declaration with `role: 'kernel'`. */
  sidecar: HcSidecarCatalogEntry;
}

export interface HcKernelCatalogPort {
  resolveKernel(kernelId: string): Promise<HcKernelCatalogEntry | null> | HcKernelCatalogEntry | null;
  listKernels?(): Promise<HcKernelDescriptor[]> | HcKernelDescriptor[];
}

export type HcKernelSessionState = 'starting' | 'ready' | 'busy' | 'restarting' | 'dead';

export interface HcKernelSessionSnapshot {
  sessionId: string;
  kernelId: string;
  label?: string;
  language?: string;
  languageVersion?: string;
  displayName?: string;
  scope: HcKernelScope;
  state: HcKernelSessionState;
  pid: number | null;
  queued: number;
  activeExecutionId?: string;
  crashes: number;
  mimeTypes: string[];
  features?: HkpFeatures;
  createdAt: string;
  lastActivityAt?: string;
}

export interface HcKernelErrorOutput {
  ename: string;
  evalue: string;
  traceback: string[];
}

export type HcKernelOutputItem =
  | { type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { type: 'display_data'; data: HkpMimeBundle; metadata?: Record<string, unknown> }
  | { type: 'execute_result'; data: HkpMimeBundle }
  | { type: 'error'; error: HcKernelErrorOutput };

export interface HcKernelExecutionOutputs {
  events: HcKernelOutputItem[];
  truncated: boolean;
  totalBytes: number;
}

export type HcKernelExecutionStatus = 'ok' | 'error' | 'aborted' | 'cancelled';

export interface HcKernelExecutionResult {
  sessionId: string;
  executionId: string;
  status: HcKernelExecutionStatus;
  durationMs: number;
  outputs: HcKernelExecutionOutputs;
  error?: HcKernelErrorOutput;
}

export type HcKernelRuntimeEventName =
  | 'state'
  | 'execution_queued'
  | 'execution_started'
  | 'stream'
  | 'display_data'
  | 'execute_result'
  | 'error'
  | 'execution_finished'
  | 'execution_cancelled'
  | 'kernel_status'
  | 'log'
  | 'diagnostic';

export interface HcKernelRuntimeEvent {
  kind: 'kernel';
  at: string;
  sessionId: string;
  kernelId: string;
  executionId?: string;
  event: HcKernelRuntimeEventName;
  payload: Record<string, unknown>;
}

/** Terminal session state machine (SPEC-9). */
export type HcTerminalSessionState = 'starting' | 'running' | 'exited' | 'closed';

/** Terminal runtime events (SPEC-9.2); data is base64 to keep SSE JSON-safe. */
export interface HcTerminalRuntimeEvent {
  kind: 'terminal';
  at: string;
  sessionId: string;
  event: 'data' | 'exit' | 'state';
  seq?: number;
  data?: string;
  code?: number | null;
  state?: HcTerminalSessionState;
  label?: string;
}

export type HcRuntimeEventInput = HcSidecarRuntimeEvent | HcKernelRuntimeEvent | HcTerminalRuntimeEvent;
