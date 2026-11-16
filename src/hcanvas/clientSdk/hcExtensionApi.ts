/**
 * Hcanvas extension viewer SDK (viewer / extension side). Built standalone by
 * `scripts/build-hcanvas.mjs` into `dist/hcanvas/assets/hc-extension-api.js`
 * as a browser IIFE (global `HcanvasView`), served at
 * `/api/extension-sdk/hc-extension-api.js?v=1`.
 *
 * Protocol: plan/HCANVAS_EXTENSION_PLATFORM_SPEC_16Nov2026.md §5.5/§5.6/§5.7/§6.
 * Self-contained by contract: no imports, no bundler runtime, ES2020 output.
 * Usage: `const hc = await HcanvasView.acquire();`
 */

/** Viewer SDK version advertised to the host in the `host.ready` handshake. */
export const HC_VIEW_SDK_VERSION = '1.0.0';
/** Envelope protocol version (`hc` field). */
export const HC_PROTOCOL_VERSION = 1 as const;
/** Default per-request timeout; mirrors the host-side 30s request timeout. */
export const HC_REQUEST_TIMEOUT_MS = 30_000;
/** Handshake timeout (host must answer `host.ready` with `host.context`). */
export const HC_HANDSHAKE_TIMEOUT_MS = 10_000;

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

/** Context resolved by `HcanvasView.acquire()` (injected + handshake summary). */
export interface HcViewContext {
  instanceId: string;
  extensionId: string;
  viewId: string;
  surface: string;
  format: string;
  theme: string;
  locale: string;
  capabilities: string[];
  sdkUrl: string;
  /** Surface-specific context (file viewers receive the opened file). */
  file?: { rootId: string; path: string; readOnly?: boolean };
}

/** Wire error payload; host responses carry it in `error`. */
export interface HcViewErrorPayload {
  code: string;
  message: string;
  data?: unknown;
}

/** Error thrown by every failing SDK call. `code` is a §5.7 viewer code. */
export class HcViewError extends Error {
  readonly code: string;
  readonly data: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'HcViewError';
    this.code = code;
    this.data = data;
  }
}

/** Structural mirror of the host `HcOp` union (see `src/hcanvas/types.ts`). */
export type HcOp = { op: string; [key: string]: unknown };

/** Result of `document.read` (spec §5.6). */
export interface HcDocumentSnapshot {
  docId: string;
  pageId: string;
  blockId?: string;
  format: string;
  data: unknown;
  readOnly: boolean;
  revision?: number;
}

export interface HcApplyResult { revision: number; }

export interface HcFileReadResult {
  content: string;
  size: number;
  mtime: number;
  hash: string;
  encoding?: string;
}

export interface HcFileWriteOptions { encoding?: string; expectedHash?: string; }

export interface HcFileWriteResult { mtime: number; hash: string; }

export interface HcFileStat { size: number; mtime: number; hash: string; isFile: boolean; }

export interface HcAssetImportInput { name: string; mime: string; base64: string; }

export interface HcAssetImportResult { assetId: string; url: string; }

export interface HcCommandInfo { id: string; title: string; category?: string; }

export interface HcCommandList { commands: HcCommandInfo[]; }

export interface HcCaptureResult {
  dataUrl: string;
  width: number;
  height: number;
}

export interface HcNetworkRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
}

export interface HcNetworkResponse {
  status: number;
  headers: Record<string, string>;
  bodyBase64?: string;
}

export interface HcKernelInfo {
  id: string;
  label?: string;
  language?: string;
  state: string;
}

/** Kernel/sidecar session scope (spec §8.6). */
export interface HcKernelScope { kind: 'document' | 'page' | 'file' | 'custom' | string; key?: string; }

export interface HcKernelEnsureResult { sessionId: string; state: string; }

export interface HcKernelExecuteOptions { cellId?: string; silent?: boolean; }

export interface HcKernelListResult { kernels: HcKernelInfo[]; }

export type HcUnsubscribe = () => void;
export type HcEventHandler = (params: unknown) => void;

/**
 * Handle returned by `hc.sidecars.request(...)` (created synchronously).
 *
 * Wire contract with the host: `sidecars.request` replies
 * `{requestId}`; runtime output is forwarded to the viewer as
 * `{hc:1,kind:'event',method:'sidecar.event',params:{requestId,event,...}}`
 * where `event` is `progress | output | log | result | error`.
 * The SDK also accepts legacy per-event methods (`sidecar.progress`, ...).
 */
export interface HcSidecarJob {
  /** Local job id, stable before the host assigns `requestId`. */
  readonly id: string;
  /** Host-side request id once `sidecars.request` has been acknowledged. */
  readonly requestId: string | null;
  onProgress(handler: (progress: unknown) => void): HcUnsubscribe;
  onOutput(handler: (chunk: unknown) => void): HcUnsubscribe;
  on(event: string, handler: (payload: unknown) => void): HcUnsubscribe;
  /** Resolves with the sidecar result; rejects with `HcViewError`. */
  readonly done: Promise<unknown>;
  cancel(): Promise<void>;
}

/** The API object resolved by `HcanvasView.acquire()`. */
export interface HcViewApi {
  readonly sdkVersion: string;
  readonly context: HcViewContext;
  readonly disposed: boolean;
  ping(): Promise<{ pong: true }>;
  document: {
    read(): Promise<HcDocumentSnapshot>;
    apply(ops: HcOp[]): Promise<HcApplyResult>;
  };
  files: {
    read(rootId: string, path: string, encoding?: string): Promise<HcFileReadResult>;
    write(rootId: string, path: string, content: string, options?: string | HcFileWriteOptions): Promise<HcFileWriteResult>;
    stat(rootId: string, path: string): Promise<HcFileStat>;
  };
  assets: {
    import(nameOrInput: HcAssetImportInput | string, mime?: string, base64?: string): Promise<HcAssetImportResult>;
  };
  commands: {
    list(when?: string): Promise<HcCommandList>;
    execute(id: string, args?: unknown): Promise<{ ok: true }>;
  };
  config: {
    get(key: string): Promise<{ value: unknown }>;
    set(key: string, value: unknown): Promise<{ ok: true }>;
  };
  ui: {
    toast(message: string, kind?: string): Promise<{ ok: true }>;
    setTitle(title: string): Promise<{ ok: true }>;
    openView(viewId: string): Promise<{ ok: true }>;
    closeSelf(): Promise<{ ok: true }>;
    openExternal(url: string): Promise<{ ok: true }>;
    capture(maxWidth?: number, maxHeight?: number, format?: 'png'): Promise<HcCaptureResult>;
  };
  network: {
    fetch(input: string | HcNetworkRequest): Promise<HcNetworkResponse>;
  };
  state: {
    get(key?: string): Promise<{ value: unknown }>;
    set(key: string, value: unknown): Promise<{ ok: true }>;
  };
  events: {
    on(event: string, handler: HcEventHandler): HcUnsubscribe;
    off(event: string, handler: HcEventHandler): void;
    subscribe(events: string[]): Promise<{ ok: true }>;
  };
  sidecars: {
    request(sidecarId: string, method: string, params?: unknown, timeoutMs?: number): HcSidecarJob;
  };
  kernels: {
    list(): Promise<HcKernelListResult>;
    ensure(kernelId: string, scope: HcKernelScope): Promise<HcKernelEnsureResult>;
    execute(sessionId: string, code: string, options?: HcKernelExecuteOptions): Promise<{ executionId: string }>;
    interrupt(sessionId: string, executionId?: string): Promise<{ ok: true }>;
    restart(sessionId: string): Promise<{ sessionId: string }>;
    dispose(sessionId: string): Promise<{ ok: true }>;
    onEvent(handler: (event: unknown) => void): HcUnsubscribe;
  };
}

/* ------------------------------------------------------------------ */
/* Envelopes (spec §5.5)                                               */
/* ------------------------------------------------------------------ */

interface HcViewRequestEnvelope {
  hc: 1; kind: 'request'; id: string; token: string; method: string; params?: unknown;
}
export interface HcViewResponseEnvelope {
  hc: 1; kind: 'response'; id: string; result?: unknown; error?: HcViewErrorPayload;
}
export interface HcViewEventEnvelope {
  hc: 1; kind: 'event'; method: string; params?: unknown;
}
interface InjectedViewContext {
  instanceId: string; extensionId: string; viewId: string; surface: string; format: string;
  theme: string; locale: string; token: string; sdkUrl: string;
}

/* ------------------------------------------------------------------ */
/* Module state                                                        */
/* ------------------------------------------------------------------ */

const HC_WINDOW: Window | null = typeof window === 'undefined' ? null : window;
const DEFAULT_THEME = 'light';
const DEFAULT_LOCALE = 'en';

let injectedContext: InjectedViewContext | null = null;
let injectedError: HcViewError | null = null;
let handshakePromise: Promise<HcViewContext> | null = null;
let handshakeResolve: ((context: HcViewContext) => void) | null = null;
let handshakeReject: ((error: HcViewError) => void) | null = null;
let handshakeTimeout: ReturnType<typeof setTimeout> | null = null;
let handshakeRetry: ReturnType<typeof setInterval> | null = null;
let readyRequestId: string | null = null;
let acquirePromise: Promise<HcViewApi> | null = null;
let apiInstance: HcViewApi | null = null;
let disposed = false;
let requestSequence = 0;
let sidecarSequence = 0;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: HcViewError) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

const pendingRequests = new Map<string, PendingRequest>();
const eventListeners = new Map<string, Set<HcEventHandler>>();
const kernelEventListeners = new Set<(event: unknown) => void>();
const sidecarJobs = new Map<string, SidecarJobController>();
const openSidecarJobs = new Set<SidecarJobController>();
const subscribedEvents = new Set<string>();

interface SidecarJobController {
  job: HcSidecarJob;
  attach(requestId: string): void;
  deliverPush(event: string, params: Record<string, unknown>): void;
  fail(error: HcViewError): void;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  const text = asString(value);
  return text && text.trim() ? text : undefined;
}

function toHcViewError(error: unknown): HcViewError {
  if (error instanceof HcViewError) return error;
  if (error instanceof Error) return new HcViewError('internal_error', error.message || 'Hcanvas viewer SDK error.');
  return new HcViewError('internal_error', typeof error === 'string' ? error : 'Hcanvas viewer SDK error.');
}

function newRequestId(): string {
  requestSequence += 1;
  return 'hc-' + requestSequence.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function parseErrorPayload(value: unknown): HcViewErrorPayload | null {
  if (!isRecord(value)) return null;
  const code = asString(value.code) || 'internal_error';
  const message = asString(value.message) || 'The Hcanvas host rejected the request.';
  return value.data === undefined ? { code, message } : { code, message, data: value.data };
}

function safeInvoke(handler: (payload: unknown) => void, payload: unknown): void {
  try {
    handler(payload);
  } catch (error) {
    console.error('[hcanvas:viewer-sdk] event handler failed', error);
  }
}

function postToHost(envelope: HcViewRequestEnvelope): boolean {
  if (!HC_WINDOW) return false;
  try {
    HC_WINDOW.parent.postMessage(envelope, '*');
    return true;
  } catch (error) {
    console.warn('[hcanvas:viewer-sdk] postMessage to host failed', error);
    return false;
  }
}

function requireInjected(): InjectedViewContext {
  if (!injectedContext) throw new HcViewError('internal_error', 'Hcanvas viewer context is missing; call HcanvasView.acquire() first.');
  return injectedContext;
}

/* ------------------------------------------------------------------ */
/* Handshake (host.ready -> host.context)                              */
/* ------------------------------------------------------------------ */

function readInjectedContext(): void {
  if (!HC_WINDOW) {
    injectedError = new HcViewError('internal_error', 'HcanvasView requires a browser window.');
    return;
  }
  const raw = (HC_WINDOW as unknown as { hcViewContext?: unknown }).hcViewContext;
  if (!isRecord(raw)) {
    injectedError = new HcViewError('invalid_params', 'window.hcViewContext is missing; this HTML must be served by the Hcanvas extension view host.');
    return;
  }
  const missing: string[] = [];
  const instanceId = asNonEmptyString(raw.instanceId);
  const extensionId = asNonEmptyString(raw.extensionId);
  const viewId = asNonEmptyString(raw.viewId);
  const token = asNonEmptyString(raw.token);
  if (!instanceId) missing.push('instanceId');
  if (!extensionId) missing.push('extensionId');
  if (!viewId) missing.push('viewId');
  if (!token) missing.push('token');
  if (missing.length || !instanceId || !extensionId || !viewId || !token) {
    injectedError = new HcViewError('invalid_params', 'window.hcViewContext is missing required field(s): ' + missing.join(', ') + '.');
    return;
  }
  injectedContext = {
    instanceId,
    extensionId,
    viewId,
    token,
    surface: asString(raw.surface) || 'tab',
    format: asString(raw.format) || '',
    theme: asString(raw.theme) || DEFAULT_THEME,
    locale: asString(raw.locale) || DEFAULT_LOCALE,
    sdkUrl: asString(raw.sdkUrl) || '',
  };
}

function clearHandshakeTimers(): void {
  if (handshakeTimeout !== null) {
    clearTimeout(handshakeTimeout);
    handshakeTimeout = null;
  }
  if (handshakeRetry !== null) {
    clearInterval(handshakeRetry);
    handshakeRetry = null;
  }
}

function sendReadyRequest(): void {
  if (disposed || !injectedContext || !readyRequestId) return;
  postToHost({
    hc: HC_PROTOCOL_VERSION,
    kind: 'request',
    id: readyRequestId,
    token: injectedContext.token,
    method: 'host.ready',
    params: { sdkVersion: HC_VIEW_SDK_VERSION },
  });
}

function failHandshake(error: HcViewError): void {
  clearHandshakeTimers();
  readyRequestId = null;
  const reject = handshakeReject;
  handshakeResolve = null;
  handshakeReject = null;
  reject?.(error);
}

function buildViewContext(result: Record<string, unknown>): HcViewContext {
  const injected = requireInjected();
  const capabilities = Array.isArray(result.capabilities)
    ? result.capabilities.filter((item): item is string => typeof item === 'string')
    : [];
  const supplied = isRecord(result.context) ? result.context : {};
  const file = isRecord(supplied.file) && typeof supplied.file.rootId === 'string' && typeof supplied.file.path === 'string'
    ? { rootId: supplied.file.rootId, path: supplied.file.path, readOnly: supplied.file.readOnly === true }
    : undefined;
  return {
    instanceId: injected.instanceId,
    extensionId: injected.extensionId,
    viewId: injected.viewId,
    surface: asString(result.surface) || injected.surface,
    format: asString(result.format) || injected.format,
    theme: asString(result.theme) || injected.theme,
    locale: asString(result.locale) || injected.locale,
    capabilities,
    sdkUrl: injected.sdkUrl,
    ...(file ? { file } : {}),
  };
}

function settleHandshake(result: unknown, error: HcViewErrorPayload | null): void {
  if (!handshakeResolve && !handshakeReject) return;
  clearHandshakeTimers();
  readyRequestId = null;
  if (error) {
    failHandshake(new HcViewError(error.code, error.message, error.data));
    return;
  }
  if (!isRecord(result)) {
    failHandshake(new HcViewError('invalid_params', 'The host.context handshake response is malformed.'));
    return;
  }
  const context = buildViewContext(result);
  const resolve = handshakeResolve;
  handshakeResolve = null;
  handshakeReject = null;
  resolve?.(context);
}

function startHandshake(): void {
  if (handshakePromise) return;
  readInjectedContext();
  if (injectedError) {
    const failure = injectedError;
    handshakePromise = Promise.reject(failure);
    handshakePromise.catch(() => { /* surfaced by acquire() */ });
    return;
  }
  handshakePromise = new Promise<HcViewContext>((resolve, reject) => {
    handshakeResolve = resolve;
    handshakeReject = reject;
  });
  handshakePromise.catch(() => { /* surfaced by acquire() */ });
  readyRequestId = newRequestId();
  sendReadyRequest();
  handshakeRetry = setInterval(sendReadyRequest, 500);
  handshakeTimeout = setTimeout(() => {
    failHandshake(new HcViewError('internal_error', 'Viewer handshake timed out after ' + HC_HANDSHAKE_TIMEOUT_MS + 'ms waiting for host.context.'));
  }, HC_HANDSHAKE_TIMEOUT_MS);
}

/* ------------------------------------------------------------------ */
/* Incoming messages                                                   */
/* ------------------------------------------------------------------ */

function handleResponse(data: Record<string, unknown>): void {
  const id = asString(data.id);
  if (!id) return;
  const error = parseErrorPayload(data.error);
  const result = data.result;
  if (readyRequestId !== null && id === readyRequestId) {
    settleHandshake(result, error);
    return;
  }
  const entry = pendingRequests.get(id);
  if (!entry) return;
  pendingRequests.delete(id);
  clearTimeout(entry.timer);
  if (error) {
    entry.reject(new HcViewError(error.code, error.message, error.data));
    return;
  }
  entry.resolve(result);
}

function dispatchSidecarEvent(method: string, params: unknown): void {
  if (!isRecord(params)) return;
  const requestId = asString(params.requestId) || asString(params.id);
  if (!requestId) return;
  const controller = sidecarJobs.get(requestId);
  if (!controller) return;
  const event = asString(params.event) || asString(params.type) || (method.startsWith('sidecar.') ? method.slice('sidecar.'.length) : 'event');
  controller.deliverPush(event, params);
}

function kernelEventPayload(method: string, params: unknown): unknown {
  if (method === 'kernel.event') return params;
  const type = method.startsWith('kernel.') ? method.slice('kernel.'.length) : method;
  if (isRecord(params)) return { ...params, event: asString(params.event) || type, type };
  return { event: type, params };
}

function dispatchKernelEvent(method: string, params: unknown): void {
  const payload = kernelEventPayload(method, params);
  for (const handler of [...kernelEventListeners]) safeInvoke(handler, payload);
}

function handleEvent(data: Record<string, unknown>): void {
  const method = asString(data.method);
  if (!method) return;
  const params = data.params;
  if (method === 'sidecar.event' || method.startsWith('sidecar.')) {
    dispatchSidecarEvent(method, params);
  } else if (method === 'kernel.event' || method.startsWith('kernel.')) {
    dispatchKernelEvent(method, params);
  }
  const handlers = eventListeners.get(method);
  if (handlers) for (const handler of [...handlers]) safeInvoke(handler, params);
  const wildcard = eventListeners.get('*');
  if (wildcard) for (const handler of [...wildcard]) safeInvoke(handler, params);
  if (method === 'host.dispose') markDisposed();
}

function markDisposed(): void {
  if (disposed) return;
  disposed = true;
  const error = new HcViewError('internal_error', 'The Hcanvas host disposed this viewer.');
  for (const entry of pendingRequests.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pendingRequests.clear();
  for (const controller of [...openSidecarJobs]) {
    controller.fail(new HcViewError('execution_cancelled', 'Sidecar request cancelled: viewer disposed.'));
  }
  openSidecarJobs.clear();
  sidecarJobs.clear();
  kernelEventListeners.clear();
  if (handshakeResolve || handshakeReject) failHandshake(error);
}

function onWindowMessage(event: MessageEvent): void {
  if (!HC_WINDOW || event.source !== HC_WINDOW.parent) return;
  const data: unknown = event.data;
  if (!isRecord(data) || data.hc !== HC_PROTOCOL_VERSION) return;
  if (data.kind === 'response') {
    handleResponse(data);
  } else if (data.kind === 'event') {
    handleEvent(data);
  }
}

/* ------------------------------------------------------------------ */
/* Core request                                                        */
/* ------------------------------------------------------------------ */

function request<T>(method: string, params?: unknown, timeoutMs: number = HC_REQUEST_TIMEOUT_MS): Promise<T> {
  if (disposed) return Promise.reject(new HcViewError('internal_error', 'The Hcanvas host disposed this viewer.'));
  const injected = requireInjected();
  const id = newRequestId();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new HcViewError('internal_error', 'Viewer request "' + method + '" timed out after ' + timeoutMs + 'ms.', { method, timeoutMs }));
    }, timeoutMs);
    pendingRequests.set(id, { resolve: value => resolve(value as T), reject, timer, method });
    const envelope: HcViewRequestEnvelope = {
      hc: HC_PROTOCOL_VERSION,
      kind: 'request',
      id,
      token: injected.token,
      method,
    };
    if (params !== undefined) envelope.params = params;
    if (!postToHost(envelope)) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(new HcViewError('internal_error', 'Unable to post a message to the Hcanvas host.'));
    }
  });
}

function scheduleSubscribe(events: string[]): void {
  let changed = false;
  for (const event of events) {
    if (!event || event === '*' || subscribedEvents.has(event)) continue;
    subscribedEvents.add(event);
    changed = true;
  }
  if (!changed) return;
  void request<{ ok: true }>('events.subscribe', { events: [...subscribedEvents] }).catch(() => {
    /* Subscription is an optimization; hosts may forward events without it. */
  });
}

function onEvent(event: string, handler: HcEventHandler): HcUnsubscribe {
  const name = event || '*';
  let handlers = eventListeners.get(name);
  if (!handlers) {
    handlers = new Set<HcEventHandler>();
    eventListeners.set(name, handlers);
  }
  handlers.add(handler);
  scheduleSubscribe([name]);
  return () => {
    const current = eventListeners.get(name);
    current?.delete(handler);
  };
}

function offEvent(event: string, handler: HcEventHandler): void {
  eventListeners.get(event)?.delete(handler);
}

function kernelsOnEvent(handler: (event: unknown) => void): HcUnsubscribe {
  kernelEventListeners.add(handler);
  scheduleSubscribe(['kernel.event']);
  return () => {
    kernelEventListeners.delete(handler);
  };
}

/* ------------------------------------------------------------------ */
/* Sidecar jobs                                                        */
/* ------------------------------------------------------------------ */

function createSidecarJob(sidecarId: string, method: string, params: unknown, timeoutMs: number | undefined): HcSidecarJob {
  sidecarSequence += 1;
  const localId = 'sidecar-' + sidecarSequence.toString(36);
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let requestId: string | null = null;
  let settled = false;
  let cancelled = false;
  let resolveDone: (value: unknown) => void = () => undefined;
  let rejectDone: (reason: unknown) => void = () => undefined;
  const done = new Promise<unknown>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  done.catch(() => { /* surfaced through job.done; keeps console clean when unused */ });

  function subscribe(event: string, handler: (payload: unknown) => void): HcUnsubscribe {
    let handlers = listeners.get(event);
    if (!handlers) {
      handlers = new Set<(payload: unknown) => void>();
      listeners.set(event, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  function emit(event: string, payload: unknown): void {
    const handlers = listeners.get(event);
    if (handlers) for (const handler of [...handlers]) safeInvoke(handler, payload);
  }

  function cleanup(): void {
    openSidecarJobs.delete(controller);
    if (requestId) sidecarJobs.delete(requestId);
    listeners.clear();
  }

  function settle(value: unknown): void {
    if (settled) return;
    settled = true;
    cleanup();
    resolveDone(value);
  }

  function fail(error: HcViewError): void {
    if (settled) return;
    settled = true;
    cleanup();
    rejectDone(error);
  }

  const job: HcSidecarJob = {
    id: localId,
    get requestId() {
      return requestId;
    },
    onProgress(handler) {
      return subscribe('progress', handler);
    },
    onOutput(handler) {
      return subscribe('output', handler);
    },
    on: subscribe,
    done,
    async cancel() {
      if (settled) return;
      cancelled = true;
      fail(new HcViewError('execution_cancelled', 'Sidecar request cancelled.'));
      if (requestId) {
        try {
          await request('sidecars.cancel', { requestId });
        } catch {
          /* best effort */
        }
      }
    },
  };

  const controller: SidecarJobController = {
    job,
    attach(id: string) {
      requestId = id;
      sidecarJobs.set(id, controller);
      scheduleSubscribe(['sidecar.event']);
      if (cancelled) {
        void request('sidecars.cancel', { requestId: id }).catch(() => { /* best effort */ });
      }
    },
    deliverPush(event: string, pushParams: Record<string, unknown>) {
      if (settled) return;
      if (event === 'progress') {
        emit('progress', pushParams.progress ?? pushParams.value ?? pushParams);
        return;
      }
      if (event === 'output') {
        emit('output', pushParams.chunk ?? pushParams.text ?? pushParams.data ?? pushParams);
        return;
      }
      if (event === 'log') {
        emit('log', pushParams);
        return;
      }
      if (event === 'result') {
        settle(pushParams.result ?? pushParams.data ?? pushParams);
        return;
      }
      if (event === 'error') {
        const payload = parseErrorPayload(pushParams.error) ?? parseErrorPayload(pushParams);
        fail(payload ? new HcViewError(payload.code, payload.message, payload.data) : new HcViewError('internal_error', 'Sidecar request failed.'));
        return;
      }
      emit(event, pushParams);
    },
    fail,
  };
  openSidecarJobs.add(controller);

  if (!sidecarId || !method) {
    fail(new HcViewError('invalid_params', 'sidecars.request requires a sidecarId and a method.'));
    return job;
  }

  void (async () => {
    try {
      const result = await request<{ requestId: string }>(
        'sidecars.request',
        { sidecarId, method, params, timeoutMs },
        Math.max(HC_REQUEST_TIMEOUT_MS, (timeoutMs ?? 0) + 5_000),
      );
      const id = isRecord(result) ? asString(result.requestId) : undefined;
      if (!id) {
        fail(new HcViewError('internal_error', 'The host did not return a sidecar requestId.'));
        return;
      }
      controller.attach(id);
    } catch (error) {
      fail(toHcViewError(error));
    }
  })();

  return job;
}

/* ------------------------------------------------------------------ */
/* API surface                                                         */
/* ------------------------------------------------------------------ */

function createApi(context: HcViewContext): HcViewApi {
  return {
    sdkVersion: HC_VIEW_SDK_VERSION,
    context,
    get disposed() {
      return disposed;
    },
    ping() {
      return request<{ pong: true }>('host.ping', {});
    },
    document: {
      read() {
        return request<HcDocumentSnapshot>('document.read', {});
      },
      apply(ops) {
        if (!Array.isArray(ops)) {
          return Promise.reject(new HcViewError('invalid_params', 'document.apply(ops) expects an array of HcOp objects.'));
        }
        return request<HcApplyResult>('document.apply', { ops });
      },
    },
    files: {
      read(rootId, path, encoding) {
        const params: Record<string, unknown> = { rootId, path };
        if (encoding !== undefined) params.encoding = encoding;
        return request<HcFileReadResult>('file.read', params);
      },
      write(rootId, path, content, options) {
        const params: Record<string, unknown> = { rootId, path, content };
        if (typeof options === 'string') {
          params.encoding = options;
        } else if (options) {
          if (options.encoding !== undefined) params.encoding = options.encoding;
          if (options.expectedHash !== undefined) params.expectedHash = options.expectedHash;
        }
        return request<HcFileWriteResult>('file.write', params);
      },
      stat(rootId, path) {
        return request<HcFileStat>('file.stat', { rootId, path });
      },
    },
    assets: {
      async import(nameOrInput, mime, base64) {
        const input: HcAssetImportInput = typeof nameOrInput === 'string'
          ? { name: nameOrInput, mime: mime || '', base64: base64 || '' }
          : nameOrInput;
        if (!input || !input.name || !input.mime || typeof input.base64 !== 'string') {
          throw new HcViewError('invalid_params', 'assets.import requires {name, mime, base64}.');
        }
        return request<HcAssetImportResult>('assets.import', { name: input.name, mime: input.mime, base64: input.base64 });
      },
    },
    commands: {
      list(when) {
        return request<HcCommandList>('commands.list', when === undefined ? {} : { when });
      },
      execute(id, args) {
        const params: Record<string, unknown> = { id };
        if (args !== undefined) params.args = args;
        return request<{ ok: true }>('commands.execute', params);
      },
    },
    config: {
      get(key) {
        return request<{ value: unknown }>('config.get', { key });
      },
      set(key, value) {
        return request<{ ok: true }>('config.set', { key, value });
      },
    },
    ui: {
      toast(message, kind) {
        const params: Record<string, unknown> = { message };
        if (kind !== undefined) params.kind = kind;
        return request<{ ok: true }>('ui.toast', params);
      },
      setTitle(title) {
        return request<{ ok: true }>('ui.setTitle', { title });
      },
      openView(viewId) {
        return request<{ ok: true }>('ui.openView', { viewId });
      },
      closeSelf() {
        return request<{ ok: true }>('ui.closeSelf', {});
      },
      openExternal(url) {
        return request<{ ok: true }>('ui.openExternal', { url });
      },
      capture(maxWidth, maxHeight, format) {
        const params: Record<string, unknown> = {};
        if (typeof maxWidth === 'number') params.maxWidth = maxWidth;
        if (typeof maxHeight === 'number') params.maxHeight = maxHeight;
        if (format) params.format = format;
        return request<HcCaptureResult>('ui.capture', params);
      },
    },
    network: {
      async fetch(input) {
        const params: Record<string, unknown> = { url: typeof input === 'string' ? input : input.url };
        if (typeof input !== 'string') {
          if (input.method !== undefined) params.method = input.method;
          if (input.headers !== undefined) params.headers = input.headers;
          if (input.bodyBase64 !== undefined) params.bodyBase64 = input.bodyBase64;
        }
        if (!params.url) throw new HcViewError('invalid_params', 'network.fetch requires a url.');
        return request<HcNetworkResponse>('network.fetch', params);
      },
    },
    state: {
      get(key) {
        return request<{ value: unknown }>('state.get', key === undefined ? {} : { key });
      },
      set(key, value) {
        return request<{ ok: true }>('state.set', { key, value });
      },
    },
    events: {
      on: onEvent,
      off: offEvent,
      subscribe(events) {
        if (!Array.isArray(events)) {
          return Promise.reject(new HcViewError('invalid_params', 'events.subscribe expects an array of event names.'));
        }
        for (const event of events) if (event) subscribedEvents.add(event);
        return request<{ ok: true }>('events.subscribe', { events: [...subscribedEvents] });
      },
    },
    sidecars: {
      request(sidecarId, method, params, timeoutMs) {
        return createSidecarJob(sidecarId, method, params, timeoutMs);
      },
    },
    kernels: {
      list() {
        return request<HcKernelListResult>('kernels.list', {});
      },
      ensure(kernelId, scope) {
        if (!scope || typeof scope.kind !== 'string') {
          return Promise.reject(new HcViewError('invalid_params', 'kernels.ensure requires a {kind, key?} scope.'));
        }
        return request<HcKernelEnsureResult>('kernels.ensure', { kernelId, scope });
      },
      execute(sessionId, code, options) {
        const params: Record<string, unknown> = { sessionId, code };
        if (options) {
          if (options.cellId !== undefined) params.cellId = options.cellId;
          if (options.silent !== undefined) params.silent = options.silent;
        }
        return request<{ executionId: string }>('kernels.execute', params);
      },
      interrupt(sessionId, executionId) {
        const params: Record<string, unknown> = { sessionId };
        if (executionId !== undefined) params.executionId = executionId;
        return request<{ ok: true }>('kernels.interrupt', params);
      },
      restart(sessionId) {
        return request<{ sessionId: string }>('kernels.restart', { sessionId });
      },
      dispose(sessionId) {
        return request<{ ok: true }>('kernels.dispose', { sessionId });
      },
      onEvent: kernelsOnEvent,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

async function ensureHandshake(): Promise<HcViewContext> {
  if (injectedError) throw injectedError;
  if (!handshakePromise) startHandshake();
  if (!handshakePromise) throw new HcViewError('internal_error', 'Viewer handshake could not be started.');
  return handshakePromise;
}

/**
 * Resolve the viewer API once the `host.ready` -> `host.context` handshake
 * completed. Repeated calls return the same API instance (spec §6).
 */
export function acquire(): Promise<HcViewApi> {
  if (acquirePromise) return acquirePromise;
  acquirePromise = ensureHandshake()
    .then(context => {
      if (!apiInstance) apiInstance = createApi(context);
      return apiInstance;
    })
    .catch((error: unknown) => {
      acquirePromise = null;
      throw toHcViewError(error);
    });
  return acquirePromise;
}

/** True when the host disposed this viewer (`host.dispose`). */
export function isDisposed(): boolean {
  return disposed;
}

/* Start the handshake as soon as the injected SDK script evaluates, so the
 * host.context response can land before the extension's DOMContentLoaded
 * handler calls acquire(). Safe when loaded outside an iframe: the pending
 * rejection is only surfaced through acquire(). */
if (HC_WINDOW) {
  HC_WINDOW.addEventListener('message', onWindowMessage);
  startHandshake();
}
