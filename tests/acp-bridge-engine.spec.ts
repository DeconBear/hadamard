import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/parity/hadamardBridgeSdk.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/parity/hadamardBridgeSdk.js')>();
  return {
    ...original,
    createHadamardBridgeSdk: vi.fn(async () => {
      throw new Error('No "crush" executable was found on PATH.');
    }),
  };
});

import {
  AcpServer,
  BridgeAcpEngine,
  mapBridgeJsonEventToAcpUpdates,
  mapBridgeRunResultToStopReason,
} from '../src/acp/index.js';
import type { HadamardBridgeSdkClient, HadamardBridgeSession } from '../src/parity/hadamardBridgeSdk.js';
import type { HadamardBridgeJsonEvent, HadamardBridgeRunResult } from '../src/types.js';
const CHANNEL = { notify: vi.fn(), request: vi.fn(async () => ({})) };

function bridgeResult(overrides: Partial<HadamardBridgeRunResult> = {}): HadamardBridgeRunResult {
  return {
    text: 'done',
    sessionId: 'bridge-session-1',
    isError: false,
    subtype: 'success',
    exitCode: 0,
    stderr: '',
    resultEvent: { type: 'result' },
    assistantMessages: [],
    events: [],
    ...overrides,
  };
}

function bridgeStream(events: HadamardBridgeJsonEvent[], result: HadamardBridgeRunResult) {
  return {
    result: Promise.resolve(result),
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

/** A bridge stream that blocks until the AbortSignal fires, then rejects abort-like. */
function abortableBridgeStream() {
  let signal: AbortSignal | undefined;
  const factory = (_prompt: string, options: { signal?: AbortSignal }) => {
    signal = options.signal;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<HadamardBridgeRunResult>((_, reject) => { rejectResult = reject; });
    void result.catch(() => undefined);
    let wake!: () => void;
    const gate = new Promise<void>(resolve => { wake = resolve; });
    signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      rejectResult(error);
      wake();
    }, { once: true });
    return {
      result,
      async *[Symbol.asyncIterator]() {
        await gate;
        if (signal?.aborted) {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }
      },
    };
  };
  return { factory };
}

function fakeBridgeEngine(streamFactory: (prompt: string, options: { signal?: AbortSignal }) => unknown) {
  const session = {
    id: 'bridge-session-1',
    stream: vi.fn(streamFactory),
  } as unknown as HadamardBridgeSession;
  const client = {
    createSession: vi.fn(async () => session),
    close: vi.fn(async () => undefined),
  } as unknown as HadamardBridgeSdkClient;
  return { engine: new BridgeAcpEngine(client, 'claude', {}), client, session };
}

function request(id: number, method: string, params?: unknown) {
  return { kind: 'request' as const, id, method, params };
}

describe('mapBridgeJsonEventToAcpUpdates', () => {
  it('maps assistant text, thinking, and tool_use blocks', () => {
    const updates = mapBridgeJsonEventToAcpUpdates({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'answer' },
          { type: 'thinking', thinking: 'hmm' },
          { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    expect(updates).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tu-1',
        title: 'Bash',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'ls' },
      },
    ]);
  });

  it('maps user tool_result blocks to tool_call_update', () => {
    const updates = mapBridgeJsonEventToAcpUpdates({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', is_error: true, content: [{ type: 'text', text: 'nope' }] },
        ],
      },
    });
    expect(updates).toEqual([{
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tu-1',
      status: 'failed',
      rawOutput: 'nope',
    }]);
  });

  it('drops system and result events', () => {
    expect(mapBridgeJsonEventToAcpUpdates({ type: 'system', subtype: 'init' })).toEqual([]);
    expect(mapBridgeJsonEventToAcpUpdates({ type: 'result', subtype: 'success' })).toEqual([]);
    expect(mapBridgeJsonEventToAcpUpdates({ type: 'assistant', message: { content: 'not-blocks' } })).toEqual([]);
  });
});

describe('mapBridgeRunResultToStopReason', () => {
  it('maps bridge outcomes onto the ACP vocabulary', () => {
    expect(mapBridgeRunResultToStopReason(bridgeResult())).toBe('end_turn');
    expect(mapBridgeRunResultToStopReason(bridgeResult({ stopReason: 'max_tokens' }))).toBe('max_tokens');
    expect(mapBridgeRunResultToStopReason(bridgeResult({ stopReason: 'refusal' }))).toBe('refusal');
    expect(mapBridgeRunResultToStopReason(bridgeResult({ stopReason: undefined, subtype: 'success' }))).toBe('end_turn');
  });
});

describe('BridgeAcpEngine', () => {
  it('marks its engine id with the concrete runtime', async () => {
    const { engine } = fakeBridgeEngine(() => bridgeStream([], bridgeResult()));
    expect(engine.engineId).toBe('bridge:claude');
    const server = new AcpServer({ engine });
    const response = await server.handleRequest(
      request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} }),
      CHANNEL,
    );
    expect(response).toMatchObject({ result: { _meta: { hadamardEngine: 'bridge:claude' } } });
  });

  it('creates sessions with the ACP workspace cwd and streams mapped updates', async () => {
    const events: HadamardBridgeJsonEvent[] = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }] },
      },
    ];
    const { engine, client } = fakeBridgeEngine(() => bridgeStream(events, bridgeResult()));
    const server = new AcpServer({ engine });
    const cwd = process.cwd();
    const created = await server.handleRequest(request(1, 'session/new', { cwd }), CHANNEL);
    const { sessionId } = (created as { result: { sessionId: string } }).result;
    expect(sessionId).toBe('bridge-session-1');
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ workDir: cwd }));

    const channel = { notify: vi.fn(), request: vi.fn(async () => ({})) };
    const response = await server.handleRequest(
      request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'do it' }] }),
      channel,
    );
    expect(response).toMatchObject({ result: { stopReason: 'end_turn' } });
    const updates = channel.notify.mock.calls.map(call => (call[1] as { update: { sessionUpdate: string } }).update.sessionUpdate);
    expect(updates).toEqual(['agent_message_chunk', 'tool_call_update']);
  });

  it('joins multi-block prompts into a single text for the CLI', async () => {
    const { engine, session } = fakeBridgeEngine(() => bridgeStream([], bridgeResult()));
    const server = new AcpServer({ engine });
    const created = await server.handleRequest(request(1, 'session/new', { cwd: process.cwd() }), CHANNEL);
    const { sessionId } = (created as { result: { sessionId: string } }).result;
    await server.handleRequest(
      request(2, 'session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
      }),
      CHANNEL,
    );
    expect(session.stream).toHaveBeenCalledWith('first\n\nsecond', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('answers cancelled when the client cancels an in-flight bridge run', async () => {
    const { factory } = abortableBridgeStream();
    const { engine } = fakeBridgeEngine(factory);
    const server = new AcpServer({ engine });
    const created = await server.handleRequest(request(1, 'session/new', { cwd: process.cwd() }), CHANNEL);
    const { sessionId } = (created as { result: { sessionId: string } }).result;

    const promptPromise = server.handleRequest(
      request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'long' }] }),
      CHANNEL,
    );
    await new Promise(resolve => setImmediate(resolve));
    await server.handleNotification({ kind: 'notification', method: 'session/cancel', params: { sessionId } });
    await expect(promptPromise).resolves.toMatchObject({ result: { stopReason: 'cancelled' } });
  });

  it('maps isError results to a JSON-RPC error, never a fake success', async () => {
    const { engine } = fakeBridgeEngine(() => bridgeStream(
      [],
      bridgeResult({ isError: true, subtype: 'error_during_execution', exitCode: 1 }),
    ));
    const server = new AcpServer({ engine });
    const created = await server.handleRequest(request(1, 'session/new', { cwd: process.cwd() }), CHANNEL);
    const { sessionId } = (created as { result: { sessionId: string } }).result;
    const response = await server.handleRequest(
      request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'boom' }] }),
      CHANNEL,
    );
    expect(response).toMatchObject({
      error: { code: -32603, message: expect.stringContaining('error_during_execution') },
    });
  });

  it('fails fast with an actionable diagnostic when the runtime is unavailable', async () => {
    await expect(BridgeAcpEngine.create({ runtime: 'crush', workDir: process.cwd() }))
      .rejects.toThrowError(/Bridge runtime "crush" is not available.*Install and log in/s);
  });
});
