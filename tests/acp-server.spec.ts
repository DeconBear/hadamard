import { Readable, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { AcpServer, AcpStdioTransport, CleanAcpEngine } from '../src/acp/index.js';
import {
  ACP_ERROR_INVALID_PARAMS,
  ACP_ERROR_METHOD_NOT_FOUND,
  ACP_ERROR_PARSE,
} from '../src/acp/acpProtocol.js';
import type { HadamardAgentClient } from '../src/runtime/agentClient.js';
import type { AgentSession } from '../src/runtime/agentSession.js';
import type { AgentRunStream } from '../src/runtime/asyncQueue.js';
import type { AgentEvent, AgentRunResult } from '../src/types.js';

const CHANNEL = { notify: vi.fn(), request: vi.fn(async () => ({})) };

function runResult(stopReason: AgentRunResult['stopReason']): AgentRunResult {
  return {
    runId: 'run-1',
    model: 'test-model',
    text: 'done',
    message: { role: 'assistant' } as AgentRunResult['message'],
    messages: [],
    stopReason,
    requests: [],
    toolCalls: [],
    startedAt: 't',
    completedAt: 't',
  };
}

/** A stream that replays events, then settles with the given result. */
function replayStream(events: AgentEvent[], result: AgentRunResult): AgentRunStream {
  const stream = {
    result: Promise.resolve(result),
    isCancelled: false,
    cancel: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
  return stream as unknown as AgentRunStream;
}

/** A stream that blocks until cancelled, then fails like the real AgentRunStream. */
function cancellableStream(): AgentRunStream {
  const state = { cancelled: false };
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<AgentRunResult>((_, reject) => { rejectResult = reject; });
  void result.catch(() => undefined);
  let wake!: () => void;
  const gate = new Promise<void>(resolve => { wake = resolve; });
  const abortError = () => {
    const error = new Error('cancelled');
    error.name = 'RunAbortedError';
    return error;
  };
  const stream = {
    result,
    get isCancelled() { return state.cancelled; },
    cancel: vi.fn(() => {
      if (state.cancelled) return;
      state.cancelled = true;
      rejectResult(abortError());
      wake();
    }),
    async *[Symbol.asyncIterator]() {
      await gate;
      if (state.cancelled) throw abortError();
    },
  };
  return stream as unknown as AgentRunStream;
}

function fakeSdk(stream: AgentRunStream) {
  const session = {
    id: 'session-1',
    stream: vi.fn(() => stream),
  } as unknown as AgentSession;
  const sdk = {
    createSession: vi.fn(async () => session),
  } as unknown as HadamardAgentClient;
  return { sdk, session };
}

function request(id: number, method: string, params?: unknown) {
  return { kind: 'request' as const, id, method, params };
}

async function newSession(server: AcpServer, cwd = process.cwd()) {
  const response = await server.handleRequest(request(1, 'session/new', { cwd }), CHANNEL);
  return (response as { result: { sessionId: string } }).result.sessionId;
}

describe('AcpServer', () => {
  it('answers initialize with v1 capabilities and no auth methods', async () => {
    const { sdk } = fakeSdk(replayStream([], runResult('end_turn')));
    const server = new AcpServer({ engine: new CleanAcpEngine(sdk) });
    const response = await server.handleRequest(
      request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} }),
      CHANNEL,
    );
    expect(response).toMatchObject({
      id: 1,
      result: {
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: { loadSession: false },
      },
    });
  });

  it('creates sessions for absolute cwds and rejects relative ones', async () => {
    const { sdk } = fakeSdk(replayStream([], runResult('end_turn')));
    const server = new AcpServer({ engine: new CleanAcpEngine(sdk) });
    const created = await server.handleRequest(request(1, 'session/new', { cwd: process.cwd() }), CHANNEL);
    expect(created).toMatchObject({ result: { sessionId: 'session-1' } });
    const rejected = await server.handleRequest(request(2, 'session/new', { cwd: 'relative/dir' }), CHANNEL);
    expect(rejected).toMatchObject({ error: { code: ACP_ERROR_INVALID_PARAMS } });
  });

  it('fails closed on unknown methods and unknown sessions', async () => {
    const { sdk } = fakeSdk(replayStream([], runResult('end_turn')));
    const server = new AcpServer({ engine: new CleanAcpEngine(sdk) });
    const unknown = await server.handleRequest(request(1, 'session/load', {}), CHANNEL);
    expect(unknown).toMatchObject({ error: { code: ACP_ERROR_METHOD_NOT_FOUND } });
    const prompt = await server.handleRequest(
      request(2, 'session/prompt', { sessionId: 'ghost', prompt: [{ type: 'text', text: 'hi' }] }),
      CHANNEL,
    );
    expect(prompt).toMatchObject({ error: { code: ACP_ERROR_INVALID_PARAMS } });
  });

  it('streams mapped session/update notifications and ends with end_turn', async () => {
    const events: AgentEvent[] = [
      { type: 'response.text.delta', runId: 'r', iteration: 1, delta: 'Hello', snapshot: 'Hello', timestamp: 't' },
      {
        type: 'tool.call', runId: 'r', iteration: 1, timestamp: 't',
        call: { id: 'tc-1', name: 'read', publicName: 'Read', provider: 'local', input: { file_path: 'x' }, startedAt: 't' },
      },
      {
        type: 'tool.result', runId: 'r', iteration: 1, timestamp: 't',
        result: {
          id: 'tc-1', name: 'read', publicName: 'Read', provider: 'local', input: {},
          startedAt: 't', outputText: 'file body', isError: false, completedAt: 't', durationMs: 3,
        },
      },
      { type: 'response.text.delta', runId: 'r', iteration: 1, delta: ' world', snapshot: 'Hello world', timestamp: 't' },
    ];
    const { sdk, session } = fakeSdk(replayStream(events, runResult('end_turn')));
    const server = new AcpServer({ engine: new CleanAcpEngine(sdk) });
    const sessionId = await newSession(server);
    const channel = { notify: vi.fn(), request: vi.fn(async () => ({})) };

    const response = await server.handleRequest(
      request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'do it' }] }),
      channel,
    );

    expect(response).toMatchObject({ id: 2, result: { stopReason: 'end_turn' } });
    expect(session.stream).toHaveBeenCalledWith(
      [{ type: 'text', text: 'do it' }],
      expect.objectContaining({ approver: expect.any(Function) }),
    );
    const updates = channel.notify.mock.calls.map(
      call => call[1] as { sessionId: string; update: { sessionUpdate: string } },
    );
    expect(updates.map(entry => entry.update.sessionUpdate)).toEqual([
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
    ]);
    expect(updates.every(entry => entry.sessionId === sessionId)).toBe(true);
  });

  it('maps maxToolIterationsExceeded to max_turn_requests', async () => {
    const result = { ...runResult(null), maxToolIterationsExceeded: true };
    const { sdk } = fakeSdk(replayStream([], result));
    const server = new AcpServer({ engine: new CleanAcpEngine(sdk) });
    const sessionId = await newSession(server);
    const response = await server.handleRequest(
      request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'spin' }] }),
      CHANNEL,
    );
    expect(response).toMatchObject({ result: { stopReason: 'max_turn_requests' } });
  });

  it('answers an in-flight prompt with cancelled when session/cancel arrives', async () => {
    const stream = cancellableStream();
    const { sdk } = fakeSdk(stream);
    const server = new AcpServer({ engine: new CleanAcpEngine(sdk) });
    const sessionId = await newSession(server);

    const promptPromise = server.handleRequest(
      request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'long task' }] }),
      CHANNEL,
    );
    await new Promise(resolve => setImmediate(resolve));
    await server.handleNotification({ kind: 'notification', method: 'session/cancel', params: { sessionId } });

    await expect(promptPromise).resolves.toMatchObject({ result: { stopReason: 'cancelled' } });
    expect(stream.cancel).toHaveBeenCalledOnce();
  });

  it('treats cancel of an idle session as a no-op', async () => {
    const { sdk } = fakeSdk(replayStream([], runResult('end_turn')));
    const server = new AcpServer({ engine: new CleanAcpEngine(sdk) });
    await newSession(server);
    await expect(server.handleNotification(
      { kind: 'notification', method: 'session/cancel', params: { sessionId: 'session-1' } },
    )).resolves.toBeUndefined();
    await expect(server.handleNotification(
      { kind: 'notification', method: 'session/cancel', params: { sessionId: 'nobody' } },
    )).resolves.toBeUndefined();
  });

  it('surfaces non-abort run failures as internal JSON-RPC errors', async () => {
    const failing = {
      result: Promise.reject(new Error('provider exploded')),
      isCancelled: false,
      cancel: vi.fn(),
      async *[Symbol.asyncIterator]() {
        throw new Error('provider exploded');
      },
    };
    void failing.result.catch(() => undefined);
    const { sdk } = fakeSdk(failing as unknown as AgentRunStream);
    const server = new AcpServer({ engine: new CleanAcpEngine(sdk) });
    const sessionId = await newSession(server);
    const response = await server.handleRequest(
      request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'boom' }] }),
      CHANNEL,
    );
    expect(response).toMatchObject({ error: { code: -32603, message: 'provider exploded' } });
  });
});

describe('AcpStdioTransport', () => {
  function harness(sdk: HadamardAgentClient) {
    const writes: string[] = [];
    const input = new Readable({ read() { /* pushed manually */ } });
    const output = new Writable({
      write(chunk, _encoding, callback) {
        writes.push(String(chunk));
        callback();
      },
    });
    const server = new AcpServer({ engine: new CleanAcpEngine(sdk) });
    const transport = new AcpStdioTransport(server, input, output, () => undefined);
    return { input, output, writes, server, transport };
  }

  function written(writes: string[]): unknown[] {
    return writes.map(line => JSON.parse(line) as unknown);
  }

  it('serves a full initialize + session/new + prompt round over NDJSON', async () => {
    const { sdk } = fakeSdk(replayStream(
      [{ type: 'response.text.delta', runId: 'r', iteration: 1, delta: 'hi', snapshot: 'hi', timestamp: 't' }],
      runResult('end_turn'),
    ));
    const { input, writes, transport } = harness(sdk);
    const done = transport.start();
    input.push(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`);
    input.push(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd() } })}\n`);
    await vi.waitFor(() => expect(writes.length).toBeGreaterThanOrEqual(2));
    const created = written(writes)[1] as { result: { sessionId: string } };
    input.push(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: 'go' }] } })}\n`);
    await vi.waitFor(() => expect(writes.length).toBeGreaterThanOrEqual(4));
    input.push(null);
    await done;

    const messages = written(writes) as Record<string, unknown>[];
    expect(messages[0]).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
    expect(messages[2]).toMatchObject({ method: 'session/update' });
    expect(messages.at(-1)).toMatchObject({ id: 3, result: { stopReason: 'end_turn' } });
  });

  it('answers parse errors with -32700 and a null id', async () => {
    const { sdk } = fakeSdk(replayStream([], runResult('end_turn')));
    const { input, writes, transport } = harness(sdk);
    const done = transport.start();
    input.push('this is not json\n');
    await vi.waitFor(() => expect(writes.length).toBe(1));
    input.push(null);
    await done;
    expect(written(writes)[0]).toMatchObject({ id: null, error: { code: ACP_ERROR_PARSE } });
  });

  it('processes session/cancel while a prompt is in flight', async () => {
    const stream = cancellableStream();
    const { sdk } = fakeSdk(stream);
    const { input, writes, transport } = harness(sdk);
    const done = transport.start();
    input.push(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: process.cwd() } })}\n`);
    await vi.waitFor(() => expect(writes.length).toBe(1));
    const created = written(writes)[0] as { result: { sessionId: string } };
    input.push(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: created.result.sessionId, prompt: [{ type: 'text', text: 'go' }] } })}\n`);
    await vi.waitFor(() => expect(stream.cancel).not.toHaveBeenCalled());
    input.push(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: created.result.sessionId } })}\n`);
    await vi.waitFor(() => expect(writes.length).toBe(2));
    input.push(null);
    await done;
    expect(written(writes)[1]).toMatchObject({ id: 2, result: { stopReason: 'cancelled' } });
  });

  it('correlates outgoing permission requests with client responses', async () => {
    const { sdk } = fakeSdk(replayStream([], runResult('end_turn')));
    const { input, writes, transport } = harness(sdk);
    const done = transport.start();
    const pending = transport.request('session/request_permission', { sessionId: 's' });
    await vi.waitFor(() => expect(writes.length).toBe(1));
    const outgoing = written(writes)[0] as { id: string; method: string };
    expect(outgoing.method).toBe('session/request_permission');
    input.push(`${JSON.stringify({ jsonrpc: '2.0', id: outgoing.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })}\n`);
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    input.push(null);
    await done;
  });

  it('rejects dangling client requests when stdin reaches EOF', async () => {
    const { sdk } = fakeSdk(replayStream([], runResult('end_turn')));
    const { input, transport } = harness(sdk);
    const done = transport.start();
    const pending = transport.request('session/request_permission', {});
    const assertion = expect(pending).rejects.toThrowError(/stdin EOF/);
    input.push(null);
    await done;
    await assertion;
  });
});
