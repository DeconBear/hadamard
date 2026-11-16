/**
 * Host-side network proxy for extension viewers (SPEC-3.1 network capability,
 * SPEC-5.6 network.fetch).
 *
 * Viewers run in an opaque-origin sandbox and cannot call fetch directly; the
 * app origin cannot either without CORS. This route performs the request on the
 * server, after verifying that the extension declared the target origin in its
 * manifest `capabilities.network` allowlist.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const EXTENSION_NETWORK_ROUTE = '/api/extension-network';

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const ALLOWED_HEADERS = new Set(['accept', 'content-type', 'accept-language', 'user-agent']);

export interface ExtensionNetworkRouteContext {
  json(res: ServerResponse, status: number, payload: unknown): void;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  /** Returns the declared network allowlist for an enabled extension, or null when unknown/disabled. */
  resolveNetwork(extensionId: string): string[] | null;
}

interface NetworkAllowEntry {
  origin: string;
  protocol: string;
  host: string;
  port: string;
}

function parseAllowEntry(raw: string): NetworkAllowEntry | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { origin: url.origin, protocol: url.protocol, host: url.hostname.toLowerCase(), port: url.port || (url.protocol === 'https:' ? '443' : '80') };
  } catch {
    return null;
  }
}

function isPrivateHost(host: string): boolean {
  const value = host.toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '0.0.0.0') return true;
  if (/^127\./u.test(value)) return true;
  if (/^10\./u.test(value)) return true;
  if (/^192\.168\./u.test(value)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./u.test(value)) return true;
  if (/^169\.254\./u.test(value)) return true;
  return false;
}

function headerRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const lower = name.toLowerCase();
    if (!ALLOWED_HEADERS.has(lower)) continue;
    if (typeof raw !== 'string' || raw.length > 2048) continue;
    result[lower] = raw.replace(/[\r\n]/gu, '');
  }
  return result;
}

function base64Body(value: unknown): Buffer | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return null;
  if (value.length > MAX_REQUEST_BYTES * 2) return null;
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length > MAX_REQUEST_BYTES) return null;
  return buffer;
}

/** Handle /api/extension-network requests; returns true when recognized. */
export async function handleExtensionNetworkRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ExtensionNetworkRouteContext,
): Promise<boolean> {
  if (url.pathname !== EXTENSION_NETWORK_ROUTE) return false;
  if ((req.method || 'GET').toUpperCase() !== 'POST') {
    ctx.json(res, 405, { error: 'method_not_allowed', message: 'POST only' });
    return true;
  }
  try {
    const body = await ctx.readBody(req);
    const extensionId = typeof body.extensionId === 'string' ? body.extensionId.trim() : '';
    const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
    if (!extensionId || !rawUrl) {
      ctx.json(res, 400, { error: 'invalid_params', message: 'extensionId and url are required' });
      return true;
    }
    const allowlist = ctx.resolveNetwork(extensionId);
    if (!allowlist) {
      ctx.json(res, 403, { error: 'capability_denied', message: 'Extension is unknown, disabled, or not trusted for network access.' });
      return true;
    }
    let target: URL;
    try { target = new URL(rawUrl); } catch {
      ctx.json(res, 400, { error: 'invalid_params', message: 'url must be absolute' });
      return true;
    }
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.username || target.password) {
      ctx.json(res, 400, { error: 'invalid_params', message: 'Only plain http(s) URLs without credentials are allowed.' });
      return true;
    }
    const entries = allowlist.map(parseAllowEntry).filter((entry): entry is NetworkAllowEntry => Boolean(entry));
    const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');
    const allowed = entries.some(entry => entry.protocol === target.protocol && entry.host === target.hostname.toLowerCase() && entry.port === targetPort);
    if (!allowed) {
      ctx.json(res, 403, { error: 'network_denied', message: 'Origin is not declared in capabilities.network: ' + target.origin });
      return true;
    }
    // Declared loopback/private origins are allowed (the user consented to them);
    // undeclared ones never reach this point.
    if (isPrivateHost(target.hostname) && !entries.some(entry => entry.host === target.hostname.toLowerCase())) {
      ctx.json(res, 403, { error: 'network_denied', message: 'Private network origins require an explicit declaration.' });
      return true;
    }
    const method = typeof body.method === 'string' ? body.method.toUpperCase() : 'GET';
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/u.test(method)) {
      ctx.json(res, 400, { error: 'invalid_params', message: 'Unsupported HTTP method.' });
      return true;
    }
    const headers = headerRecord(body.headers);
    const payload = base64Body(body.bodyBase64);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(target, {
        method,
        headers,
        ...(payload ? { body: payload as unknown as BodyInit } : {}),
        redirect: 'error',
        signal: controller.signal,
      });
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_RESPONSE_BYTES) {
        ctx.json(res, 413, { error: 'limit_exceeded', message: 'Response body exceeds 8 MiB.' });
        return true;
      }
      const resultHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (name.toLowerCase() === 'content-type') resultHeaders[name.toLowerCase()] = value;
      });
      ctx.json(res, 200, { ok: true, status: response.status, headers: resultHeaders, bodyBase64: Buffer.from(arrayBuffer).toString('base64') });
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = error instanceof Error && error.name === 'AbortError';
    ctx.json(res, aborted ? 504 : 502, { error: aborted ? 'network_timeout' : 'network_failed', message });
    return true;
  }
}
