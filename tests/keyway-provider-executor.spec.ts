import { describe, expect, it, vi } from 'vitest';

import {
  HadamardKeywayProviderExecutor,
  bridgeUsage,
  probeKeywayNativeTargetAuth,
} from '../src/keyway/keywayProviderExecutor.js';
import { NATIVE_CLI_DEFAULT_MODEL } from '../src/nativeCli/keywayNativeCliAdapter.js';
import type { KeywayProviderRequestPort } from '../src/keyway/keywayPorts.js';
import type { Message } from '../src/provider/types.js';
import type { HadamardBridgeRunResult, ModelApi, ModelRequest } from '../src/types.js';

function managedRequest(operation: 'generate' | 'stream' = 'generate'): KeywayProviderRequestPort {
  return {
    requestId: 'request-1',
    correlationId: 'correlation-1',
    operation,
    target: {
      kind: 'managed-api',
      id: 'target-ark',
      providerId: 'ark',
      protocol: 'openai',
      baseUrl: 'https://ark.example.test/v1',
      enabled: true,
    },
    upstreamModel: 'glm-5.2',
    credential: { id: 'credential-ark', secret: 'test-secret' },
    payload: {
      modelRequest: {
        model: 'alias',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 1024,
      },
    },
  };
}

function message(text = 'ok'): Message {
  return {
    id: 'message-1',
    type: 'message',
    role: 'assistant',
    model: 'glm-5.2',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 10,
    },
  };
}

describe('HadamardKeywayProviderExecutor', () => {
  it('executes managed generate requests without exposing credentials in output', async () => {
    const createMessage = vi.fn(async (_request: ModelRequest) => message());
    const modelApi: ModelApi = {
      createMessage,
      streamMessage() { throw new Error('not used'); },
    };
    const factory = vi.fn(async () => modelApi);
    const executor = new HadamardKeywayProviderExecutor({ managedModelApiFactory: factory });

    const result = await executor.execute(managedRequest()).result;
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'ark' }), 'glm-5.2', 'test-secret');
    expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({ model: 'glm-5.2' }));
    expect(result).toMatchObject({
      output: { type: 'message', content: [{ type: 'text', text: 'ok' }] },
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 10 },
    });
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });

  it('forwards managed stream events and returns the final message usage', async () => {
    const modelApi: ModelApi = {
      async createMessage() { return message(); },
      streamMessage() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
          },
          async finalMessage() { return message(); },
        };
      },
    };
    const executor = new HadamardKeywayProviderExecutor({ managedModelApiFactory: async () => modelApi });
    const handle = executor.execute(managedRequest('stream'));
    const events = [];
    for await (const event of handle) events.push(event);
    expect(events).toMatchObject([{ type: 'data', value: { type: 'content_block_delta' } }]);
    await expect(handle.result).resolves.toMatchObject({ usage: { totalTokens: 120 } });
  });

  it('uses a native CLI client with session resume and reports unknown token accuracy when absent', async () => {
    const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    let closed = false;
    const nativeResult = {
      text: 'native reply',
      sessionId: 'native-session-1',
      isError: false,
      exitCode: 0,
      stderr: '',
      resultEvent: { type: 'result', subtype: 'success' },
      assistantMessages: [],
      events: [],
    } as HadamardBridgeRunResult;
    const executor = new HadamardKeywayProviderExecutor({
      nativeCliClientFactory: async () => ({
        stream(prompt, options = {}) {
          calls.push({ prompt, options: options as Record<string, unknown> });
          return {
            result: Promise.resolve(nativeResult),
            async *[Symbol.asyncIterator]() {
              yield { type: 'stream_event', event: { type: 'content_block_delta' } };
            },
          };
        },
        async close() { closed = true; },
      }),
    });
    const handle = executor.execute({
      requestId: 'request-native',
      correlationId: 'correlation-native',
      operation: 'stream',
      target: { kind: 'native-cli', id: 'native-claude', runtime: 'claude', enabled: true },
      upstreamModel: 'claude-native',
      payload: { prompt: 'hello', resume: 'existing-session' },
    });
    for await (const _event of handle) { /* drain */ }
    const result = await handle.result;
    expect(calls).toMatchObject([{ prompt: 'hello', options: { sessionId: 'existing-session', resume: 'existing-session' } }]);
    expect(result).toMatchObject({
      output: { text: 'native reply', sessionId: 'native-session-1' },
      usage: { requests: 1, totalTokens: 0, accuracy: 'unknown' },
    });
    expect(closed).toBe(true);
  });

  it('omits the model override when a native route delegates to the CLI default', async () => {
    const stream = vi.fn(() => ({
      result: Promise.resolve({
        text: 'native reply', sessionId: 'native-session-1', isError: false,
        exitCode: 0, stderr: '', resultEvent: { type: 'result', subtype: 'success' },
        assistantMessages: [], events: [],
      } as HadamardBridgeRunResult),
      async *[Symbol.asyncIterator]() {},
    }));
    const executor = new HadamardKeywayProviderExecutor({
      nativeCliClientFactory: async () => ({ stream, async close() {} }),
    });

    await executor.execute({
      requestId: 'request-native-default',
      correlationId: 'correlation-native-default',
      operation: 'generate',
      target: { kind: 'native-cli', id: 'native-codex', runtime: 'codex', enabled: true },
      upstreamModel: NATIVE_CLI_DEFAULT_MODEL,
      payload: { prompt: 'hello' },
    }).result;

    expect(stream).toHaveBeenCalledWith('hello', expect.not.objectContaining({ model: expect.anything() }));
  });

  it('rejects unsupported native runtimes before launching a CLI process', async () => {
    const executor = new HadamardKeywayProviderExecutor();
    const handle = executor.execute({
      requestId: 'request-unsupported',
      correlationId: 'correlation-unsupported',
      operation: 'generate',
      target: { kind: 'native-cli', id: 'native-unsupported', runtime: 'unsupported', enabled: true },
      upstreamModel: 'unknown',
      payload: { prompt: 'hello' },
    });
    await expect(handle.result).rejects.toThrow('Unsupported native CLI runtime: unsupported');
  });
});

describe('bridgeUsage', () => {
  it('maps CLI usage and cache counters when the runtime reports them', () => {
    const value = bridgeUsage({
      text: 'ok',
      sessionId: 'session',
      isError: false,
      totalCostUsd: 0.25,
      exitCode: 0,
      stderr: '',
      resultEvent: {
        type: 'result',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 5,
        },
      },
      assistantMessages: [],
      events: [],
    });
    expect(value).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 5,
      costUsd: 0.25,
      accuracy: 'actual',
    });
  });
});

describe('probeKeywayNativeTargetAuth', () => {
  it('reuses status-only CLI auth probing without returning OAuth/session secrets', async () => {
    const status = await probeKeywayNativeTargetAuth(
      { kind: 'native-cli', id: 'target-claude', runtime: 'claude', enabled: true },
      {
        executable: '/fixture/claude',
        runCommand: async () => ({
          exitCode: 0,
          stdout: '{"loggedIn":true,"authMethod":"oauth_token","token":"secret-canary"}\n',
          stderr: '',
        }),
      },
    );
    expect(status).toMatchObject({ runtime: 'claude', state: 'authenticated', source: 'native-cli' });
    expect(JSON.stringify(status)).not.toContain('secret-canary');
  });
});
