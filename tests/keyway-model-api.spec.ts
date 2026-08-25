import { describe, expect, it } from 'vitest';

import { KeywayModelApi } from '../src/keyway/keywayModelApi.js';
import type {
  KeywayCorePort,
  KeywayExecutionHandlePort,
  KeywayExecutionRequestPort,
  KeywayExecutionResultPort,
  KeywayStreamEventPort,
} from '../src/keyway/keywayPorts.js';
import type { ModelRequest } from '../src/types.js';

function usage() {
  return {
    requests: 1,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cacheReadTokens: 7,
    cacheWriteTokens: 2,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    accuracy: 'actual' as const,
  };
}

class FakeCore implements KeywayCorePort {
  readonly requests: KeywayExecutionRequestPort[] = [];
  responses: Array<{
    events?: KeywayStreamEventPort[];
    result: KeywayExecutionResultPort;
  }> = [];

  execute(request: KeywayExecutionRequestPort): KeywayExecutionHandlePort {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('Missing response');
    return {
      result: Promise.resolve(response.result),
      cancel() {},
      async *[Symbol.asyncIterator]() {
        for (const event of response.events ?? []) yield event;
      },
    };
  }
}

function request(): ModelRequest {
  return {
    model: 'chat-default',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 1024,
  };
}

describe('KeywayModelApi', () => {
  it('maps generate results back to a provider Message with cache usage', async () => {
    const core = new FakeCore();
    core.responses.push({
      result: {
        requestId: 'request-1',
        correlationId: 'correlation-1',
        routeId: 'route-1',
        output: { text: 'native reply', sessionId: 'native-session-1' },
        usage: usage(),
      },
    });
    const api = new KeywayModelApi({ core, routeAlias: 'chat-default', configurationId: 'config-route' });
    const message = await api.createMessage(request());
    expect(message).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'native reply' }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 2,
      },
    });
    expect(core.requests[0]).toMatchObject({
      routeAlias: 'chat-default',
      operation: 'generate',
      payload: { prompt: 'hello' },
      metadata: { configurationId: 'config-route' },
    });
  });

  it('unwraps managed and native bridge stream events and resumes the native session', async () => {
    const core = new FakeCore();
    core.responses.push({
      events: [
        { type: 'data', value: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } } },
        { type: 'data', value: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'b' } } } },
      ],
      result: {
        requestId: 'request-1', correlationId: 'correlation-1', routeId: 'route-1',
        output: { text: 'ab', sessionId: 'native-session-1' }, usage: usage(),
      },
    });
    core.responses.push({
      result: {
        requestId: 'request-2', correlationId: 'correlation-2', routeId: 'route-1',
        output: { text: 'second', sessionId: 'native-session-1' }, usage: usage(),
      },
    });
    const api = new KeywayModelApi({ core, routeAlias: 'chat-default' });
    const stream = api.streamMessage(request());
    const events = [];
    for await (const event of stream) events.push(event);
    await stream.finalMessage();
    expect(events).toHaveLength(2);
    await api.createMessage(request());
    expect(core.requests[1]).toMatchObject({ payload: { resume: 'native-session-1' } });
  });
});
