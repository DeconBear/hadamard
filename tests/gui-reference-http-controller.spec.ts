import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import {
  registerGuiReferenceHttpController,
  type GuiReferenceHttpControllerPort,
} from '../src/gui/guiReferenceHttpController.js';
import { GuiHttpRouter } from '../src/gui/guiHttpRouter.js';

function request(method: string, body?: unknown): IncomingMessage {
  return {
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  } as unknown as IncomingMessage;
}

function response(): ServerResponse & { status?: number; body?: unknown } {
  const result = {
    writeHead: vi.fn((status: number) => {
      result.status = status;
      return result;
    }),
    end: vi.fn((body?: string | Buffer) => {
      result.body = typeof body === 'string' && body.startsWith('{') ? JSON.parse(body) : body;
      return result;
    }),
  } as unknown as ServerResponse & { status?: number; body?: unknown };
  return result;
}

function createPort(): GuiReferenceHttpControllerPort {
  const ok = (body: Record<string, unknown> = {}) => ({ status: 200, body });
  return {
    list: vi.fn(async (kind, name) => ok({ kind, name })),
    broken: vi.fn(async () => ok({ edges: [] })),
    rename: vi.fn(async body => ok(body)),
    repointModel: vi.fn(async body => ok(body)),
  };
}

async function invoke(
  port: GuiReferenceHttpControllerPort,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<ReturnType<typeof response>> {
  const router = new GuiHttpRouter();
  registerGuiReferenceHttpController(router, port);
  const res = response();
  expect(await router.handle(request(method, body), res, new URL(`http://localhost${pathname}`))).toBe(true);
  return res;
}

describe('GUI reference HTTP controller', () => {
  it('normalizes usage query parameters and delegates broken-reference reads', async () => {
    const port = createPort();
    await invoke(port, 'GET', '/api/references?kind=%20agent%20&name=%20reviewer%20');
    const broken = await invoke(port, 'GET', '/api/references/broken');

    expect(port.list).toHaveBeenCalledWith('agent', 'reviewer');
    expect(port.broken).toHaveBeenCalledOnce();
    expect(broken.body).toEqual({ edges: [] });
  });

  it('passes complete rename and model-repoint bodies unchanged', async () => {
    const port = createPort();
    const rename = { kind: 'agent', oldName: 'reviewer', newName: 'reviewer-v2' };
    const repoint = { config: 'default', fromModel: 'old', toModel: 'new' };
    await invoke(port, 'POST', '/api/references/rename', rename);
    await invoke(port, 'POST', '/api/references/repoint-model', repoint);

    expect(port.rename).toHaveBeenCalledWith(rename);
    expect(port.repointModel).toHaveBeenCalledWith(repoint);
  });
});
