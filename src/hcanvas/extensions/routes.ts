import { readdir, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import {
  HcExtensionError,
  capabilitiesHash,
  checkExtensionManifest,
  type HcExtensionErrorCode,
} from './manifest.js';
import {
  discoverExtensions,
  findExtension,
  installExtension,
  readExtensionSource,
  setExtensionEnabled,
  setExtensionTrusted,
  uninstallProjectExtension,
  type HcExtensionDiscovery,
  type HcExtensionInstallRequest,
  type HcExtensionLoaderOptions,
} from './loader.js';
import { findInstalledNpmExtension, installLocalTarballExtension, installNpmExtension, type HcNpmExtensionInstallRequest } from './npmInstaller.js';
import { HcExtensionRegistry } from './registry.js';
import {
  extensionWorkspaceStatePath,
  readWorkspaceExtensionState,
  setWorkspaceTrust as setWorkspaceTrustState,
} from './state.js';

export interface HcExtensionRouteContext {
  workspace: string;
  json: (res: ServerResponse, status: number, payload: unknown) => void;
  readBody: (req: IncomingMessage, limit?: number) => Promise<Record<string, unknown>>;
  /** Override the Hadamard data root (tests). */
  homeDir?: string;
  /** Override the bundled extensions folder (tests). */
  bundledDir?: string;
  /** Override discovery entirely (tests). */
  discover?: (workspace: string) => Promise<HcExtensionDiscovery>;
  /** Stop kernels/sidecars owned by an extension before its files are removed. */
  stopExtension?: (id: string) => Promise<{ kernels: number; sidecars: number } | void>;
}

const ERROR_STATUS: Record<HcExtensionErrorCode, number> = {
  invalid_manifest: 400,
  duplicate_id: 409,
  unknown_reference: 400,
  path_forbidden: 403,
  not_found: 404,
  invalid_params: 400,
  invalid_install_source: 400,
  unsupported: 501,
  incompatible: 409,
  conflict: 409,
  trusted_required: 403,
  consent_required: 403,
  internal_error: 500,
};

const discoveryCache = new Map<string, Promise<HcExtensionDiscovery>>();

function loaderOptions(context: HcExtensionRouteContext): HcExtensionLoaderOptions {
  return { ...(context.homeDir ? { homeDir: context.homeDir } : {}), ...(context.bundledDir ? { bundledDir: context.bundledDir } : {}) };
}

function cacheKey(context: HcExtensionRouteContext): string {
  return context.workspace + '\u0000' + (context.homeDir ?? '') + '\u0000' + (context.bundledDir ?? '');
}

async function loadDiscovery(context: HcExtensionRouteContext, refresh = false): Promise<HcExtensionDiscovery> {
  const key = cacheKey(context);
  if (!refresh) {
    const cached = discoveryCache.get(key);
    if (cached) return cached;
  }
  const pending = (context.discover ? context.discover(context.workspace) : discoverExtensions(context.workspace, loaderOptions(context)));
  discoveryCache.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (discoveryCache.get(key) === pending) discoveryCache.delete(key);
    throw error;
  }
}

function cacheDiscovery(context: HcExtensionRouteContext, discovery: HcExtensionDiscovery): void {
  discoveryCache.set(cacheKey(context), Promise.resolve(discovery));
}

function registryFor(discovery: HcExtensionDiscovery): HcExtensionRegistry {
  return new HcExtensionRegistry(discovery);
}

function catalogPayload(discovery: HcExtensionDiscovery): Record<string, unknown> {
  const registry = registryFor(discovery);
  return { ok: true, ...registry.catalog() };
}

function sendError(res: ServerResponse, context: HcExtensionRouteContext, error: unknown): void {
  if (error instanceof HcExtensionError) {
    const status = ERROR_STATUS[error.code] ?? 500;
    context.json(res, status, {
      ok: false,
      code: error.code,
      error: error.message,
      ...(error.path ? { path: error.path } : {}),
      ...(error.details.length ? { details: error.details } : {}),
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/body too large/i.test(message)) {
    context.json(res, 413, { ok: false, code: 'limit_exceeded', error: message });
    return;
  }
  if (/invalid json body/i.test(message)) {
    context.json(res, 400, { ok: false, code: 'invalid_params', error: message });
    return;
  }
  context.json(res, 500, { ok: false, code: 'internal_error', error: message });
}

function methodNotAllowed(res: ServerResponse, context: HcExtensionRouteContext, allowed: string[]): void {
  context.json(res, 405, { ok: false, code: 'method_not_allowed', error: 'Allowed methods: ' + allowed.join(', ') });
}

function safePathname(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) throw new HcExtensionError('invalid_params', key + ' is required');
  return value.trim();
}

function optionalStringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new HcExtensionError('invalid_params', key + ' must be a non-empty string');
  return value.trim();
}

function booleanField(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== 'boolean') throw new HcExtensionError('invalid_params', key + ' must be a boolean');
  return value;
}

function optionalNumberField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new HcExtensionError('invalid_params', key + ' must be a positive number');
  }
  return value;
}

async function handleValidate(req: IncomingMessage, res: ServerResponse, context: HcExtensionRouteContext): Promise<boolean> {
  const body = await context.readBody(req);
  const result = checkExtensionManifest(body.manifest);
  if (!result.ok || !result.manifest) {
    context.json(res, 400, {
      ok: false,
      code: 'invalid_manifest',
      error: result.errors[0]?.message || 'invalid manifest',
      errors: result.errors,
      warnings: result.warnings,
    });
    return true;
  }
  context.json(res, 200, {
    ok: true,
    valid: true,
    manifest: result.manifest,
    capabilitiesHash: capabilitiesHash(result.manifest.capabilities),
    warnings: result.warnings,
  });
  return true;
}

async function handleNpmInstall(body: Record<string, unknown>, res: ServerResponse, context: HcExtensionRouteContext): Promise<boolean> {
  const packageName = stringField(body, 'packageName');
  const version = stringField(body, 'version');
  const rawScope = body.scope;
  if (rawScope !== undefined && rawScope !== 'workspace' && rawScope !== 'user') {
    throw new HcExtensionError('invalid_params', 'scope must be "workspace" or "user"');
  }
  const registry = optionalStringField(body, 'registry');
  const timeoutMs = optionalNumberField(body, 'timeoutMs');
  const request: HcNpmExtensionInstallRequest = {
    source: 'npm',
    packageName,
    version,
    scope: rawScope === 'workspace' ? 'workspace' : 'user',
    overwrite: body.overwrite === true,
    ...(registry ? { registry } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  if (request.overwrite && context.stopExtension) {
    const existingId = await findInstalledNpmExtension(context.workspace, packageName, request.scope ?? 'user', loaderOptions(context)).catch(() => undefined);
    if (existingId) await context.stopExtension(existingId).catch(() => undefined);
  }
  const result = await installNpmExtension(context.workspace, request, loaderOptions(context));
  cacheDiscovery(context, result.discovery);
  context.json(res, 201, {
    ...catalogPayload(result.discovery),
    id: result.id,
    path: result.path,
    ...(result.extension ? { extension: result.extension } : {}),
    provenance: result.provenance,
    ...(result.warnings.length ? { warnings: result.warnings } : {}),
  });
  return true;
}

async function handleInstall(req: IncomingMessage, res: ServerResponse, context: HcExtensionRouteContext): Promise<boolean> {
  const body = await context.readBody(req);
  const source = body.source;
  if (source !== 'folder' && source !== 'json' && source !== 'npm' && source !== 'tarball') {
    throw new HcExtensionError('invalid_install_source', 'source must be "folder", "json", "npm" or "tarball"');
  }
  if (source === 'npm') return handleNpmInstall(body, res, context);
  if (source === 'tarball') {
    const tarballPath = stringField(body, 'path');
    const rawScope = body.scope;
    if (rawScope !== undefined && rawScope !== 'workspace' && rawScope !== 'user') {
      throw new HcExtensionError('invalid_params', 'scope must be "workspace" or "user"');
    }
    const result = await installLocalTarballExtension(context.workspace, {
      source: 'tarball', path: tarballPath, scope: rawScope === 'user' ? 'user' : 'workspace', overwrite: body.overwrite === true,
    }, loaderOptions(context));
    cacheDiscovery(context, result.discovery);
    context.json(res, 201, {
      ...catalogPayload(result.discovery), id: result.id, path: result.path,
      ...(result.extension ? { extension: result.extension } : {}), provenance: result.provenance,
      ...(result.warnings.length ? { warnings: result.warnings } : {}),
    });
    return true;
  }
  const scope = body.scope === 'user' ? 'user' : 'workspace';
  const request: HcExtensionInstallRequest = {
    source,
    scope,
    overwrite: body.overwrite === true,
    ...(typeof body.path === 'string' ? { path: body.path } : {}),
    ...(body.manifest !== undefined ? { manifest: body.manifest } : {}),
  };
  const result = await installExtension(context.workspace, request, loaderOptions(context));
  cacheDiscovery(context, result.discovery);
  context.json(res, 201, {
    ...catalogPayload(result.discovery),
    id: result.id,
    path: result.path,
    ...(result.extension ? { extension: result.extension } : {}),
  });
  return true;
}

async function handleUninstall(req: IncomingMessage, res: ServerResponse, context: HcExtensionRouteContext): Promise<boolean> {
  const body = await context.readBody(req);
  const id = stringField(body, 'id');
  const scope = body.scope === 'user' ? 'user' : 'workspace';
  const stopped = await context.stopExtension?.(id).catch(() => undefined);
  const discovery = await uninstallProjectExtension(context.workspace, id, loaderOptions(context), scope);
  cacheDiscovery(context, discovery);
  context.json(res, 200, { ...catalogPayload(discovery), id, ...(stopped ? { stopped } : {}) });
  return true;
}

async function handleToggle(req: IncomingMessage, res: ServerResponse, context: HcExtensionRouteContext): Promise<boolean> {
  const body = await context.readBody(req);
  const id = stringField(body, 'id');
  const enabled = booleanField(body, 'enabled');
  const discovery = await setExtensionEnabled(context.workspace, id, enabled, loaderOptions(context));
  cacheDiscovery(context, discovery);
  context.json(res, 200, { ...catalogPayload(discovery), id, enabled });
  return true;
}

async function handleTrust(req: IncomingMessage, res: ServerResponse, context: HcExtensionRouteContext): Promise<boolean> {
  const body = await context.readBody(req);
  const id = stringField(body, 'id');
  const trusted = booleanField(body, 'trusted');
  const expectedHash = optionalStringField(body, 'capabilitiesHash');
  if (expectedHash !== undefined) {
    const discovery = await loadDiscovery(context);
    const entry = registryFor(discovery).entry(id);
    if (entry && expectedHash !== entry.capabilitiesHash) {
      context.json(res, 409, {
        ok: false,
        code: 'capability_mismatch',
        error: 'capabilities changed since the consent dialog was rendered; re-open consent and retry',
        currentCapabilitiesHash: entry.capabilitiesHash,
      });
      return true;
    }
  }
  const discovery = await setExtensionTrusted(context.workspace, id, trusted, loaderOptions(context));
  cacheDiscovery(context, discovery);
  const entry = registryFor(discovery).entry(id);
  context.json(res, 200, {
    ...catalogPayload(discovery),
    id,
    trusted: entry ? entry.trusted : trusted,
    grantStatus: entry ? entry.grantStatus : 'none',
    ...(entry?.grant ? { grant: entry.grant } : {}),
  });
  return true;
}

async function handleReload(req: IncomingMessage, res: ServerResponse, context: HcExtensionRouteContext): Promise<boolean> {
  const body = await context.readBody(req);
  const id = optionalStringField(body, 'id');
  const discovery = await loadDiscovery(context, true);
  if (id) {
    const extension = findExtension(discovery, id);
    if (!extension) throw new HcExtensionError('not_found', 'Unknown extension id: ' + id);
  }
  cacheDiscovery(context, discovery);
  context.json(res, 200, { ...catalogPayload(discovery), ...(id ? { id } : {}) });
  return true;
}

async function handleWorkspaceTrust(req: IncomingMessage, res: ServerResponse, context: HcExtensionRouteContext): Promise<boolean> {
  if (req.method === 'GET') {
    const state = await readWorkspaceExtensionState(context.workspace);
    context.json(res, 200, { ok: true, trust: state.trust, workspaceTrust: state.trust, path: extensionWorkspaceStatePath(context.workspace) });
    return true;
  }
  if (req.method !== 'POST') {
    methodNotAllowed(res, context, ['GET', 'POST']);
    return true;
  }
  const body = await context.readBody(req);
  const rawTrust = body.trust ?? (typeof body.trusted === 'boolean' ? (body.trusted ? 'trusted' : 'restricted') : undefined);
  if (rawTrust !== 'trusted' && rawTrust !== 'restricted') throw new HcExtensionError('invalid_params', 'trust must be "trusted" or "restricted"');
  await setWorkspaceTrustState(context.workspace, rawTrust);
  const discovery = await loadDiscovery(context, true);
  cacheDiscovery(context, discovery);
  context.json(res, 200, { ...catalogPayload(discovery), trust: rawTrust, workspaceTrust: rawTrust });
  return true;
}

async function handleGallery(req: IncomingMessage, res: ServerResponse, context: HcExtensionRouteContext): Promise<boolean> {
  if (req.method !== 'GET') {
    methodNotAllowed(res, context, ['GET']);
    return true;
  }
  const discovery = await loadDiscovery(context);
  const roots = [
    { kind: 'bundled', dir: discovery.paths.bundled },
    { kind: 'example', dir: path.resolve(process.cwd(), 'examples', 'hcanvas-extensions') },
  ];
  const installed = new Map(discovery.extensions.map(extension => [extension.id, extension.source]));
  const entries: Array<Record<string, unknown>> = [];
  for (const root of roots) {
    let children;
    try { children = await readdir(root.dir, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      let raw: unknown;
      try { raw = JSON.parse(await readFile(path.join(root.dir, child.name, 'manifest.json'), 'utf8')); } catch { continue; }
      const checked = checkExtensionManifest(raw);
      if (!checked.ok || !checked.manifest) continue;
      const manifest = checked.manifest;
      const processCapability = manifest.capabilities.process && Object.keys(manifest.capabilities.process).length > 0;
      entries.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        ...(manifest.description ? { description: manifest.description } : {}),
        path: path.join(root.dir, child.name),
        kind: root.kind,
        requiresProcess: Boolean(processCapability),
        installed: installed.has(manifest.id),
      });
    }
  }
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  context.json(res, 200, { ok: true, entries });
  return true;
}

async function dispatch(req: IncomingMessage, res: ServerResponse, pathname: string, context: HcExtensionRouteContext): Promise<boolean> {
  const method = req.method || 'GET';
  if (pathname === '/api/workspace/trust') return handleWorkspaceTrust(req, res, context);
  if (pathname === '/api/extensions') {
    if (method !== 'GET') {
      methodNotAllowed(res, context, ['GET']);
      return true;
    }
    const discovery = await loadDiscovery(context);
    context.json(res, 200, catalogPayload(discovery));
    return true;
  }
  if (pathname === '/api/extensions/gallery') return handleGallery(req, res, context);
  if (pathname === '/api/extensions/validate') {
    if (method !== 'POST') {
      methodNotAllowed(res, context, ['POST']);
      return true;
    }
    return handleValidate(req, res, context);
  }
  if (pathname === '/api/extensions/install') {
    if (method !== 'POST') {
      methodNotAllowed(res, context, ['POST']);
      return true;
    }
    return handleInstall(req, res, context);
  }
  if (pathname === '/api/extensions/uninstall') {
    if (method !== 'POST') {
      methodNotAllowed(res, context, ['POST']);
      return true;
    }
    return handleUninstall(req, res, context);
  }
  if (pathname === '/api/extensions/toggle') {
    if (method !== 'POST') {
      methodNotAllowed(res, context, ['POST']);
      return true;
    }
    return handleToggle(req, res, context);
  }
  if (pathname === '/api/extensions/trust') {
    if (method !== 'POST') {
      methodNotAllowed(res, context, ['POST']);
      return true;
    }
    return handleTrust(req, res, context);
  }
  if (pathname === '/api/extensions/reload') {
    if (method !== 'POST') {
      methodNotAllowed(res, context, ['POST']);
      return true;
    }
    return handleReload(req, res, context);
  }
  const sourceMatch = /^\/api\/extensions\/([^/]+)\/source$/.exec(pathname);
  if (sourceMatch) {
    if (method !== 'GET') {
      methodNotAllowed(res, context, ['GET']);
      return true;
    }
    const source = await readExtensionSource(context.workspace, sourceMatch[1]!, loaderOptions(context));
    context.json(res, 200, { ok: true, source });
    return true;
  }
  const detailMatch = /^\/api\/extensions\/([^/]+)$/.exec(pathname);
  if (detailMatch) {
    if (method !== 'GET') {
      methodNotAllowed(res, context, ['GET']);
      return true;
    }
    const discovery = await loadDiscovery(context);
    const entry = registryFor(discovery).entry(detailMatch[1]!);
    if (!entry) {
      context.json(res, 404, { ok: false, code: 'not_found', error: 'Unknown extension id: ' + detailMatch[1]! });
      return true;
    }
    context.json(res, 200, { ok: true, extension: entry });
    return true;
  }
  return false;
}

/**
 * Handle /api/extensions/* and /api/workspace/trust routes. Returns true when
 * the request was handled (including error responses), false for other routes.
 */
export async function handleExtensionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: HcExtensionRouteContext,
): Promise<boolean> {
  const pathname = safePathname(url.pathname);
  if (pathname !== '/api/workspace/trust' && pathname !== '/api/extensions' && !pathname.startsWith('/api/extensions/')) return false;
  try {
    return await dispatch(req, res, pathname, context);
  } catch (error) {
    sendError(res, context, error);
    return true;
  }
}
