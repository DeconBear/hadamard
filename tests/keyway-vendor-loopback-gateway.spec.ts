import { describe, expect, it } from 'vitest';

import type {
  GatewayRoute,
  KeywayCore,
  KeywayExecutionHandle,
  KeywayExecutionRequest,
  KeywayExecutionResult,
  KeywayStreamEvent,
} from '../src/keyway/vendor/core/index.js';

import { LoopbackGateway } from '../src/keyway/vendor/gateway/index.js';

const route: GatewayRoute = {
  id: 'route.chat',
  alias: 'chat',
  mode: 'direct',
  enabled: true,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
  candidates: [{ id: 'candidate.1', targetId: 'target.1', upstreamModel: 'glm-5.2', priority: 0, weight: 1, enabled: true }],
};

function core(seen: KeywayExecutionRequest[]): KeywayCore {
  return {
    execute(request) {
      seen.push(request);
      const result: KeywayExecutionResult = {
        requestId: request.requestId,
        correlationId: request.correlationId,
        routeId: route.id,
        attempts: [],
        output: {
          id: 'msg.1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          stop_reason: 'end_turn',
        },
        usage: {
          requests: 1,
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          audioInputTokens: 0,
          audioOutputTokens: 0,
          accuracy: 'actual',
        },
        statusCode: 200,
        providerRequestId: 'provider.1',
      };
      return handle(result);
    },
  };
}

function handle(value: KeywayExecutionResult): KeywayExecutionHandle {
  return {
    result: Promise.resolve(value),
    cancel() {},
    async *[Symbol.asyncIterator](): AsyncIterator<KeywayStreamEvent> {},
  };
}

describe('LoopbackGateway', () => {
  it('requires client auth and routes OpenAI requests with correlation ids', async () => {
    const seen: KeywayExecutionRequest[] = [];
    const gateway = await LoopbackGateway.start({
      core: core(seen),
      store: { async listRoutes() { return [route]; } },
      clientKeys: ['db_sk_test'],
    });
    try {
      expect((await fetch(gateway.status().url + '/v1/models')).status).toBe(401);
      const response = await fetch(gateway.status().url + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: 'Bearer db_sk_test',
          'content-type': 'application/json',
          'x-request-id': 'request.external',
          'x-correlation-id': 'correlation.external',
        },
        body: JSON.stringify({ model: 'chat', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-correlation-id')).toBe('correlation.external');
      await expect(response.json()).resolves.toMatchObject({
        object: 'chat.completion',
        model: 'chat',
        choices: [{ message: { content: 'hello' } }],
        usage: { total_tokens: 5 },
      });
      expect(seen[0]).toMatchObject({
        requestId: 'request.external',
        correlationId: 'correlation.external',
        routeAlias: 'chat',
        metadata: { gatewayProtocol: 'openai' },
      });
    } finally {
      await gateway.close();
    }
  });

  it('serves Anthropic responses and one-shot compatible streams', async () => {
    const gateway = await LoopbackGateway.start({
      core: core([]),
      store: { async listRoutes() { return [route]; } },
      clientKeys: ['db_sk_test'],
    });
    try {
      const anthropic = await fetch(gateway.status().url + '/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'db_sk_test', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'chat', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
      });
      await expect(anthropic.json()).resolves.toMatchObject({
        type: 'message',
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 3, output_tokens: 2 },
      });
      const stream = await fetch(gateway.status().url + '/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer db_sk_test', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'chat', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      });
      expect(await stream.text()).toContain('data: [DONE]');
    } finally {
      await gateway.close();
    }
  });

  it('rejects non-loopback binds and exposes unauthenticated health only', async () => {
    await expect(LoopbackGateway.start({
      core: core([]),
      store: { async listRoutes() { return []; } },
      clientKeys: ['db_sk_test'],
      host: '0.0.0.0',
    })).rejects.toThrow('loopback');
    const gateway = await LoopbackGateway.start({
      core: core([]),
      store: { async listRoutes() { return []; } },
      clientKeys: ['db_sk_test'],
    });
    try {
      await expect(fetch(gateway.status().url + '/health').then(response => response.json()))
        .resolves.toMatchObject({ ok: true });
    } finally {
      await gateway.close();
    }
  });
});
