import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_INSTANCE_TTL_MS,
  ExtensionViewError,
  ExtensionViewService,
  VIEW_ASSET_MAX_BYTES,
  VIEW_CONTEXT_MAX_BYTES,
  cspFor,
  type ViewViewerInfo,
} from '../src/hcanvas/extensions/viewInstances.js';
import {
  EXTENSION_VIEW_ROUTE_PREFIX,
  handleExtensionViewRoute,
  type ExtensionViewRouteContext,
} from '../src/hcanvas/extensions/viewRoutes.js';

const SDK_PATH = '/api/extension-sdk/hc-extension-api.js?v=1';
const HOST_TOKEN = 'host-secret-token';
const EXTENSION_ID = 'com.example.viewer';
const ENTRY_CONTENT = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta http-equiv="Refresh" content="0;url=https://evil.example/">',
  '<title>Test viewer</title>',
  '</head>',
  '<body><div id="app"></div></body>',
  '</html>',
  '',
].join('\n');

const tempRoots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => closeServer(server)));
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  workspace: string;
  extensionRoot: string;
  uiRoot: string;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-views-'));
  tempRoots.push(dir);
  return dir;
}

async function createFixture(): Promise<Fixture> {
  const workspace = await tempDir();
  const extensionRoot = path.join(workspace, 'extensions', EXTENSION_ID);
  const uiRoot = path.join(extensionRoot, 'ui');
  await mkdir(path.join(uiRoot, 'sub'), { recursive: true });
  await writeFile(path.join(uiRoot, 'entry.html'), ENTRY_CONTENT, 'utf8');
  await writeFile(path.join(uiRoot, 'fragment.html'), '<div id="frag">hello</div>', 'utf8');
  await writeFile(path.join(uiRoot, 'app.js'), 'window.__viewer = true;', 'utf8');
  await writeFile(path.join(uiRoot, 'styles.css'), 'body { margin: 0; }', 'utf8');
  await writeFile(path.join(uiRoot, 'sub', 'data.json'), '{"ok":true}', 'utf8');
  return { workspace, extensionRoot, uiRoot };
}

function mainViewer(fixture: Fixture): ViewViewerInfo {
  return {
    extensionId: EXTENSION_ID,
    viewId: 'main',
    entryPath: path.join(fixture.uiRoot, 'entry.html'),
    resourceRoots: [fixture.uiRoot],
    surface: 'file',
    extensionRoot: fixture.extensionRoot,
    capabilities: { document: { read: true } },
  };
}

function fragmentViewer(fixture: Fixture): ViewViewerInfo {
  return {
    extensionId: EXTENSION_ID,
    viewId: 'fragment',
    entryPath: path.join(fixture.uiRoot, 'fragment.html'),
    resourceRoots: [fixture.uiRoot],
    surface: 'tab',
    extensionRoot: fixture.extensionRoot,
  };
}

interface ServiceOptions {
  now?: () => number;
  instanceTtlMs?: number;
  maxInstances?: number;
  maxAssetBytes?: number;
}

function createService(fixture: Fixture, options: ServiceOptions = {}): ExtensionViewService {
  const viewers: ViewViewerInfo[] = [mainViewer(fixture), fragmentViewer(fixture)];
  const byKey = new Map(viewers.map(viewer => [viewer.extensionId + ':' + viewer.viewId, viewer]));
  return new ExtensionViewService({
    workspace: fixture.workspace,
    resolveViewer: (extensionId, viewId) => byKey.get(extensionId + ':' + viewId) ?? null,
    sdkPath: SDK_PATH,
    ...options,
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

function jsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  return parsed as Record<string, unknown>;
}

interface RouteServer {
  baseUrl: string;
  service: ExtensionViewService;
}

async function startRouteServer(service: ExtensionViewService, hostToken: string | undefined = HOST_TOKEN): Promise<RouteServer> {
  let baseUrl = 'http://127.0.0.1';
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', baseUrl);
      const ctx: ExtensionViewRouteContext = {
        service,
        json: jsonResponse,
        readBody,
        baseUrl,
        sdkPath: SDK_PATH,
        tokenAuthAlreadyChecked: false,
        hostToken,
      };
      const handled = await handleExtensionViewRoute(req, res, url, ctx);
      if (!handled) jsonResponse(res, 404, { error: 'not_found' });
    } catch {
      if (!res.headersSent) jsonResponse(res, 500, { error: 'internal_error' });
      else res.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = 'http://127.0.0.1:' + address.port;
  servers.push(server);
  return { baseUrl, service };
}

interface CreatedInstance {
  instanceId: string;
  entryUrl: string;
  token: string;
  sdkUrl: string;
  expiresAt: string;
}

async function createViaRoute(routeServer: RouteServer, body: Record<string, unknown>): Promise<CreatedInstance> {
  const response = await fetch(routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hcanvas-token': HOST_TOKEN },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return await response.json() as CreatedInstance;
}

interface RawResponse {
  status: number;
  body: string;
}

function rawGet(baseUrl: string, rawPath: string): Promise<RawResponse> {
  const parsed = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ host: parsed.hostname, port: Number(parsed.port), method: 'GET', path: rawPath }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end();
  });
}

interface FakeResponseState {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}

function fakeResponse(): { res: ServerResponse; state: FakeResponseState } {
  const state: FakeResponseState = { statusCode: 0, headers: {}, body: '', ended: false };
  const res = {
    headersSent: false,
    writeHead(statusCode: number, headers?: Record<string, string>) {
      state.statusCode = statusCode;
      state.headers = headers ?? {};
      (this as { headersSent: boolean }).headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined && chunk !== null) state.body += String(chunk);
      state.ended = true;
    },
    destroy() {
      state.ended = true;
    },
  };
  return { res: res as unknown as ServerResponse, state };
}

function offlineContext(service: ExtensionViewService): ExtensionViewRouteContext {
  return {
    service,
    json: jsonResponse,
    readBody,
    baseUrl: 'http://127.0.0.1:4319',
    sdkPath: SDK_PATH,
    tokenAuthAlreadyChecked: true,
  };
}

describe('cspFor', () => {
  it('matches SPEC-5.3 and normalizes the host origin', () => {
    const expected = "default-src 'none'; script-src 'unsafe-inline' http://127.0.0.1:4319; " +
      "style-src 'unsafe-inline' http://127.0.0.1:4319; img-src data: blob: http://127.0.0.1:4319; " +
      'font-src data: http://127.0.0.1:4319; media-src http://127.0.0.1:4319; ' +
      'connect-src http://127.0.0.1:4319; frame-src ' + "'none'" + '; object-src ' + "'none'" + '; ' +
      'base-uri ' + "'none'" + '; form-action ' + "'none'";
    expect(cspFor('http://127.0.0.1:4319')).toBe(expected);
    expect(cspFor('http://127.0.0.1:4319/')).toBe(expected);
    expect(cspFor('')).toBe(cspFor('not a url'));
    expect(cspFor('file:///tmp/viewer.html')).toBe(cspFor(''));
    expect(cspFor('ftp://example.com')).toBe(cspFor(''));
    expect(cspFor('')).toContain("default-src 'none'");
    expect(cspFor('')).not.toContain('http://');
  });
});

describe('ExtensionViewService', () => {
  it('creates, validates and deletes an instance', async () => {
    const fixture = await createFixture();
    const service = createService(fixture);
    const created = await service.createInstance({
      extensionId: EXTENSION_ID,
      viewId: 'main',
      context: { surface: 'tab', format: 'svg', file: { path: 'a.svg', readOnly: false } },
    });
    expect(created.instanceId).toMatch(/^view_[0-9a-f]{12}$/);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(Date.parse(created.expiresAt)).toBeGreaterThan(Date.now());
    const instance = service.validate(created.instanceId, created.token);
    expect(instance).not.toBeNull();
    expect(instance?.extensionId).toBe(EXTENSION_ID);
    expect(instance?.viewId).toBe('main');
    expect(instance?.surface).toBe('tab');
    const bare = await service.createInstance({ extensionId: EXTENSION_ID, viewId: 'main' });
    expect(service.validate(bare.instanceId, bare.token)?.surface).toBe('file');
    expect(instance?.context).toEqual({ surface: 'tab', format: 'svg', file: { path: 'a.svg', readOnly: false } });
    expect(service.validate(created.instanceId, 'wrong-token')).toBeNull();
    expect(service.validate('view_000000000000', created.token)).toBeNull();
    expect(service.delete(created.instanceId)).toBe(true);
    expect(service.validate(created.instanceId, created.token)).toBeNull();
    expect(service.delete(created.instanceId)).toBe(false);
  });

  it('rejects unknown viewers, malformed ids and oversized contexts', async () => {
    const fixture = await createFixture();
    const service = createService(fixture);
    await expect(service.createInstance({ extensionId: EXTENSION_ID, viewId: 'missing' }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(service.createInstance({ extensionId: 'Bad/Id', viewId: 'main' }))
      .rejects.toMatchObject({ code: 'invalid_params' });
    await expect(service.createInstance({ extensionId: EXTENSION_ID, viewId: 'a/b' }))
      .rejects.toMatchObject({ code: 'invalid_params' });
    await expect(service.createInstance({
      extensionId: EXTENSION_ID,
      viewId: 'main',
      context: { big: 'x'.repeat(VIEW_CONTEXT_MAX_BYTES + 1) },
    })).rejects.toMatchObject({ code: 'invalid_params' });
    const withMax = createService(fixture, { maxInstances: 1 });
    await withMax.createInstance({ extensionId: EXTENSION_ID, viewId: 'main' });
    await expect(withMax.createInstance({ extensionId: EXTENSION_ID, viewId: 'main' }))
      .rejects.toMatchObject({ code: 'limit_exceeded' });
  });

  it('expires instances lazily and sweeps them', async () => {
    const fixture = await createFixture();
    let clock = 1_000_000;
    const service = createService(fixture, { now: () => clock, instanceTtlMs: 60_000 });
    const created = await service.createInstance({ extensionId: EXTENSION_ID, viewId: 'main' });
    expect(service.validate(created.instanceId, created.token)).not.toBeNull();
    clock += 60_001;
    expect(service.validate(created.instanceId, created.token)).toBeNull();
    const second = await service.createInstance({ extensionId: EXTENSION_ID, viewId: 'main' });
    clock += 61_000;
    expect(service.sweepExpired()).toBe(1);
    expect(service.validate(second.instanceId, second.token)).toBeNull();
    expect(DEFAULT_INSTANCE_TTL_MS).toBe(60 * 60 * 1000);
  });

  it('destroys instances per extension and all at once', async () => {
    const fixture = await createFixture();
    const service = createService(fixture);
    const first = await service.createInstance({ extensionId: EXTENSION_ID, viewId: 'main' });
    const second = await service.createInstance({ extensionId: EXTENSION_ID, viewId: 'fragment' });
    expect(service.instanceCount).toBe(2);
    expect(service.deleteByExtension(EXTENSION_ID)).toBe(2);
    expect(service.instanceCount).toBe(0);
    expect(service.validate(first.instanceId, first.token)).toBeNull();
    expect(service.validate(second.instanceId, second.token)).toBeNull();
    await service.createInstance({ extensionId: EXTENSION_ID, viewId: 'main' });
    await service.createInstance({ extensionId: EXTENSION_ID, viewId: 'fragment' });
    expect(service.deleteAll()).toBe(2);
    expect(service.instanceCount).toBe(0);
  });

  it('freezes a JSON-safe context snapshot', async () => {
    const fixture = await createFixture();
    const service = createService(fixture);
    const source = { format: 'svg', nested: { value: 1 } };
    const created = await service.createInstance({ extensionId: EXTENSION_ID, viewId: 'main', context: source });
    source.nested.value = 99;
    const instance = service.validate(created.instanceId, created.token);
    expect(instance?.context.nested).toEqual({ value: 1 });
    expect(Object.isFrozen(instance?.context)).toBe(false);
  });

  it('rejects viewer entries and resource roots outside the extension root', async () => {
    const fixture = await createFixture();
    const service = new ExtensionViewService({
      workspace: fixture.workspace,
      sdkPath: SDK_PATH,
      resolveViewer: () => ({
        extensionId: EXTENSION_ID,
        viewId: 'evil',
        entryPath: path.join(fixture.workspace, 'secret.html'),
        resourceRoots: [fixture.workspace],
        extensionRoot: fixture.extensionRoot,
      }),
    });
    await expect(service.createInstance({ extensionId: EXTENSION_ID, viewId: 'evil' }))
      .rejects.toMatchObject({ code: 'path_forbidden' });
  });

  it('injects context, SDK script and CSP meta, and strips meta refresh', async () => {
    const fixture = await createFixture();
    const service = createService(fixture);
    const created = await service.createInstance({
      extensionId: EXTENSION_ID,
      viewId: 'main',
      context: { surface: 'tab', format: 'svg', locale: 'zh', theme: 'dark' },
    });
    const entry = await service.readEntry(created.instanceId, created.token, { hostOrigin: 'http://127.0.0.1:4319' });
    expect(entry).not.toBeNull();
    const html = entry!.html;
    expect(html).toContain('window.hcViewContext = {"instanceId":"' + created.instanceId + '"');
    expect(html).toContain('"extensionId":"' + EXTENSION_ID + '"');
    expect(html).toContain('"viewId":"main"');
    expect(html).toContain('"surface":"tab"');
    expect(html).toContain('"format":"svg"');
    expect(html).toContain('"locale":"zh"');
    expect(html).toContain('"theme":"dark"');
    expect(html).toContain('"token":"' + created.token + '"');
    expect(html).toContain('<script src="' + SDK_PATH + '"></script>');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html.toLowerCase()).not.toContain('http-equiv="refresh"');
    expect(html.indexOf('window.hcViewContext')).toBeLessThan(html.indexOf('</body>'));
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('</head>'));
    expect(entry!.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(entry!.headers['content-security-policy']).toContain("default-src 'none'");
    expect(entry!.headers['content-security-policy']).toContain('http://127.0.0.1:4319');
    expect(entry!.headers['x-content-type-options']).toBe('nosniff');
    expect(entry!.headers['referrer-policy']).toBe('no-referrer');
    expect(entry!.headers['cache-control']).toBe('no-store');
    expect(await service.readEntry(created.instanceId, 'wrong-token')).toBeNull();
  });

  it('wraps fragment entries in a minimal document', async () => {
    const fixture = await createFixture();
    const service = createService(fixture);
    const created = await service.createInstance({ extensionId: EXTENSION_ID, viewId: 'fragment' });
    const entry = await service.readEntry(created.instanceId, created.token);
    expect(entry!.html.startsWith('<!doctype html>')).toBe(true);
    expect(entry!.html).toContain('<html>');
    expect(entry!.html).toContain('<div id="frag">hello</div>');
    expect(entry!.html).toContain('window.hcViewContext');
    expect(entry!.html).toContain('</body>');
  });

  it('escapes script-breaking context values', async () => {
    const fixture = await createFixture();
    const service = createService(fixture);
    const created = await service.createInstance({
      extensionId: EXTENSION_ID,
      viewId: 'main',
      context: { format: '</script><script>alert(1)</script>' },
    });
    const entry = await service.readEntry(created.instanceId, created.token);
    expect(entry).not.toBeNull();
    expect(entry!.html).not.toContain('</script><script>alert(1)');
    expect(entry!.html).toContain('\\u003c/script\\u003e');
  });

  it('serves contained assets with CORS, cache and MIME headers', async () => {
    const fixture = await createFixture();
    const service = createService(fixture);
    const created = await service.createInstance({ extensionId: EXTENSION_ID, viewId: 'main' });
    const script = await service.readAsset(created.instanceId, created.token, 'app.js');
    expect(script).not.toBeNull();
    expect(script!.mime).toBe('text/javascript; charset=utf-8');
    expect(script!.filePath).toBe(path.join(fixture.uiRoot, 'app.js'));
    expect(script!.size).toBe(Buffer.byteLength('window.__viewer = true;'));
    expect(script!.headers['access-control-allow-origin']).toBe('*');
    expect(script!.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(script!.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    const nested = await service.readAsset(created.instanceId, created.token, 'sub/data.json');
    expect(nested?.mime).toBe('application/json; charset=utf-8');
    expect(await service.readAsset(created.instanceId, created.token, 'sub')).toBeNull();
    expect(await service.readAsset(created.instanceId, 'wrong-token', 'app.js')).toBeNull();
    const other = await service.createInstance({ extensionId: EXTENSION_ID, viewId: 'main' });
    expect(await service.readAsset(other.instanceId, created.token, 'app.js')).toBeNull();
  });

  it('rejects traversal, absolute paths and symlink escapes', async () => {
    const fixture = await createFixture();
    const service = createService(fixture);
    const created = await service.createInstance({ extensionId: EXTENSION_ID, viewId: 'main' });
    const { instanceId, token } = created;
    await expect(service.readAsset(instanceId, token, '../entry.html')).rejects.toMatchObject({ code: 'path_forbidden' });
    await expect(service.readAsset(instanceId, token, 'sub/../../secret.txt')).rejects.toMatchObject({ code: 'path_forbidden' });
    await expect(service.readAsset(instanceId, token, '/etc/passwd')).rejects.toMatchObject({ code: 'path_forbidden' });
    await expect(service.readAsset(instanceId, token, 'C:/Windows/win.ini')).rejects.toMatchObject({ code: 'path_forbidden' });
    await expect(service.readAsset(instanceId, token, '..\\..\\secret.txt')).rejects.toMatchObject({ code: 'path_forbidden' });
    const secret = path.join(fixture.workspace, 'secret.txt');
    await writeFile(secret, 'top secret', 'utf8');
    let linked = false;
    try {
      await symlink(secret, path.join(fixture.uiRoot, 'escape.txt'));
      linked = true;
    } catch {
      // Windows without symlink privileges: traversal checks above still apply.
    }
    if (linked) {
      await expect(service.readAsset(instanceId, token, 'escape.txt')).rejects.toMatchObject({ code: 'path_forbidden' });
    }
  });

  it('rejects assets above the 64 MiB cap', async () => {
    const fixture = await createFixture();
    const service = createService(fixture);
    const created = await service.createInstance({ extensionId: EXTENSION_ID, viewId: 'main' });
    const bigFile = path.join(fixture.uiRoot, 'big.bin');
    await writeFile(bigFile, Buffer.alloc(0));
    await truncate(bigFile, VIEW_ASSET_MAX_BYTES + 1);
    await expect(service.readAsset(created.instanceId, created.token, 'big.bin'))
      .rejects.toMatchObject({ code: 'limit_exceeded' });
  });
});

describe('handleExtensionViewRoute', () => {
  it('creates, serves entry/assets and deletes an instance over HTTP', async () => {
    const fixture = await createFixture();
    const service = createService(fixture);
    const routeServer = await startRouteServer(service);

    const unauthorized = await fetch(routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ extensionId: EXTENSION_ID, viewId: 'main' }),
    });
    expect(unauthorized.status).toBe(401);

    const created = await createViaRoute(routeServer, {
      extensionId: EXTENSION_ID,
      viewId: 'main',
      context: { surface: 'tab', format: 'svg', file: { path: 'a.svg', readOnly: false } },
    });
    expect(created.instanceId).toMatch(/^view_[0-9a-f]{12}$/);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(created.entryUrl.startsWith(routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX + '/' + created.instanceId + '/entry?token=')).toBe(true);
    expect(created.sdkUrl).toBe(SDK_PATH);
    expect(Number.isNaN(Date.parse(created.expiresAt))).toBe(false);
    const validated = service.validate(created.instanceId, created.token);
    expect(validated?.context).toEqual({ surface: 'tab', format: 'svg', file: { path: 'a.svg', readOnly: false } });

    const entryResponse = await fetch(created.entryUrl);
    expect(entryResponse.status).toBe(200);
    expect(entryResponse.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(entryResponse.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(entryResponse.headers.get('content-security-policy')).toContain(routeServer.baseUrl);
    expect(entryResponse.headers.get('x-content-type-options')).toBe('nosniff');
    expect(entryResponse.headers.get('referrer-policy')).toBe('no-referrer');
    expect(entryResponse.headers.get('cache-control')).toBe('no-store');
    const entryHtml = await entryResponse.text();
    expect(entryHtml).toContain('window.hcViewContext');
    expect(entryHtml).toContain('<script src="' + SDK_PATH + '"></script>');
    expect(entryHtml.toLowerCase()).not.toContain('http-equiv="refresh"');

    const assetUrl = routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX + '/' + created.instanceId + '/assets/app.js?token=' + encodeURIComponent(created.token);
    const assetResponse = await fetch(assetUrl);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(assetResponse.headers.get('access-control-allow-origin')).toBe('*');
    expect(assetResponse.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(assetResponse.headers.get('cache-control')).toContain('immutable');
    expect(await assetResponse.text()).toBe('window.__viewer = true;');

    const nestedResponse = await fetch(routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX + '/' + created.instanceId + '/assets/sub/data.json?token=' + encodeURIComponent(created.token));
    expect(nestedResponse.status).toBe(200);
    expect(await nestedResponse.json()).toEqual({ ok: true });

    const wrongTokenEntry = await fetch(routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX + '/' + created.instanceId + '/entry?token=wrong');
    expect(wrongTokenEntry.status).toBe(404);
    const missingTokenEntry = await fetch(routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX + '/' + created.instanceId + '/entry');
    expect(missingTokenEntry.status).toBe(404);
    const missingAsset = await fetch(routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX + '/' + created.instanceId + '/assets/nope.js?token=' + encodeURIComponent(created.token));
    expect(missingAsset.status).toBe(404);

    const unauthorizedDelete = await fetch(routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX + '/' + created.instanceId, { method: 'DELETE' });
    expect(unauthorizedDelete.status).toBe(401);
    const deleteResponse = await fetch(routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX + '/' + created.instanceId, {
      method: 'DELETE',
      headers: { 'x-hcanvas-token': HOST_TOKEN },
    });
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({ ok: true });
    const afterDelete = await fetch(created.entryUrl);
    expect(afterDelete.status).toBe(404);
    const secondDelete = await fetch(routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX + '/' + created.instanceId, {
      method: 'DELETE',
      headers: { 'x-hcanvas-token': HOST_TOKEN },
    });
    expect(secondDelete.status).toBe(404);
  });

  it('rejects unknown viewers, malformed bodies and unsupported methods', async () => {
    const fixture = await createFixture();
    const service = createService(fixture);
    const routeServer = await startRouteServer(service);

    const unknown = await fetch(routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hcanvas-token': HOST_TOKEN },
      body: JSON.stringify({ extensionId: EXTENSION_ID, viewId: 'missing' }),
    });
    expect(unknown.status).toBe(400);
    expect((await unknown.json() as { error: string }).error).toBe('unknown_reference');

    const invalidBody = await fetch(routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hcanvas-token': HOST_TOKEN },
      body: 'not json',
    });
    expect(invalidBody.status).toBe(400);
    expect((await invalidBody.json() as { error: string }).error).toBe('invalid_params');

    const missingView = await fetch(routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hcanvas-token': HOST_TOKEN },
      body: JSON.stringify({ extensionId: EXTENSION_ID }),
    });
    expect(missingView.status).toBe(400);

    const wrongMethod = await fetch(routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-hcanvas-token': HOST_TOKEN },
      body: '{}',
    });
    expect(wrongMethod.status).toBe(405);
  });

  it('serves expired instances with 404 after the TTL elapses', async () => {
    const fixture = await createFixture();
    let clock = 2_000_000;
    const service = createService(fixture, { now: () => clock, instanceTtlMs: 60_000 });
    const routeServer = await startRouteServer(service);
    const created = await createViaRoute(routeServer, { extensionId: EXTENSION_ID, viewId: 'main' });
    expect((await fetch(created.entryUrl)).status).toBe(200);
    clock += 60_001;
    expect((await fetch(created.entryUrl)).status).toBe(404);
  });

  it('rejects encoded traversal at the HTTP layer with 403', async () => {
    const fixture = await createFixture();
    const service = createService(fixture);
    const routeServer = await startRouteServer(service);
    const created = await createViaRoute(routeServer, { extensionId: EXTENSION_ID, viewId: 'main' });
    const base = routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX + '/' + created.instanceId + '/assets/';
    const tokenQuery = '?token=' + encodeURIComponent(created.token);
    const traversal = await rawGet(routeServer.baseUrl, EXTENSION_VIEW_ROUTE_PREFIX + '/' + created.instanceId + '/assets/..%2F..%2Fsecret.txt' + tokenQuery);
    expect(traversal.status).toBe(403);
    const absolute = await rawGet(routeServer.baseUrl, EXTENSION_VIEW_ROUTE_PREFIX + '/' + created.instanceId + '/assets/%2Fetc%2Fpasswd' + tokenQuery);
    expect(absolute.status).toBe(403);
    expect(base).toContain('/assets/');
  });

  it('returns false for unrelated routes and 405 for wrong methods', async () => {
    const fixture = await createFixture();
    const service = createService(fixture);
    const fake = fakeResponse();
    const unrelated = await handleExtensionViewRoute(
      { method: 'GET', headers: {} } as IncomingMessage,
      fake.res,
      new URL('http://127.0.0.1:4319/api/files/roots'),
      offlineContext(service),
    );
    expect(unrelated).toBe(false);
    expect(fake.state.ended).toBe(false);

    const collection = fakeResponse();
    const handled = await handleExtensionViewRoute(
      { method: 'GET', headers: {} } as IncomingMessage,
      collection.res,
      new URL('http://127.0.0.1:4319' + EXTENSION_VIEW_ROUTE_PREFIX),
      offlineContext(service),
    );
    expect(handled).toBe(true);
    expect(collection.state.statusCode).toBe(405);
    expect(JSON.parse(collection.state.body) as { error: string }).toEqual({ error: 'method_not_allowed', allowed: ['POST'] });
  });

  it('maps oversized assets to 413', async () => {
    const fixture = await createFixture();
    const service = createService(fixture);
    const routeServer = await startRouteServer(service);
    const created = await createViaRoute(routeServer, { extensionId: EXTENSION_ID, viewId: 'main' });
    const bigFile = path.join(fixture.uiRoot, 'big.bin');
    await writeFile(bigFile, Buffer.alloc(0));
    await truncate(bigFile, VIEW_ASSET_MAX_BYTES + 1);
    const response = await fetch(routeServer.baseUrl + EXTENSION_VIEW_ROUTE_PREFIX + '/' + created.instanceId + '/assets/big.bin?token=' + encodeURIComponent(created.token));
    expect(response.status).toBe(413);
    expect((await response.json() as { error: string }).error).toBe('limit_exceeded');
  });
});
