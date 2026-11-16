/**
 * Host-side manager for Hcanvas extension viewer iframes (client runtime).
 *
 * Responsibilities (plan/HCANVAS_EXTENSION_PLATFORM_SPEC_16Nov2026.md §5.1–§5.6,
 * §11, §13):
 *   - create the server-side view instance, then the sandboxed iframe
 *     (`sandbox="allow-scripts"` only, `referrerpolicy="no-referrer"`);
 *   - wait for the viewer SDK `host.ready` handshake (10s) and answer with
 *     `host.context`;
 *   - validate every postMessage (source, `hc === 1`, constant-time token),
 *     enforce the §5.6 method allowlist + light param schema, then route
 *     validated requests to `deps.resolveMethod` (wired by the app shell);
 *   - reply with response envelopes (30s per request), forward host events;
 *   - dispose the iframe/listeners on destroy (200ms `host.dispose` grace).
 *
 * Security invariants enforced here: SPEC-13 #2 (fixed sandbox), #4 (source +
 * token + hc), #17 (per-view error isolation: nothing here throws into the
 * shell event loop). Path/capability decisions stay in the server/deps layer.
 *
 * This module is app-origin-only. It must never be imported by the viewer SDK
 * bundle and must never be loaded inside the sandboxed iframe.
 */

/** Host waits this long for the viewer `host.ready` handshake. */
export const VIEW_READY_TIMEOUT_MS = 10_000;
/** Per-request RPC timeout after the handshake. */
export const VIEW_REQUEST_TIMEOUT_MS = 30_000;
/** Grace period between the `host.dispose` event and iframe removal (§5.1). */
export const VIEW_DISPOSE_GRACE_MS = 200;

const HC_PROTOCOL_VERSION = 1 as const;
const IFRAME_SANDBOX = 'allow-scripts'; // SPEC-13 #2: never add allow-same-origin.

/** Error raised by the host manager (not a wire error). */
export class HcViewHostError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'HcViewHostError';
    this.code = code;
  }
}

/** Wire error payload sent back to the viewer (SPEC §5.5/§5.7). */
export interface HcViewErrorPayload {
  code: string;
  message: string;
  data?: unknown;
}

/** Viewer creation context passed to `deps.createInstance` (SPEC §5.1). */
export interface ExtensionViewFileContext {
  rootId: string;
  path: string;
  readOnly?: boolean;
  [key: string]: unknown;
}

export interface ExtensionViewContext {
  surface: string;
  format?: string;
  file?: ExtensionViewFileContext;
  [key: string]: unknown;
}

export interface CreateViewInstanceInput {
  extensionId: string;
  viewId: string;
  context: ExtensionViewContext;
}

/** Response of `deps.createInstance` (server `POST /api/extension-views`). */
export interface CreatedViewInstance {
  instanceId: string;
  token: string;
  entryUrl: string;
  sdkUrl: string;
  expiresAt: string;
}

/**
 * Live view instance. Also the `ViewHandle` returned by `create()`.
 * `sendEvent` forwards a host -> viewer event (document.changed, theme.changed,
 * visibility.changed, command, kernel.event, sidecar.event, ...).
 */
export interface ViewInstance {
  readonly instanceId: string;
  readonly extensionId: string;
  readonly viewId: string;
  readonly token: string;
  readonly entryUrl: string;
  readonly sdkUrl: string;
  readonly expiresAt: string;
  readonly context: ExtensionViewContext;
  readonly surface: string;
  readonly format: string;
  readonly iframe: HTMLIFrameElement;
  ready: boolean;
  disposed: boolean;
  sendEvent(method: string, params?: unknown): boolean;
  destroy(): Promise<void>;
}

export type ViewHandle = ViewInstance;

/**
 * Host dependencies wired by the app shell (Lead).
 *
 * `resolveMethod` receives already validated (allowlisted + light-schema
 * checked) method/params and must return a JSON-serializable result. Throwing
 * an error with a `code`/`message`/`data` shape forwards that error to the
 * viewer; any other throw becomes `internal_error`.
 */
export interface ExtensionViewHostDeps {
  createInstance(input: CreateViewInstanceInput): Promise<CreatedViewInstance>;
  destroyInstance(instanceId: string): Promise<void>;
  getTheme?(): string;
  getLocale?(): string;
  resolveMethod(method: string, params: unknown, instance: ViewInstance): Promise<unknown>;
}

export interface ExtensionViewHostOptions {
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  disposeGraceMs?: number;
}

interface HcViewRequestEnvelope {
  hc: 1;
  kind: 'request';
  id: string;
  token: string;
  method: string;
  params?: unknown;
}

interface HcViewResponseEnvelope {
  hc: 1;
  kind: 'response';
  id: string;
  result?: unknown;
  error?: HcViewErrorPayload;
}

interface HcViewEventEnvelope {
  hc: 1;
  kind: 'event';
  method: string;
  params?: unknown;
}

/* ------------------------------------------------------------------ */
/* §5.6 method allowlist + light param schema (hand-written, no zod)   */
/* ------------------------------------------------------------------ */

type ParamKind = 'string' | 'number' | 'boolean' | 'array' | 'object';

/** Only methods present in SPEC §5.6 are routable after the handshake. */
const REQUEST_METHODS: ReadonlySet<string> = new Set([
  'host.ping',
  'document.read',
  'document.apply',
  'file.read',
  'file.write',
  'file.stat',
  'assets.import',
  'commands.list',
  'commands.execute',
  'config.get',
  'config.set',
  'ui.toast',
  'ui.setTitle',
  'ui.openView',
  'ui.closeSelf',
  'ui.capture',
  'ui.openExternal',
  'network.fetch',
  'state.get',
  'state.set',
  'events.subscribe',
  'sidecars.request',
  'sidecars.cancel',
  'kernels.list',
  'kernels.ensure',
  'kernels.execute',
  'kernels.interrupt',
  'kernels.restart',
  'kernels.dispose',
]);

const REQUIRED_PARAMS: Record<string, Record<string, ParamKind>> = {
  'document.apply': { ops: 'array' },
  'file.read': { rootId: 'string', path: 'string' },
  'file.write': { rootId: 'string', path: 'string', content: 'string' },
  'file.stat': { rootId: 'string', path: 'string' },
  'assets.import': { name: 'string', mime: 'string', base64: 'string' },
  'commands.execute': { id: 'string' },
  'config.get': { key: 'string' },
  'config.set': { key: 'string' },
  'ui.toast': { message: 'string' },
  'ui.setTitle': { title: 'string' },
  'ui.openView': { viewId: 'string' },
  'ui.openExternal': { url: 'string' },
  'network.fetch': { url: 'string' },
  'state.set': { key: 'string' },
  'events.subscribe': { events: 'array' },
  'sidecars.request': { sidecarId: 'string', method: 'string' },
  'sidecars.cancel': { requestId: 'string' },
  'kernels.ensure': { kernelId: 'string', scope: 'object' },
  'kernels.execute': { sessionId: 'string', code: 'string' },
  'kernels.interrupt': { sessionId: 'string' },
  'kernels.restart': { sessionId: 'string' },
  'kernels.dispose': { sessionId: 'string' },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Constant-time-ish token comparison (SPEC-13 #4). */
function constantTimeEqual(left: string, right: string): boolean {
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftCode = index < left.length ? left.charCodeAt(index) : 0;
    const rightCode = index < right.length ? right.charCodeAt(index) : 0;
    diff |= leftCode ^ rightCode;
  }
  return diff === 0;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function matchesKind(kind: ParamKind, value: unknown): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    default:
      return true;
  }
}

function validateMethodParams(method: string, params: unknown): string | null {
  const required = REQUIRED_PARAMS[method];
  if (!required) return null;
  if (params !== undefined && params !== null && !isRecord(params)) return 'Request params must be an object.';
  const record = isRecord(params) ? params : {};
  for (const key of Object.keys(required)) {
    const kind = required[key];
    if (!kind) continue;
    const value = record[key];
    if (value === undefined || value === null) return 'Missing required param: ' + key + '.';
    if (!matchesKind(kind, value)) return 'Param "' + key + '" must be of type ' + kind + '.';
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, method: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new HcViewHostError('request_timeout', 'Viewer method "' + method + '" timed out after ' + timeoutMs + 'ms.'));
    }, timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function toErrorPayload(error: unknown): HcViewErrorPayload {
  if (error instanceof HcViewHostError) {
    // SPEC §5.7 has no host timeout code; expose timeouts as internal_error.
    return { code: 'internal_error', message: error.message };
  }
  if (isRecord(error)) {
    const code = typeof error.code === 'string' && error.code ? error.code : 'internal_error';
    const message = typeof error.message === 'string' && error.message ? error.message : 'Viewer host method failed.';
    return error.data === undefined ? { code, message } : { code, message, data: error.data };
  }
  if (typeof error === 'string' && error) return { code: 'internal_error', message: error };
  return { code: 'internal_error', message: 'Viewer host method failed.' };
}

function createReadySignal(): { promise: Promise<void>; resolve: () => void; reject: (error: HcViewHostError) => void } {
  let resolveSignal: () => void = () => undefined;
  let rejectSignal: (error: HcViewHostError) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolveSignal = resolve;
    rejectSignal = reject;
  });
  promise.catch(() => { /* surfaced by create() */ });
  return { promise, resolve: resolveSignal, reject: rejectSignal };
}

function validateCreateInput(input: CreateViewInstanceInput): void {
  if (!isRecord(input)) throw new HcViewHostError('invalid_params', 'ExtensionViewHost.create requires {extensionId, viewId, context}.');
  if (typeof input.extensionId !== 'string' || !input.extensionId) {
    throw new HcViewHostError('invalid_params', 'ExtensionViewHost.create requires a non-empty extensionId.');
  }
  if (typeof input.viewId !== 'string' || !input.viewId) {
    throw new HcViewHostError('invalid_params', 'ExtensionViewHost.create requires a non-empty viewId.');
  }
  if (!isRecord(input.context) || typeof input.context.surface !== 'string' || !input.context.surface) {
    throw new HcViewHostError('invalid_params', 'ExtensionViewHost.create requires context.surface.');
  }
}

function validateCreatedInstance(created: CreatedViewInstance): void {
  if (!isRecord(created)) throw new HcViewHostError('internal_error', 'createInstance returned an invalid view instance.');
  if (typeof created.instanceId !== 'string' || !created.instanceId) {
    throw new HcViewHostError('internal_error', 'createInstance returned no instanceId.');
  }
  if (typeof created.token !== 'string' || !created.token) {
    throw new HcViewHostError('internal_error', 'createInstance returned no viewer token.');
  }
  if (typeof created.entryUrl !== 'string' || !created.entryUrl) {
    throw new HcViewHostError('internal_error', 'createInstance returned no entryUrl.');
  }
  if (typeof created.sdkUrl !== 'string') created.sdkUrl = '';
  if (typeof created.expiresAt !== 'string') created.expiresAt = '';
}

interface InternalViewInstance extends ViewInstance {
  readyPromise: Promise<void>;
  resolveReady: (() => void) | null;
  rejectReady: ((error: HcViewHostError) => void) | null;
  readyTimer: ReturnType<typeof setTimeout> | null;
  disposePromise: Promise<void> | null;
  deniedLog: Set<string>;
}

/* ------------------------------------------------------------------ */
/* ExtensionViewHost                                                   */
/* ------------------------------------------------------------------ */

export class ExtensionViewHost {
  private readonly deps: ExtensionViewHostDeps;
  private readonly readyTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly disposeGraceMs: number;
  private readonly instances = new Map<string, InternalViewInstance>();
  private listening = false;

  constructor(deps: ExtensionViewHostDeps, options: ExtensionViewHostOptions = {}) {
    if (
      !deps
      || typeof deps.createInstance !== 'function'
      || typeof deps.destroyInstance !== 'function'
      || typeof deps.resolveMethod !== 'function'
    ) {
      throw new HcViewHostError('invalid_params', 'ExtensionViewHost requires createInstance, destroyInstance and resolveMethod deps.');
    }
    this.deps = deps;
    this.readyTimeoutMs = positiveNumber(options.readyTimeoutMs, VIEW_READY_TIMEOUT_MS);
    this.requestTimeoutMs = positiveNumber(options.requestTimeoutMs, VIEW_REQUEST_TIMEOUT_MS);
    this.disposeGraceMs = positiveNumber(options.disposeGraceMs, VIEW_DISPOSE_GRACE_MS);
  }

  /**
   * Create the server view instance + sandboxed iframe and resolve once the
   * viewer SDK completed `host.ready`/`host.context`. Rejects (after cleanup)
   * on load failure, handshake timeout or a server-side creation error.
   */
  async create(input: CreateViewInstanceInput, mountEl: HTMLElement): Promise<ViewHandle> {
    validateCreateInput(input);
    if (!mountEl || typeof mountEl.appendChild !== 'function') {
      throw new HcViewHostError('invalid_params', 'ExtensionViewHost.create requires a mount element.');
    }
    let created: CreatedViewInstance;
    try {
      created = await this.deps.createInstance({
        extensionId: input.extensionId,
        viewId: input.viewId,
        context: input.context,
      });
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new HcViewHostError('internal_error', 'createInstance failed: ' + String(error));
    }
    validateCreatedInstance(created);

    const signal = createReadySignal();
    const iframe = document.createElement('iframe');
    // Fixed by the host; extensions can never override these (SPEC-13 #2).
    iframe.setAttribute('sandbox', IFRAME_SANDBOX);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('allow', 'clipboard-write; fullscreen');
    iframe.setAttribute('title', 'Extension view ' + input.viewId);
    iframe.dataset.hcExtensionView = created.instanceId;
    iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:transparent';

    const sendEvent = (method: string, params?: unknown): boolean => this.postEvent(instance, method, params);
    const destroy = (): Promise<void> => this.disposeInstance(instance, 'destroyed');
    const instance: InternalViewInstance = {
      instanceId: created.instanceId,
      extensionId: input.extensionId,
      viewId: input.viewId,
      token: created.token,
      entryUrl: created.entryUrl,
      sdkUrl: created.sdkUrl,
      expiresAt: created.expiresAt,
      context: input.context,
      surface: input.context.surface,
      format: typeof input.context.format === 'string' ? input.context.format : '',
      iframe,
      ready: false,
      disposed: false,
      sendEvent,
      destroy,
      readyPromise: signal.promise,
      resolveReady: signal.resolve,
      rejectReady: signal.reject,
      readyTimer: null,
      disposePromise: null,
      deniedLog: new Set<string>(),
    };

    this.instances.set(instance.instanceId, instance);
    this.ensureListening();
    mountEl.appendChild(iframe);
    instance.readyTimer = setTimeout(() => {
      this.failReady(instance, 'ready_timeout', 'Viewer did not complete the host.ready handshake within ' + this.readyTimeoutMs + 'ms.');
    }, this.readyTimeoutMs);
    iframe.src = created.entryUrl;

    try {
      await instance.readyPromise;
    } catch (error) {
      await this.disposeInstance(instance, 'load_failed');
      if (error instanceof HcViewHostError) throw error;
      throw new HcViewHostError('load_failed', 'Viewer iframe failed to load.');
    }
    return instance;
  }

  /** Destroy a view: sends `host.dispose`, waits 200ms, removes the iframe, DELETEs the instance. */
  async destroy(handle: ViewHandle): Promise<void> {
    const instance = this.instances.get(handle.instanceId);
    if (!instance) return;
    await this.disposeInstance(instance, 'destroyed');
  }

  /** Destroy every live view (workspace close / host shutdown). */
  async destroyAll(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const instance of this.instances.values()) pending.push(this.disposeInstance(instance, 'host_shutdown'));
    await Promise.all(pending);
  }

  /** Forward one host event to one viewer (document.changed, theme.changed, ...). */
  emit(handle: ViewHandle, method: string, params?: unknown): boolean {
    const instance = this.instances.get(handle.instanceId);
    if (!instance || instance.disposed) return false;
    return this.postEvent(instance, method, params);
  }

  /** Forward one host event to every live viewer; returns the number of viewers reached. */
  broadcast(method: string, params?: unknown): number {
    let reached = 0;
    for (const instance of this.instances.values()) {
      if (!instance.disposed && this.postEvent(instance, method, params)) reached += 1;
    }
    return reached;
  }

  /* ---------------- message plumbing ---------------- */

  private ensureListening(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('message', this.handleWindowMessage);
  }

  private releaseListenerIfIdle(): void {
    if (!this.listening || this.instances.size > 0) return;
    this.listening = false;
    window.removeEventListener('message', this.handleWindowMessage);
  }

  private handleWindowMessage = (event: MessageEvent): void => {
    try {
      const data: unknown = event.data;
      if (!isRecord(data) || data.hc !== HC_PROTOCOL_VERSION) return;
      const instance = this.findInstance(event.source);
      if (!instance || instance.disposed) return;
      if (data.kind !== 'request') return; // viewer -> host only sends requests
      this.handleRequest(instance, data);
    } catch (error) {
      // Never let viewer traffic throw into the shell event loop (SPEC-13 #17).
      this.log('error', 'viewer message handling failed', error);
    }
  };

  private findInstance(source: MessageEventSource | null): InternalViewInstance | null {
    if (!source) return null;
    for (const instance of this.instances.values()) {
      if (instance.iframe.contentWindow === source) return instance;
    }
    return null;
  }

  private handleRequest(instance: InternalViewInstance, data: Record<string, unknown>): void {
    const id = typeof data.id === 'string' ? data.id : '';
    const method = typeof data.method === 'string' ? data.method : '';
    if (!id || !method) return;
    const token = typeof data.token === 'string' ? data.token : '';
    if (!constantTimeEqual(token, instance.token)) {
      this.auditDenied(instance, method, 'token_mismatch');
      this.sendResponse(instance, id, undefined, { code: 'capability_denied', message: 'Invalid viewer token.' });
      return;
    }
    if (method === 'host.ready') {
      this.respondHostContext(instance, id);
      return;
    }
    if (!instance.ready) {
      this.sendResponse(instance, id, undefined, { code: 'capability_denied', message: 'Viewer handshake is not complete.' });
      return;
    }
    void this.routeRequest(instance, id, method, data.params);
  }

  private async routeRequest(instance: InternalViewInstance, id: string, method: string, params: unknown): Promise<void> {
    try {
      if (!REQUEST_METHODS.has(method)) {
        this.auditDenied(instance, method, 'method_not_allowed');
        this.sendResponse(instance, id, undefined, { code: 'capability_denied', message: 'Viewer method "' + method + '" is not allowed.' });
        return;
      }
      const paramError = validateMethodParams(method, params);
      if (paramError) {
        this.auditDenied(instance, method, 'invalid_params');
        this.sendResponse(instance, id, undefined, { code: 'invalid_params', message: paramError });
        return;
      }
      if (method === 'host.ping') {
        this.sendResponse(instance, id, { pong: true });
        return;
      }
      const result = await withTimeout(this.deps.resolveMethod(method, params, instance), this.requestTimeoutMs, method);
      if (instance.disposed) return;
      this.sendResponse(instance, id, result);
      if (method === 'ui.closeSelf') {
        // Reply first, then dispose (the SDK triggers teardown on the response).
        setTimeout(() => {
          void this.destroy(instance);
        }, 60);
      }
    } catch (error) {
      if (instance.disposed) return;
      const payload = toErrorPayload(error);
      this.log('warn', 'viewer method failed: ' + method + ' (' + payload.code + ')');
      this.sendResponse(instance, id, undefined, payload);
    }
  }

  private respondHostContext(instance: InternalViewInstance, id: string): void {
    if (instance.disposed) return;
    this.sendResponse(instance, id, {
      instanceId: instance.instanceId,
      capabilities: [],
      theme: this.currentTheme(),
      locale: this.currentLocale(),
      surface: instance.surface,
      format: instance.format,
      context: instance.context,
    });
    this.completeReady(instance);
  }

  private completeReady(instance: InternalViewInstance): void {
    if (instance.ready || instance.disposed) return;
    instance.ready = true;
    if (instance.readyTimer !== null) {
      clearTimeout(instance.readyTimer);
      instance.readyTimer = null;
    }
    const resolve = instance.resolveReady;
    instance.resolveReady = null;
    instance.rejectReady = null;
    resolve?.();
  }

  private failReady(instance: InternalViewInstance, code: string, message: string): void {
    if (instance.ready || instance.disposed) return;
    if (instance.readyTimer !== null) {
      clearTimeout(instance.readyTimer);
      instance.readyTimer = null;
    }
    const reject = instance.rejectReady;
    instance.resolveReady = null;
    instance.rejectReady = null;
    reject?.(new HcViewHostError(code, message));
  }

  private sendResponse(instance: InternalViewInstance, id: string, result: unknown, error?: HcViewErrorPayload): void {
    if (instance.disposed) return;
    const envelope: HcViewResponseEnvelope = { hc: HC_PROTOCOL_VERSION, kind: 'response', id };
    if (error) envelope.error = error;
    else envelope.result = result;
    this.postMessage(instance, envelope);
  }

  private postEvent(instance: InternalViewInstance, method: string, params?: unknown): boolean {
    if (typeof method !== 'string' || !method) return false;
    const envelope: HcViewEventEnvelope = { hc: HC_PROTOCOL_VERSION, kind: 'event', method };
    if (params !== undefined) envelope.params = params;
    return this.postMessage(instance, envelope);
  }

  private postMessage(instance: InternalViewInstance, envelope: HcViewResponseEnvelope | HcViewEventEnvelope): boolean {
    const target = instance.iframe.contentWindow;
    if (!target) return false;
    try {
      // Opaque-origin sandboxed iframe: target origin must be '*'.
      target.postMessage(envelope, '*');
      return true;
    } catch (error) {
      this.log('warn', 'postMessage to viewer failed (instance ' + instance.instanceId + ')', error);
      return false;
    }
  }

  private async disposeInstance(instance: InternalViewInstance, reason: string): Promise<void> {
    if (instance.disposePromise) return instance.disposePromise;
    instance.disposePromise = (async () => {
      if (!instance.disposed) {
        instance.disposed = true;
        this.postEvent(instance, 'host.dispose', { reason });
        instance.ready = false;
        if (instance.readyTimer !== null) {
          clearTimeout(instance.readyTimer);
          instance.readyTimer = null;
        }
        const rejectReady = instance.rejectReady;
        instance.resolveReady = null;
        instance.rejectReady = null;
        rejectReady?.(new HcViewHostError('destroyed', 'Viewer instance was destroyed before it became ready.'));
        await delay(this.disposeGraceMs);
        instance.iframe.remove();
        this.instances.delete(instance.instanceId);
        this.releaseListenerIfIdle();
      }
      try {
        await this.deps.destroyInstance(instance.instanceId);
      } catch (error) {
        this.log('warn', 'destroyInstance failed for ' + instance.instanceId, error);
      }
    })();
    return instance.disposePromise;
  }

  private currentTheme(): string {
    try {
      const theme = this.deps.getTheme?.();
      return typeof theme === 'string' && theme ? theme : 'light';
    } catch {
      return 'light';
    }
  }

  private currentLocale(): string {
    try {
      const locale = this.deps.getLocale?.();
      return typeof locale === 'string' && locale ? locale : 'en';
    } catch {
      return 'en';
    }
  }

  private auditDenied(instance: InternalViewInstance, method: string, reason: string): void {
    const key = method + ':' + reason;
    if (instance.deniedLog.has(key)) return;
    instance.deniedLog.add(key);
    // TODO(Lead): surface through the extension diagnostics/audit panel.
    this.log('warn', 'viewer request denied (' + reason + ', method ' + method + ', instance ' + instance.instanceId + ')');
  }

  private log(level: 'warn' | 'error', message: string, error?: unknown): void {
    const line = '[hcanvas:viewer-host] ' + message;
    if (level === 'error') console.error(line, error);
    else console.warn(line, error);
  }
}
