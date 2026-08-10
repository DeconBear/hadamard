import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import {
  createHadamardGuiStyles,
} from '../src/gui/hadamardGuiAssets.js';
import { GuiHttpRouter } from '../src/gui/guiHttpRouter.js';
import { registerGuiShellHttpController } from '../src/gui/guiShellHttpController.js';

function request(method: string): IncomingMessage {
  return { method } as IncomingMessage;
}

function response(): ServerResponse & {
  capturedStatus?: number;
  capturedHeaders?: Record<string, string | number>;
  capturedBody?: string | Buffer;
} {
  const result = {
    writeHead: vi.fn((status: number, headers: Record<string, string | number>) => {
      result.capturedStatus = status;
      result.capturedHeaders = headers;
      return result;
    }),
    end: vi.fn((body?: string | Buffer) => {
      result.capturedBody = body;
      return result;
    }),
  } as unknown as ServerResponse & {
    capturedStatus?: number;
    capturedHeaders?: Record<string, string | number>;
    capturedBody?: string | Buffer;
  };
  return result;
}

describe('GuiHttpRouter', () => {
  it('matches exact, regular-expression, and predicate routes in registration order', async () => {
    const router = new GuiHttpRouter();
    const calls: string[] = [];
    router.route('GET', '/exact', () => { calls.push('exact'); });
    router.route('POST', /^\/items\/[^/]+$/u, () => { calls.push('regex'); });
    router.route('GET', url => url.pathname.startsWith('/assets/'), () => { calls.push('predicate'); });

    expect(await router.handle(request('GET'), response(), new URL('http://localhost/exact'))).toBe(true);
    expect(await router.handle(request('POST'), response(), new URL('http://localhost/items/one'))).toBe(true);
    expect(await router.handle(request('GET'), response(), new URL('http://localhost/assets/app.js'))).toBe(true);
    expect(await router.handle(request('DELETE'), response(), new URL('http://localhost/exact'))).toBe(false);
    expect(calls).toEqual(['exact', 'regex', 'predicate']);
  });
});

describe('GUI shell HTTP controller', () => {
  it('serves the unchanged GUI document with token injection and CSP', async () => {
    const router = new GuiHttpRouter();
    registerGuiShellHttpController(router, 'test-token');
    const res = response();

    expect(await router.handle(request('GET'), res, new URL('http://localhost/'))).toBe(true);
    expect(res.capturedStatus).toBe(200);
    expect(String(res.capturedBody)).toContain('window.__HADAMARD_TOKEN__="test-token";');
    expect(res.capturedHeaders?.['content-security-policy']).toContain("default-src 'none'");
  });

  it('serves the exact generated stylesheet through the registry', async () => {
    const router = new GuiHttpRouter();
    registerGuiShellHttpController(router, 'test-token');
    const res = response();

    expect(await router.handle(request('GET'), res, new URL('http://localhost/app.css'))).toBe(true);
    expect(res.capturedStatus).toBe(200);
    expect(res.capturedBody).toBe(createHadamardGuiStyles());
    expect(res.capturedHeaders?.['content-type']).toBe('text/css; charset=utf-8');
  });
});
