import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import {
  registerGuiAgentHttpController,
  type GuiAgentHttpControllerPort,
} from '../src/gui/guiAgentHttpController.js';
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

function createPort(): GuiAgentHttpControllerPort {
  const ok = (body: Record<string, unknown> = {}) => ({ status: 200, body: { ok: true, ...body } });
  return {
    listProfiles: vi.fn(() => ok({ profiles: [] })),
    saveProfile: vi.fn(async body => ok(body)),
    deleteProfile: vi.fn(async body => ok(body)),
    definition: vi.fn(name => ok({ name })),
    templates: vi.fn(() => ok({ templates: [] })),
    instantiateTemplate: vi.fn(async body => ok(body)),
    activate: vi.fn(async body => ok(body)),
  };
}

async function invoke(
  port: GuiAgentHttpControllerPort,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<ReturnType<typeof response>> {
  const router = new GuiHttpRouter();
  registerGuiAgentHttpController(router, port);
  const res = response();
  expect(await router.handle(request(method, body), res, new URL(`http://localhost${pathname}`))).toBe(true);
  return res;
}

describe('GUI agent HTTP controller', () => {
  it('lists profiles and resolves trimmed definition names', async () => {
    const port = createPort();
    const profiles = await invoke(port, 'GET', '/api/agent-profiles');
    await invoke(port, 'GET', '/api/agent-definition?name=%20reviewer%20');

    expect(profiles.body).toEqual({ ok: true, profiles: [] });
    expect(port.definition).toHaveBeenCalledWith('reviewer');
  });

  it('delegates complete profile save and delete bodies', async () => {
    const port = createPort();
    const profile = { name: 'reviewer', bridgeConfig: 'default', model: 'reasoning' };
    await invoke(port, 'POST', '/api/agent-profiles', profile);
    await invoke(port, 'POST', '/api/agent-profiles/delete', {
      name: 'reviewer',
      strategy: { type: 'leave' },
    });

    expect(port.saveProfile).toHaveBeenCalledWith(profile);
    expect(port.deleteProfile).toHaveBeenCalledWith({
      name: 'reviewer',
      strategy: { type: 'leave' },
    });
  });

  it('delegates template listing and instantiation', async () => {
    const port = createPort();
    await invoke(port, 'GET', '/api/agent-templates');
    await invoke(port, 'POST', '/api/agent-templates/instantiate', {
      name: 'code-reviewer',
      scope: 'personal',
    });

    expect(port.templates).toHaveBeenCalledOnce();
    expect(port.instantiateTemplate).toHaveBeenCalledWith({
      name: 'code-reviewer',
      scope: 'personal',
    });
  });

  it('passes configuration, model, and effort to agent activation', async () => {
    const port = createPort();
    await invoke(port, 'POST', '/api/agent/activate', {
      name: 'reviewer',
      bridgeConfig: 'default',
      model: 'reasoning',
      effort: 'high',
    });

    expect(port.activate).toHaveBeenCalledWith({
      name: 'reviewer',
      bridgeConfig: 'default',
      model: 'reasoning',
      effort: 'high',
    });
  });
});
