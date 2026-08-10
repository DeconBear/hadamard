import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import {
  registerGuiChatHttpController,
  type GuiChatHttpControllerPort,
} from '../src/gui/guiChatHttpController.js';
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

function createPort(): GuiChatHttpControllerPort {
  return {
    runtimeMutationInProgress: vi.fn(() => false),
    send: vi.fn(async () => undefined),
    sendIssue: vi.fn(async () => undefined),
    submitPendingInput: vi.fn(() => ({ active: true, pendingInputCount: 1 })),
    createSession: vi.fn(async () => ({ session: { id: 'new' } })),
    resumeSession: vi.fn(async () => ({ status: 200, state: { session: { id: 'resumed' } } })),
    resolvePermission: vi.fn(() => true),
    replayRun: vi.fn(() => ({ active: false, events: [] })),
    abortRun: vi.fn(() => true),
    mutationError: vi.fn(() => ({ status: 409, body: { error: 'busy' } })),
  };
}

async function invoke(
  port: GuiChatHttpControllerPort,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<ReturnType<typeof response>> {
  const router = new GuiHttpRouter();
  registerGuiChatHttpController(router, port);
  const res = response();
  expect(await router.handle(request(method, body), res, new URL(`http://localhost${pathname}`))).toBe(true);
  return res;
}

describe('GUI chat HTTP controller', () => {
  it('validates and dispatches normal and issue chat requests', async () => {
    const port = createPort();
    await invoke(port, 'POST', '/api/send', { text: 'hello', clientRequestId: 'client:1' });
    expect(port.send).toHaveBeenCalledWith('hello', expect.anything(), 'client:1');

    await invoke(port, 'POST', '/api/send', { text: '/issues start #7 reviewer' });
    expect(port.sendIssue).toHaveBeenCalledWith('#7', 'reviewer', expect.anything());

    const missing = await invoke(createPort(), 'POST', '/api/send', { text: '  ' });
    expect(missing.status).toBe(400);
    expect(missing.body).toEqual({ error: 'Missing text' });
  });

  it('preserves follow-up and steering queue responses', async () => {
    const port = createPort();
    const res = await invoke(port, 'POST', '/api/session/input', { text: 'more context', mode: 'steer' });
    expect(port.submitPendingInput).toHaveBeenCalledWith('more context', 'steer');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, mode: 'steer', pendingInputCount: 1 });

    vi.mocked(port.submitPendingInput).mockReturnValue({ active: false, pendingInputCount: 0 });
    const idle = await invoke(port, 'POST', '/api/session/input', { text: 'later' });
    expect(idle.status).toBe(409);
  });

  it('maps session creation and resume results without owning runtime state', async () => {
    const port = createPort();
    const created = await invoke(port, 'POST', '/api/session/new');
    expect(created.body).toEqual({ session: { id: 'new' } });

    const resumed = await invoke(port, 'POST', '/api/session/resume', { id: 'resumed' });
    expect(resumed.body).toEqual({ session: { id: 'resumed' } });

    vi.mocked(port.resumeSession).mockResolvedValue({ status: 404, error: 'Session not found' });
    const missing = await invoke(port, 'POST', '/api/session/resume', { id: 'missing' });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Session not found' });
  });

  it('validates permission decisions and delegates answers', async () => {
    const port = createPort();
    const invalid = await invoke(port, 'POST', '/api/permission', { id: 'p1', decision: 'maybe' });
    expect(invalid.status).toBe(400);

    const allowed = await invoke(port, 'POST', '/api/permission', {
      id: 'p1',
      decision: 'allow',
      answers: { choice: 'yes', ignored: 1 },
    });
    expect(port.resolvePermission).toHaveBeenCalledWith('p1', 'allow', { choice: 'yes' });
    expect(allowed.body).toEqual({ ok: true });
  });

  it('delegates run replay cursors and abort requests', async () => {
    const port = createPort();
    await invoke(port, 'GET', '/api/run/events?runId=run-1&after=4');
    expect(port.replayRun).toHaveBeenCalledWith('run-1', 4);

    const aborted = await invoke(port, 'POST', '/api/abort', { runId: 'run-1' });
    expect(port.abortRun).toHaveBeenCalledWith('run-1');
    expect(aborted.body).toEqual({ ok: true, aborted: true });
  });
});
