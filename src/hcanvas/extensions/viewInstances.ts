/**
 * Hcanvas extension viewer instances (server side).
 *
 * Implements the server half of SPEC-5: short-lived "view_*" instances created
 * from a catalog viewer descriptor, entry-HTML injection (context + SDK script +
 * CSP meta), and resource serving restricted to the viewer's resource roots.
 *
 * Security notes:
 *  - instance tokens never leave this module except through create/validate
 *    results; nothing in this module logs;
 *  - every filesystem access re-resolves symlinks and verifies the real path is
 *    contained by the declared root, so ".." and symlink escapes are rejected;
 *  - only regular files are served and their size is capped (64 MiB per SPEC-5.4).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Default instance lifetime (SPEC-5.1: 60 minutes). */
export const DEFAULT_INSTANCE_TTL_MS = 60 * 60 * 1000;
/** Hard cap for the entry HTML file. */
export const VIEW_ENTRY_MAX_BYTES = 16 * 1024 * 1024;
/** Hard cap for a single served asset (SPEC-5.4: 64 MiB). */
export const VIEW_ASSET_MAX_BYTES = 64 * 1024 * 1024;
/** Maximum JSON size of the recorded view context snapshot. */
export const VIEW_CONTEXT_MAX_BYTES = 256 * 1024;
/** Default cap on live instances kept in memory. */
export const DEFAULT_MAX_INSTANCES = 512;

const INSTANCE_ID_HEX_BYTES = 6;
const TOKEN_BYTES = 24;
const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{1,63}$/;
const MIN_TTL_MS = 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_INSTANCES_BOUND = 10_000;

export type ExtensionViewErrorCode =
  | 'view_not_found'
  | 'view_expired'
  | 'path_forbidden'
  | 'limit_exceeded'
  | 'not_found'
  | 'invalid_params'
  | 'internal_error';

/** Typed error raised by the viewer runtime so the route layer can map HTTP status codes. */
export class ExtensionViewError extends Error {
  readonly code: ExtensionViewErrorCode;

  constructor(code: ExtensionViewErrorCode, message: string) {
    super(message);
    this.name = 'ExtensionViewError';
    this.code = code;
  }
}

/**
 * Resolved catalog information for one viewer contribution.
 * Paths are absolute; the caller (catalog/registry) owns manifest resolution.
 */
export interface ViewViewerInfo {
  extensionId: string;
  viewId: string;
  /** Absolute path of the viewer entry HTML file (must resolve inside extensionRoot). */
  entryPath: string;
  /** Absolute directories asset requests may read from. Defaults to the entry directory. */
  resourceRoots?: string[];
  /** Optional default surface ("file" | "block" | "tab" | "panel" | "page"). */
  surface?: string;
  /** Absolute extension root; entry and resource roots must resolve inside it. */
  extensionRoot: string;
  /** Capability snapshot recorded on the instance (informational, not auth). */
  capabilities?: Record<string, unknown>;
}

/** A live viewer instance as returned by validate(). */
export interface ViewInstance {
  instanceId: string;
  token: string;
  extensionId: string;
  viewId: string;
  surface?: string;
  /** Frozen, JSON-safe context snapshot from the create request. */
  context: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  /** Absolute entry file path. */
  entryPath: string;
  /** Absolute asset roots. */
  resourceRoots: string[];
  /** Absolute extension root. */
  extensionRoot: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

export interface CreateViewInstanceInput {
  extensionId: string;
  viewId: string;
  context?: Record<string, unknown> | null;
}

export interface CreateViewInstanceResult {
  instanceId: string;
  token: string;
  /** ISO timestamp when the instance expires. */
  expiresAt: string;
}

export interface ExtensionViewServiceDeps {
  /** Absolute workspace root (recorded for future per-workspace bookkeeping). */
  workspace: string;
  /** Catalog lookup for (extensionId, viewId); null when unknown/disabled. */
  resolveViewer(extensionId: string, viewId: string): ViewViewerInfo | null;
  /** Instance TTL override; clamped to [1s, 24h], default 60 min. */
  instanceTtlMs?: number;
  /** Injectable wall clock for tests/embedding. */
  now?(): number;
  /** Default URL/path of the Viewer SDK script embedded into entry HTML. */
  sdkPath?: string;
  /** Default host origin used by cspFor() when readEntry() gets no explicit origin. */
  hostOrigin?: string;
  /** Default asset size cap override (never above VIEW_ASSET_MAX_BYTES). */
  maxAssetBytes?: number;
  /** Max live instances before createInstance() rejects with limit_exceeded. */
  maxInstances?: number;
}

export interface ReadEntryOptions {
  /** URL/path of the Viewer SDK script; overrides deps.sdkPath. */
  sdkPath?: string;
  /** Host origin (for example "http://127.0.0.1:4319") used to build the CSP. */
  hostOrigin?: string;
}

export interface ViewEntryResult {
  html: string;
  headers: Record<string, string>;
}

export interface ViewAssetResult {
  /** Real (symlink-resolved) absolute file path; streams must read this path. */
  filePath: string;
  mime: string;
  size: number;
  headers: Record<string, string>;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
};

/** MIME type served for a resource path; unknown extensions are octet-stream (SPEC-5.4). */
export function viewAssetMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** Normalize a host origin ("http://127.0.0.1:4319/") into "http://127.0.0.1:4319"; "" when invalid. */
function normalizeHostOrigin(hostOrigin: string): string {
  const trimmed = (hostOrigin || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : 'http://' + trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

/**
 * Content-Security-Policy for viewer entry documents and viewer assets (SPEC-5.3).
 * The iframe is opaque-origin and script-only, so only inline scripts and this
 * host's own asset route are allowed; everything else is denied.
 */
export function cspFor(hostOrigin: string): string {
  const origin = normalizeHostOrigin(hostOrigin);
  const withOrigin = origin ? ' ' + origin : '';
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'" + withOrigin,
    "style-src 'unsafe-inline'" + withOrigin,
    'img-src data: blob:' + withOrigin,
    'font-src data:' + withOrigin,
    'media-src' + withOrigin,
    'connect-src' + withOrigin,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

function entryResponseHeaders(csp: string): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  };
}

function assetResponseHeaders(mime: string, size: number): Record<string, string> {
  return {
    'content-type': mime,
    'content-length': String(size),
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, max-age=31536000, immutable',
  };
}

/** True when target is strictly inside root (or equal to it when allowRoot). */
function isPathInside(root: string, target: string, allowRoot = false): boolean {
  const relative = path.relative(root, target);
  if (relative === '') return allowRoot;
  if (relative === '..') return false;
  if (relative.startsWith('..' + path.sep)) return false;
  return !path.isAbsolute(relative);
}

/** Constant-time token comparison (hashes first so unequal lengths still compare in constant time). */
function tokensMatch(expected: string, provided: string): boolean {
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  const providedHash = createHash('sha256').update(provided, 'utf8').digest();
  return expectedHash.length === providedHash.length && timingSafeEqual(expectedHash, providedHash);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON serialization that cannot break out of an inline script tag. */
function escapeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function clampInstanceTtl(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_INSTANCE_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(value)));
}

function clampMaxInstances(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_INSTANCES;
  return Math.min(MAX_INSTANCES_BOUND, Math.max(1, Math.floor(value)));
}

function isValidExtensionId(extensionId: string): boolean {
  return EXTENSION_ID_PATTERN.test(extensionId);
}

function isValidViewId(viewId: string): boolean {
  if (!viewId || viewId.length > 128) return false;
  return !/[\u0000-\u001f\u007f/\\]/.test(viewId);
}

/** Validate and freeze the caller-supplied context into a JSON-safe snapshot. */
function snapshotContext(context: CreateViewInstanceInput['context']): Record<string, unknown> {
  if (context === undefined || context === null) return {};
  if (typeof context !== 'object' || Array.isArray(context)) {
    throw new ExtensionViewError('invalid_params', 'context must be a JSON object');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(context);
  } catch {
    throw new ExtensionViewError('invalid_params', 'context must be JSON-serializable');
  }
  if (serialized.length > VIEW_CONTEXT_MAX_BYTES) {
    throw new ExtensionViewError('invalid_params', 'context snapshot is too large');
  }
  const parsed = JSON.parse(serialized) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ExtensionViewError('invalid_params', 'context must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Split a relative asset path into safe segments; rejects traversal and absolute paths. */
function splitAssetPath(relativePath: string): string[] {
  if (typeof relativePath !== 'string') {
    throw new ExtensionViewError('invalid_params', 'Asset path must be a string');
  }
  if (!relativePath || relativePath.includes('\u0000')) {
    throw new ExtensionViewError('path_forbidden', 'Asset path is empty or invalid');
  }
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new ExtensionViewError('path_forbidden', 'Asset path must be relative');
  }
  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw new ExtensionViewError('path_forbidden', 'Asset path must not contain parent segments');
    }
    if (process.platform === 'win32' && segment.includes(':')) {
      throw new ExtensionViewError('path_forbidden', 'Asset path must not contain drive letters');
    }
    segments.push(segment);
  }
  if (!segments.length) {
    throw new ExtensionViewError('path_forbidden', 'Asset path is empty');
  }
  return segments;
}

const REFRESH_META_PATTERN = /<meta\b[^>]*?\bhttp-equiv\s*=\s*(?:"refresh"|'refresh'|refresh(?=[\s/>]))[^>]*>/gi;

function stripRefreshMeta(html: string): string {
  return html.replace(REFRESH_META_PATTERN, '');
}

function insertBeforeClosingTag(html: string, tag: string, markup: string): string {
  const closing = '</' + tag + '>';
  const index = html.toLowerCase().indexOf(closing);
  if (index === -1) return html + (html.endsWith('\n') ? '' : '\n') + markup + '\n';
  return html.slice(0, index) + markup + '\n' + html.slice(index);
}

function buildViewContext(instance: ViewInstance, sdkPath: string): Record<string, unknown> {
  const surface = instance.surface ?? asString(instance.context.surface);
  const format = asString(instance.context.format);
  const locale = asString(instance.context.locale) ?? 'en';
  const theme = asString(instance.context.theme) ?? 'light';
  const viewContext: Record<string, unknown> = {
    instanceId: instance.instanceId,
    extensionId: instance.extensionId,
    viewId: instance.viewId,
  };
  if (surface) viewContext.surface = surface;
  if (format !== undefined) viewContext.format = format;
  viewContext.locale = locale;
  viewContext.theme = theme;
  if (sdkPath) viewContext.sdkUrl = sdkPath;
  viewContext.token = instance.token;
  return viewContext;
}

/**
 * Inject the CSP meta, window.hcViewContext and the SDK script into the entry
 * document (SPEC-5.2). Fragments without <html> are wrapped in a minimal doc.
 */
function injectViewerHtml(rawHtml: string, viewContext: Record<string, unknown>, sdkPath: string, csp: string): string {
  let html = stripRefreshMeta(rawHtml);
  if (!/<html[\s>]/i.test(html)) {
    html = '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n' + html + '\n</body>\n</html>\n';
  }
  const cspMeta = '<meta http-equiv="Content-Security-Policy" content="' + escapeHtmlAttribute(csp) + '">';
  // Inject before any entry script runs: the SDK must exist when extension UI
  // starts, and window.hcViewContext must exist when the SDK initializes.
  const scripts = ['<script>window.hcViewContext = ' + escapeJsonForInlineScript(viewContext) + ';</script>'];
  if (sdkPath) scripts.push('<script src="' + escapeHtmlAttribute(sdkPath) + '"></script>');
  return insertBeforeClosingTag(html, 'head', cspMeta + '\n' + scripts.join('\n'));
}

/**
 * Server-side runtime for Hcanvas viewer instances (SPEC-5.1 / 5.2 / 5.4).
 * Holds short-lived instances, serves their entry document and resources, and
 * enforces path containment and size limits.
 */
export class ExtensionViewService {
  private readonly deps: ExtensionViewServiceDeps;
  private readonly instances = new Map<string, ViewInstance>();
  private readonly ttlMs: number;
  private readonly maxInstances: number;
  private readonly now: () => number;
  readonly workspace: string;

  constructor(deps: ExtensionViewServiceDeps) {
    if (!deps || typeof deps.workspace !== 'string' || !deps.workspace) {
      throw new TypeError('ExtensionViewService requires a workspace path');
    }
    if (typeof deps.resolveViewer !== 'function') {
      throw new TypeError('ExtensionViewService requires a resolveViewer function');
    }
    this.deps = deps;
    this.workspace = deps.workspace;
    this.now = deps.now ?? (() => Date.now());
    this.ttlMs = clampInstanceTtl(deps.instanceTtlMs);
    this.maxInstances = clampMaxInstances(deps.maxInstances);
  }

  /**
   * Validate the viewer exists, then register a fresh instance.
   * Returns the opaque instance id and instance token; the token is only valid
   * for entry/asset reads and postMessage checks, never for the Hcanvas API.
   */
  async createInstance(input: CreateViewInstanceInput): Promise<CreateViewInstanceResult> {
    const extensionId = typeof input?.extensionId === 'string' ? input.extensionId.trim() : '';
    const viewId = typeof input?.viewId === 'string' ? input.viewId.trim() : '';
    if (!isValidExtensionId(extensionId)) {
      throw new ExtensionViewError('invalid_params', 'Invalid extensionId');
    }
    if (!isValidViewId(viewId)) {
      throw new ExtensionViewError('invalid_params', 'Invalid viewId');
    }
    const viewer = this.deps.resolveViewer(extensionId, viewId);
    if (!viewer) {
      throw new ExtensionViewError('not_found', 'Unknown viewer: ' + extensionId + '/' + viewId);
    }
    if (viewer.extensionId !== extensionId || viewer.viewId !== viewId) {
      throw new ExtensionViewError('invalid_params', 'Viewer descriptor does not match the requested ids');
    }
    const paths = this.resolveViewerPaths(viewer);
    const context = snapshotContext(input.context);
    this.sweepExpired();
    if (this.instances.size >= this.maxInstances) {
      throw new ExtensionViewError('limit_exceeded', 'Too many live viewer instances');
    }
    const createdAt = this.now();
    const instanceId = this.nextInstanceId();
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = createdAt + this.ttlMs;
    const instance: ViewInstance = {
      instanceId,
      token,
      extensionId,
      viewId,
      surface: asString(context.surface) ?? paths.surface,
      context,
      capabilities: paths.capabilities,
      entryPath: paths.entryPath,
      resourceRoots: paths.resourceRoots,
      extensionRoot: paths.extensionRoot,
      createdAt,
      expiresAt,
      lastSeenAt: createdAt,
    };
    this.instances.set(instanceId, instance);
    return { instanceId, token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Constant-time token check plus expiry; returns a defensive copy of the instance or null. */
  validate(instanceId: string, token: string): ViewInstance | null {
    const instance = this.lookup(instanceId, token);
    if (!instance) return null;
    return {
      ...instance,
      context: { ...instance.context },
      capabilities: { ...instance.capabilities },
      resourceRoots: instance.resourceRoots.slice(),
    };
  }

  /** Remove a live instance; true when it existed. Tokens for deleted instances stop working. */
  delete(instanceId: string): boolean {
    if (typeof instanceId !== 'string' || !instanceId) return false;
    return this.instances.delete(instanceId);
  }

  /** Drop expired instances; returns how many were removed. */
  sweepExpired(now = this.now()): number {
    let removed = 0;
    for (const [instanceId, instance] of this.instances) {
      if (now >= instance.expiresAt) {
        this.instances.delete(instanceId);
        removed += 1;
      }
    }
    return removed;
  }

  /** Destroy every instance of one extension (disable/uninstall, SPEC-13.18); returns count removed. */
  deleteByExtension(extensionId: string): number {
    if (typeof extensionId !== 'string' || !extensionId) return 0;
    let removed = 0;
    for (const [instanceId, instance] of this.instances) {
      if (instance.extensionId === extensionId) {
        this.instances.delete(instanceId);
        removed += 1;
      }
    }
    return removed;
  }

  /** Destroy every live instance (server shutdown); returns count removed. */
  deleteAll(): number {
    const count = this.instances.size;
    this.instances.clear();
    return count;
  }

  /** Number of live instances (diagnostics only; never includes tokens). */
  get instanceCount(): number {
    return this.instances.size;
  }

  /**
   * Read the viewer entry HTML with the view context and SDK script injected.
   * Returns null for an unknown instance or bad/expired token.
   */
  async readEntry(instanceId: string, token: string, options: ReadEntryOptions = {}): Promise<ViewEntryResult | null> {
    const instance = this.lookup(instanceId, token);
    if (!instance) return null;
    const entryFile = await this.resolveEntryFile(instance);
    const info = await stat(entryFile).catch(() => null);
    if (!info || !info.isFile()) {
      throw new ExtensionViewError('not_found', 'Viewer entry file is missing');
    }
    if (info.size > VIEW_ENTRY_MAX_BYTES) {
      throw new ExtensionViewError('limit_exceeded', 'Viewer entry file is too large');
    }
    let html: string;
    try {
      html = await readFile(entryFile, 'utf8');
    } catch {
      throw new ExtensionViewError('not_found', 'Viewer entry file is not readable');
    }
    const sdkPath = (options.sdkPath ?? this.deps.sdkPath ?? '').trim();
    const csp = cspFor(options.hostOrigin ?? this.deps.hostOrigin ?? '');
    return {
      html: injectViewerHtml(html, buildViewContext(instance, sdkPath), sdkPath, csp),
      headers: entryResponseHeaders(csp),
    };
  }

  /**
   * Resolve an asset under the viewer resource roots and return its file path,
   * MIME and response headers. Returns null when the instance/token is invalid
   * or the file does not exist; throws path_forbidden on traversal/symlink
   * escapes and limit_exceeded above the 64 MiB cap.
   */
  async readAsset(instanceId: string, token: string, relativePath: string): Promise<ViewAssetResult | null> {
    const instance = this.lookup(instanceId, token);
    if (!instance) return null;
    const segments = splitAssetPath(relativePath);
    const configuredMax = this.deps.maxAssetBytes;
    const maxBytes = typeof configuredMax === 'number' && Number.isFinite(configuredMax)
      ? Math.min(VIEW_ASSET_MAX_BYTES, Math.max(1, Math.floor(configuredMax)))
      : VIEW_ASSET_MAX_BYTES;
    const realExtensionRoot = await realpath(instance.extensionRoot).catch(() => null);
    for (const root of instance.resourceRoots) {
      const realRoot = await realpath(root).catch(() => null);
      if (!realRoot) continue;
      if (realExtensionRoot && !isPathInside(realExtensionRoot, realRoot, true)) continue;
      const candidate = path.resolve(root, ...segments);
      if (!isPathInside(root, candidate)) {
        throw new ExtensionViewError('path_forbidden', 'Asset path escapes the resource root');
      }
      const realCandidate = await realpath(candidate).catch(() => null);
      if (!realCandidate) continue;
      if (!isPathInside(realRoot, realCandidate)) {
        throw new ExtensionViewError('path_forbidden', 'Asset path resolves outside the resource root');
      }
      const info = await stat(realCandidate).catch(() => null);
      if (!info || !info.isFile()) continue;
      if (info.size > maxBytes) {
        throw new ExtensionViewError('limit_exceeded', 'Asset exceeds the 64 MiB limit');
      }
      const mime = viewAssetMimeType(realCandidate);
      return {
        filePath: realCandidate,
        mime,
        size: info.size,
        headers: assetResponseHeaders(mime, info.size),
      };
    }
    return null;
  }

  private lookup(instanceId: string, token: string): ViewInstance | null {
    if (typeof instanceId !== 'string' || typeof token !== 'string' || !instanceId || !token) return null;
    const instance = this.instances.get(instanceId);
    if (!instance) return null;
    if (!tokensMatch(instance.token, token)) return null;
    const current = this.now();
    if (current >= instance.expiresAt) {
      this.instances.delete(instanceId);
      return null;
    }
    instance.lastSeenAt = current;
    return instance;
  }

  private nextInstanceId(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = 'view_' + randomBytes(INSTANCE_ID_HEX_BYTES).toString('hex');
      if (!this.instances.has(candidate)) return candidate;
    }
    throw new ExtensionViewError('internal_error', 'Unable to allocate a viewer instance id');
  }

  private resolveViewerPaths(viewer: ViewViewerInfo): {
    entryPath: string;
    resourceRoots: string[];
    extensionRoot: string;
    surface?: string;
    capabilities: Record<string, unknown>;
  } {
    const extensionRoot = path.resolve(viewer.extensionRoot);
    const entryPath = path.resolve(viewer.entryPath);
    if (!isPathInside(extensionRoot, entryPath)) {
      throw new ExtensionViewError('path_forbidden', 'Viewer entry must resolve inside the extension root');
    }
    const declaredRoots = Array.isArray(viewer.resourceRoots) ? viewer.resourceRoots : [];
    const resourceRoots: string[] = [];
    for (const root of declaredRoots) {
      if (typeof root !== 'string' || !root.trim()) continue;
      const resolvedRoot = path.resolve(root);
      if (!isPathInside(extensionRoot, resolvedRoot, true)) {
        throw new ExtensionViewError('path_forbidden', 'Viewer resource root must resolve inside the extension root');
      }
      if (!resourceRoots.includes(resolvedRoot)) resourceRoots.push(resolvedRoot);
    }
    if (!resourceRoots.length) resourceRoots.push(path.dirname(entryPath));
    const surface = typeof viewer.surface === 'string' && viewer.surface ? viewer.surface : undefined;
    const capabilities = viewer.capabilities && typeof viewer.capabilities === 'object' && !Array.isArray(viewer.capabilities)
      ? { ...viewer.capabilities }
      : {};
    return { entryPath, resourceRoots, extensionRoot, surface, capabilities };
  }

  private async resolveEntryFile(instance: ViewInstance): Promise<string> {
    const realEntry = await realpath(instance.entryPath).catch(() => null);
    if (!realEntry) {
      throw new ExtensionViewError('not_found', 'Viewer entry file is missing');
    }
    const realRoot = await realpath(instance.extensionRoot).catch(() => null);
    if (realRoot && !isPathInside(realRoot, realEntry)) {
      throw new ExtensionViewError('path_forbidden', 'Viewer entry resolves outside the extension root');
    }
    return realEntry;
  }
}
