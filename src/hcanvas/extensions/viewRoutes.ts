/**
 * HTTP route adapter for Hcanvas extension viewer instances (SPEC-5 / SPEC-10).
 *
 * The Hcanvas server calls handleExtensionViewRoute() for every request and the
 * function returns true when it recognized and answered the request.
 *
 * Routes:
 *   POST   /api/extension-views                          create an instance
 *   GET    /api/extension-views/:id/entry?token=...      entry HTML
 *   GET    /api/extension-views/:id/assets/<path>?token= resource bytes
 *   DELETE /api/extension-views/:id                      destroy the instance
 *
 * The entry/assets routes are authenticated by the short-lived instance token
 * (carried in the query string because the iframe cannot send headers for its
 * initial navigation). The POST/DELETE control routes are protected by the
 * Hcanvas host token; when the caller already enforced it, it passes
 * tokenAuthAlreadyChecked: true.
 */
import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ExtensionViewError, type ExtensionViewService } from './viewInstances.js';

/** URL prefix handled by this module. */
export const EXTENSION_VIEW_ROUTE_PREFIX = '/api/extension-views';

const STATUS_BY_ERROR_CODE: Record<string, number> = {
  view_not_found: 404,
  view_expired: 410,
  path_forbidden: 403,
  limit_exceeded: 413,
  not_found: 404,
  invalid_params: 400,
  internal_error: 500,
};

export interface ExtensionViewRouteContext {
  service: ExtensionViewService;
  /** Same helper the Hcanvas server uses to emit JSON responses. */
  json(res: ServerResponse, status: number, payload: unknown): void;
  /** Same body reader the Hcanvas server uses (throws on invalid JSON). */
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  /** Absolute origin of this server, for example "http://127.0.0.1:4319". */
  baseUrl: string;
  /** URL path of the Viewer SDK script embedded into the entry HTML. */
  sdkPath: string;
  /** True when the caller already validated the Hcanvas host token for this request. */
  tokenAuthAlreadyChecked?: boolean;
  /**
   * Optional Hcanvas host token. When set (and tokenAuthAlreadyChecked is not
   * true) the POST/DELETE control routes require it in x-hcanvas-token or ?token.
   */
  hostToken?: string;
}

/**
 * Route one request against the extension viewer runtime.
 * Returns true when the request was recognized (including error responses),
 * false when the caller should continue with its other routes.
 */
export async function handleExtensionViewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ExtensionViewRouteContext,
): Promise<boolean> {
  const pathname = url.pathname;
  if (pathname !== EXTENSION_VIEW_ROUTE_PREFIX && !pathname.startsWith(EXTENSION_VIEW_ROUTE_PREFIX + '/')) {
    return false;
  }
  try {
    return await dispatch(req, res, url, ctx);
  } catch (error) {
    sendRouteError(ctx, res, error);
    return true;
  }
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ExtensionViewRouteContext,
): Promise<boolean> {
  const method = (req.method || 'GET').toUpperCase();
  const collection = url.pathname === EXTENSION_VIEW_ROUTE_PREFIX || url.pathname === EXTENSION_VIEW_ROUTE_PREFIX + '/';
  if (collection) {
    if (method !== 'POST') return methodNotAllowed(ctx, res, ['POST']);
    return await createInstance(req, res, url, ctx);
  }
  const rest = url.pathname.slice(EXTENSION_VIEW_ROUTE_PREFIX.length + 1);
  const parts = rest.split('/');
  const rawInstanceId = parts[0] ?? '';
  const instanceId = rawInstanceId ? safeDecode(rawInstanceId) : '';
  if (!instanceId) {
    ctx.json(res, 400, { error: 'invalid_params', message: 'Missing viewer instance id' });
    return true;
  }
  if (parts.length === 1) {
    if (method !== 'DELETE') return methodNotAllowed(ctx, res, ['DELETE']);
    return deleteInstance(req, res, url, ctx, instanceId);
  }
  const action = parts[1] ?? '';
  if (action === 'entry' && parts.length === 2) {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(ctx, res, ['GET', 'HEAD']);
    return await serveEntry(req, res, url, ctx, instanceId, method === 'HEAD');
  }
  if (action === 'assets' && parts.length >= 3) {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(ctx, res, ['GET', 'HEAD']);
    const relativePath = safeDecode(parts.slice(2).join('/'));
    if (relativePath === null || !relativePath) {
      ctx.json(res, 400, { error: 'invalid_params', message: 'Invalid asset path' });
      return true;
    }
    return await serveAsset(req, res, url, ctx, instanceId, relativePath, method === 'HEAD');
  }
  ctx.json(res, 404, { error: 'not_found', message: 'Unknown extension view route' });
  return true;
}

async function createInstance(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ExtensionViewRouteContext,
): Promise<boolean> {
  if (!controlRouteAuthorized(req, url, ctx)) {
    ctx.json(res, 401, { error: 'unauthorized' });
    return true;
  }
  let body: Record<string, unknown>;
  try {
    body = await ctx.readBody(req);
  } catch {
    throw new ExtensionViewError('invalid_params', 'Invalid JSON request body');
  }
  const extensionId = typeof body.extensionId === 'string' ? body.extensionId : '';
  const viewId = typeof body.viewId === 'string' ? body.viewId : '';
  const rawContext = body.context;
  let context: Record<string, unknown> | undefined;
  if (rawContext !== undefined && rawContext !== null) {
    if (typeof rawContext !== 'object' || Array.isArray(rawContext)) {
      throw new ExtensionViewError('invalid_params', 'context must be an object');
    }
    context = rawContext as Record<string, unknown>;
  }
  let created: { instanceId: string; token: string; expiresAt: string };
  try {
    created = await ctx.service.createInstance({ extensionId, viewId, context });
  } catch (error) {
    if (error instanceof ExtensionViewError && error.code === 'not_found') {
      ctx.json(res, 400, { error: 'unknown_reference', message: error.message });
      return true;
    }
    throw error;
  }
  const entryUrl = normalizeBaseUrl(ctx.baseUrl) + EXTENSION_VIEW_ROUTE_PREFIX +
    '/' + encodeURIComponent(created.instanceId) + '/entry?token=' + encodeURIComponent(created.token);
  ctx.json(res, 201, {
    instanceId: created.instanceId,
    entryUrl,
    token: created.token,
    sdkUrl: ctx.sdkPath,
    expiresAt: created.expiresAt,
  });
  return true;
}

function deleteInstance(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ExtensionViewRouteContext,
  instanceId: string,
): boolean {
  if (!controlRouteAuthorized(req, url, ctx)) {
    ctx.json(res, 401, { error: 'unauthorized' });
    return true;
  }
  if (!ctx.service.delete(instanceId)) {
    ctx.json(res, 404, { error: 'view_not_found' });
    return true;
  }
  ctx.json(res, 200, { ok: true });
  return true;
}

async function serveEntry(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ExtensionViewRouteContext,
  instanceId: string,
  headOnly: boolean,
): Promise<boolean> {
  const entry = await ctx.service.readEntry(instanceId, viewToken(req, url), {
    sdkPath: ctx.sdkPath,
    hostOrigin: hostOriginOf(ctx.baseUrl),
  });
  if (!entry) {
    ctx.json(res, 404, { error: 'view_not_found' });
    return true;
  }
  res.writeHead(200, entry.headers);
  if (headOnly) res.end();
  else res.end(entry.html);
  return true;
}

async function serveAsset(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ExtensionViewRouteContext,
  instanceId: string,
  relativePath: string,
  headOnly: boolean,
): Promise<boolean> {
  const asset = await ctx.service.readAsset(instanceId, viewToken(req, url), relativePath);
  if (!asset) {
    ctx.json(res, 404, { error: 'not_found' });
    return true;
  }
  res.writeHead(200, asset.headers);
  if (headOnly) {
    res.end();
    return true;
  }
  const stream = createReadStream(asset.filePath);
  stream.once('error', () => {
    try {
      res.destroy();
    } catch {
      // The socket is already gone; nothing else to clean up.
    }
  });
  stream.pipe(res);
  return true;
}

function controlRouteAuthorized(req: IncomingMessage, url: URL, ctx: ExtensionViewRouteContext): boolean {
  if (ctx.tokenAuthAlreadyChecked === true) return true;
  if (!ctx.hostToken) return true;
  const header = req.headers['x-hcanvas-token'];
  const headerValue = Array.isArray(header) ? header[0] ?? '' : header ?? '';
  const provided = headerValue || url.searchParams.get('token') || '';
  return provided === ctx.hostToken;
}

function viewToken(req: IncomingMessage, url: URL): string {
  const query = url.searchParams.get('token');
  if (query) return query;
  const header = req.headers['x-hc-view-token'];
  if (Array.isArray(header)) return header[0] ?? '';
  return header ?? '';
}

function methodNotAllowed(ctx: ExtensionViewRouteContext, res: ServerResponse, allowed: string[]): boolean {
  ctx.json(res, 405, { error: 'method_not_allowed', allowed });
  return true;
}

function sendRouteError(ctx: ExtensionViewRouteContext, res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    try {
      res.destroy();
    } catch {
      // Response already partially streamed; drop the socket.
    }
    return;
  }
  if (error instanceof ExtensionViewError) {
    const status = STATUS_BY_ERROR_CODE[error.code] ?? 500;
    const payload: Record<string, unknown> = { error: error.code };
    if (error.code === 'invalid_params' || error.code === 'path_forbidden' || error.code === 'limit_exceeded') {
      payload.message = error.message;
    }
    ctx.json(res, status, payload);
    return;
  }
  if (error && typeof error === 'object' && (error as { name?: unknown }).name === 'HcValidationError') {
    ctx.json(res, 400, { error: 'invalid_params', message: 'Invalid request body' });
    return;
  }
  ctx.json(res, 500, { error: 'internal_error' });
}

function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || '').trim().replace(/\/+$/, '');
}

function hostOriginOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return '';
  }
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
