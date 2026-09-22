import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type {
  JsonValue,
  KeywayAdminStore,
  KeywayCore,
  KeywayExecutionResult,
  UsageCounters,
} from '../core/index.js';

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
export const KEYWAY_GATEWAY_VERSION = 1 as const;

export interface LoopbackGatewayOptions {
  readonly core: KeywayCore;
  readonly store: Pick<KeywayAdminStore, 'listRoutes'>;
  readonly clientKeys?: readonly string[];
  readonly allowUnauthenticatedLoopback?: boolean;
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface LoopbackGatewayStatus {
  readonly running: boolean;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly authentication: 'client-key' | 'none';
}

export class LoopbackGateway {
  private constructor(
    private readonly server: ReturnType<typeof createServer>,
    private readonly snapshot: LoopbackGatewayStatus,
  ) {}

  static async start(options: LoopbackGatewayOptions): Promise<LoopbackGateway> {
    const host = options.host ?? '127.0.0.1';
    if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
      throw new TypeError('Keyway loopback gateway may only bind to 127.0.0.1, ::1, or localhost.');
    }
    const keyHashes = (options.clientKeys ?? []).filter(Boolean).map(hashSecret);
    if (!options.allowUnauthenticatedLoopback && keyHashes.length === 0) {
      throw new TypeError('At least one client key is required unless unauthenticated loopback is explicitly enabled.');
    }
    const server = createServer((request, response) => {
      void dispatch(request, response, options, keyHashes).catch(error => {
        if (response.headersSent) {
          response.end();
          return;
        }
        const status = errorStatus(error);
        sendJson(response, status, {
          error: { message: status >= 500 ? 'Gateway request failed.' : errorMessage(error) },
        });
      });
    });
    const port = await listen(server, host, options.port ?? 0);
    const urlHost = host === '::1' ? '[::1]' : host;
    return new LoopbackGateway(server, {
      running: true,
      host,
      port,
      url: `http://${urlHost}:${port}`,
      authentication: keyHashes.length ? 'client-key' : 'none',
    });
  }

  status(): LoopbackGatewayStatus {
    return this.snapshot;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => error ? reject(error) : resolve());
    });
  }
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  options: LoopbackGatewayOptions,
  keyHashes: readonly Buffer[],
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://loopback.invalid');
  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true, service: 'keyway-loopback' });
    return;
  }
  if (!authorized(request, keyHashes, options.allowUnauthenticatedLoopback === true)) {
    response.setHeader('www-authenticate', 'Bearer realm="keyway-loopback"');
    sendJson(response, 401, { error: { message: 'Invalid or missing client key.' } });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/models') {
    const routes = (await options.store.listRoutes()).filter(route => route.enabled);
    sendJson(response, 200, {
      object: 'list',
      data: routes.map(route => ({ id: route.alias, object: 'model', owned_by: 'keyway' })),
    });
    return;
  }
  if (request.method !== 'POST' || (url.pathname !== '/v1/chat/completions' && url.pathname !== '/v1/messages')) {
    sendJson(response, 404, { error: { message: 'Not found.' } });
    return;
  }
  const protocol = url.pathname === '/v1/messages' ? 'anthropic' : 'openai';
  const body = await readBody(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  const routeAlias = requiredString(body.model, 'model');
  const requestId = headerId(request.headers['x-request-id']) ?? options.idFactory?.() ?? randomUUID();
  const correlationId = headerId(request.headers['x-correlation-id']) ?? requestId;
  response.setHeader('x-request-id', requestId);
  response.setHeader('x-correlation-id', correlationId);
  const streaming = body.stream === true;
  const handle = options.core.execute({
    requestId,
    correlationId,
    routeAlias,
    requestedModel: routeAlias,
    operation: streaming ? 'stream' : 'generate',
    payload: { modelRequest: normalizeModelRequest(body) },
    metadata: { gatewayProtocol: protocol },
  });
  request.once('aborted', () => handle.cancel(new Error('Client disconnected.')));
  if (!streaming) {
    const result = await handle.result;
    sendJson(response, 200, protocol === 'openai'
      ? openAiResponse(result, routeAlias, options.now?.() ?? new Date())
      : anthropicResponse(result, routeAlias));
    return;
  }
  const drain = (async () => { for await (const _event of handle) { /* emit one normalized result below */ } })();
  const result = await handle.result;
  await drain;
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache, no-transform');
  if (protocol === 'openai') writeOpenAiStream(response, result, routeAlias, options.now?.() ?? new Date());
  else writeAnthropicStream(response, result, routeAlias);
  response.end();
}

function normalizeModelRequest(body: Record<string, unknown>): JsonValue {
  if (!Array.isArray(body.messages)) throw new TypeError('messages must be an array.');
  const maxTokens = finiteNumber(body.max_tokens) ?? finiteNumber(body.max_completion_tokens) ?? 1024;
  const request: Record<string, JsonValue> = {
    model: requiredString(body.model, 'model'),
    messages: body.messages as JsonValue[],
    max_tokens: maxTokens,
  };
  for (const field of ['system', 'temperature', 'top_p', 'stop', 'tools', 'tool_choice'] as const) {
    const value = body[field];
    if (jsonValue(value)) request[field] = value;
  }
  return request;
}

function openAiResponse(result: KeywayExecutionResult, model: string, now: Date): JsonValue {
  return {
    id: result.providerRequestId ?? `chatcmpl-${result.requestId}`,
    object: 'chat.completion',
    created: Math.floor(now.getTime() / 1000),
    model,
    choices: [{ index: 0, message: assistantMessage(result.output), finish_reason: 'stop' }],
    usage: openAiUsage(result.usage),
  };
}

function anthropicResponse(result: KeywayExecutionResult, model: string): JsonValue {
  const output = object(result.output);
  const content = Array.isArray(output?.content)
    ? output.content as JsonValue[]
    : [{ type: 'text', text: textOutput(result.output) }];
  return {
    id: typeof output?.id === 'string' ? output.id : `msg_${result.requestId}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: typeof output?.stop_reason === 'string' ? output.stop_reason : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      cache_read_input_tokens: result.usage.cacheReadTokens,
      cache_creation_input_tokens: result.usage.cacheWriteTokens,
    },
  };
}

function writeOpenAiStream(
  response: ServerResponse,
  result: KeywayExecutionResult,
  model: string,
  now: Date,
): void {
  const chunk = {
    id: result.providerRequestId ?? `chatcmpl-${result.requestId}`,
    object: 'chat.completion.chunk',
    created: Math.floor(now.getTime() / 1000),
    model,
    choices: [{ index: 0, delta: assistantMessage(result.output), finish_reason: 'stop' }],
    usage: openAiUsage(result.usage),
  };
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.write('data: [DONE]\n\n');
}

function writeAnthropicStream(response: ServerResponse, result: KeywayExecutionResult, model: string): void {
  const message = anthropicResponse(result, model);
  response.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message })}\n\n`);
  response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: textOutput(result.output) } })}\n\n`);
  response.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
}

function assistantMessage(output: JsonValue): JsonValue {
  const value = object(output);
  const content = Array.isArray(value?.content) ? value.content : undefined;
  const toolCalls = content?.filter(item => object(item)?.type === 'tool_use').map(item => {
    const tool = object(item)!;
    return {
      id: typeof tool.id === 'string' ? tool.id : randomUUID(),
      type: 'function',
      function: {
        name: typeof tool.name === 'string' ? tool.name : 'tool',
        arguments: JSON.stringify(tool.input ?? {}),
      },
    };
  });
  return {
    role: 'assistant',
    content: textOutput(output),
    ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
  };
}

function textOutput(output: JsonValue): string {
  if (typeof output === 'string') return output;
  const value = object(output);
  if (typeof value?.text === 'string') return value.text;
  if (Array.isArray(value?.content)) {
    return value.content.map(item => {
      if (typeof item === 'string') return item;
      const block = object(item);
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
    }).join('');
  }
  return JSON.stringify(output);
}

function openAiUsage(usage: UsageCounters): JsonValue {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
    completion_tokens_details: {
      reasoning_tokens: usage.reasoningTokens,
      audio_tokens: usage.audioOutputTokens,
    },
  };
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new TypeError('Request body is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new TypeError('Request body must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('Request body must be an object.');
  return parsed as Record<string, unknown>;
}

function authorized(request: IncomingMessage, hashes: readonly Buffer[], allowNone: boolean): boolean {
  if (hashes.length === 0) return allowNone;
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
  const apiKey = typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : undefined;
  const supplied = bearer ?? apiKey;
  if (!supplied) return false;
  const candidate = hashSecret(supplied);
  return hashes.some(hash => timingSafeEqual(hash, candidate));
}

function hashSecret(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function headerId(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  return text && /^[A-Za-z0-9._:-]{1,128}$/u.test(text) ? text : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function jsonValue(value: unknown): value is JsonValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(jsonValue);
  return !!value && typeof value === 'object' && Object.values(value).every(jsonValue);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function errorStatus(error: unknown): number {
  const status = object(error)?.statusCode;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) return status;
  return error instanceof TypeError ? 400 : 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendJson(response: ServerResponse, status: number, value: JsonValue): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

async function listen(
  server: ReturnType<typeof createServer>,
  host: string,
  port: number,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to resolve loopback gateway address.');
  return address.port;
}
