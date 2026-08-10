import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { GuiHttpRouter } from '../src/gui/guiHttpRouter.js';
import {
  registerGuiTeamHttpController,
  type GuiTeamHttpControllerPort,
} from '../src/gui/guiTeamHttpController.js';

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

function createPort(): GuiTeamHttpControllerPort {
  const ok = (body: Record<string, unknown> = {}) => ({ status: 200, body: { ok: true, ...body } });
  return {
    definition: vi.fn(name => ok({ name })),
    restoreDefault: vi.fn(name => ok({ name })),
    save: vi.fn(async body => ok(body)),
    scaffold: vi.fn(body => ok(body)),
    applyBlock: vi.fn(body => ok(body)),
    proposal: vi.fn(async (id, action, method, body) => ok({ id, action, method, ...body })),
    validate: vi.fn(body => ok(body)),
    upgrade: vi.fn(body => ok(body)),
    delete: vi.fn(async body => ok(body)),
    preferences: vi.fn(async body => ok(body)),
  };
}

async function invoke(
  port: GuiTeamHttpControllerPort,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<ReturnType<typeof response>> {
  const router = new GuiHttpRouter();
  registerGuiTeamHttpController(router, port);
  const res = response();
  expect(await router.handle(request(method, body), res, new URL(`http://localhost${pathname}`))).toBe(true);
  return res;
}

describe('GUI team HTTP controller', () => {
  it('delegates definition reads and default restoration by name', async () => {
    const port = createPort();
    await invoke(port, 'GET', '/api/team/definition?name=review%20graph');
    await invoke(port, 'GET', '/api/team/restore-default?name=workflow');

    expect(port.definition).toHaveBeenCalledWith('review graph');
    expect(port.restoreDefault).toHaveBeenCalledWith('workflow');
  });

  it('preserves graph and workflow mutation request bodies', async () => {
    const port = createPort();
    const definition = { name: 'pipeline', squadType: 'workflow' };
    await invoke(port, 'POST', '/api/team/save', { definition, target: 'project' });
    await invoke(port, 'POST', '/api/team/scaffold', { name: 'graph', template: 'parallel' });
    await invoke(port, 'POST', '/api/team/apply-block', { definition, block: 'loop' });

    expect(port.save).toHaveBeenCalledWith({ definition, target: 'project' });
    expect(port.scaffold).toHaveBeenCalledWith({ name: 'graph', template: 'parallel' });
    expect(port.applyBlock).toHaveBeenCalledWith({ definition, block: 'loop' });
  });

  it('maps proposal identifiers, actions, methods, and optional bodies', async () => {
    const port = createPort();
    await invoke(port, 'GET', '/api/team/proposals/proposal%3A1');
    await invoke(port, 'POST', '/api/team/proposals/proposal%3A1/apply', { editorBaseDigest: 'digest' });
    await invoke(port, 'POST', '/api/team/proposals/proposal%3A1/reject');

    expect(port.proposal).toHaveBeenNthCalledWith(1, 'proposal:1', undefined, 'GET', {});
    expect(port.proposal).toHaveBeenNthCalledWith(
      2,
      'proposal:1',
      'apply',
      'POST',
      { editorBaseDigest: 'digest' },
    );
    expect(port.proposal).toHaveBeenNthCalledWith(3, 'proposal:1', 'reject', 'POST', {});
  });

  it('delegates validation, upgrade, delete, and preferences without owning domain rules', async () => {
    const port = createPort();
    await invoke(port, 'POST', '/api/team/validate', { definition: { name: 'graph' } });
    await invoke(port, 'POST', '/api/team/upgrade', { name: 'legacy' });
    await invoke(port, 'POST', '/api/team/delete', { name: 'old', strategy: { type: 'leave' } });
    await invoke(port, 'POST', '/api/team/preferences', { autoInvoke: true });

    expect(port.validate).toHaveBeenCalledWith({ definition: { name: 'graph' } });
    expect(port.upgrade).toHaveBeenCalledWith({ name: 'legacy' });
    expect(port.delete).toHaveBeenCalledWith({ name: 'old', strategy: { type: 'leave' } });
    expect(port.preferences).toHaveBeenCalledWith({ autoInvoke: true });
  });
});
