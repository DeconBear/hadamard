import { randomUUID } from 'node:crypto';

import { resolveRuntimeConfig } from '../config/resolveRuntimeConfig.js';
import {
  createHadamardNativeCliClient,
  nativeCliModelOverride,
  probeHadamardNativeCliAuth,
  type ExternalCliAuthProbeOptions,
  type ExternalCliAuthStatus,
  type NativeCliClientPort,
} from '../nativeCli/keywayNativeCliAdapter.js';
import { createOpenaiModelApi } from '../provider/openai-model-api.js';
import { createHadamardModelApi } from '../runtime/hadamardModelApi.js';
import type {
  HadamardBridgeRunResult,
  ModelApi,
  ModelRequest,
} from '../types.js';
import type { Message, MessageStreamEvent } from '../provider/types.js';
import type { UsageCounters } from '../usage/contracts.js';
import type {
  KeywayJson,
  KeywayManagedTargetPort,
  KeywayNativeTargetPort,
  KeywayProviderExecutorPort,
  KeywayProviderHandlePort,
  KeywayProviderRequestPort,
  KeywayProviderResultPort,
  KeywayStreamEventPort,
} from './keywayPorts.js';

export type ManagedModelApiFactory = (
  target: KeywayManagedTargetPort,
  model: string,
  secret: string,
) => Promise<ModelApi>;

export type {
  NativeCliClientPort,
  NativeCliRunStreamPort,
} from '../nativeCli/keywayNativeCliAdapter.js';

export type NativeCliClientFactory = (
  target: KeywayNativeTargetPort,
  model: string,
) => Promise<NativeCliClientPort>;

export interface HadamardKeywayProviderExecutorOptions {
  homeDir?: string;
  workDir?: string;
  managedModelApiFactory?: ManagedModelApiFactory;
  nativeCliClientFactory?: NativeCliClientFactory;
}

/** Status-only native auth probe; never reads or returns OAuth/session secrets. */
export function probeKeywayNativeTargetAuth(
  target: KeywayNativeTargetPort,
  options: ExternalCliAuthProbeOptions = {},
): Promise<ExternalCliAuthStatus> {
  return probeHadamardNativeCliAuth(target, options);
}

/** Executes Keyway targets through Hadamard's existing provider and native CLI runtimes. */
export class HadamardKeywayProviderExecutor implements KeywayProviderExecutorPort {
  private readonly managedFactory: ManagedModelApiFactory;
  private readonly nativeFactory: NativeCliClientFactory;

  constructor(options: HadamardKeywayProviderExecutorOptions = {}) {
    this.managedFactory = options.managedModelApiFactory ?? defaultManagedModelApiFactory;
    this.nativeFactory = options.nativeCliClientFactory ?? ((target, model) =>
      createHadamardNativeCliClient(target, model, options));
  }

  execute(request: KeywayProviderRequestPort): KeywayProviderHandlePort {
    return new ProviderHandle(request.signal, (emit, signal) => request.target.kind === 'managed-api'
      ? this.executeManaged(request, request.target, emit, signal)
      : this.executeNative(request, request.target, emit, signal));
  }

  private async executeManaged(
    request: KeywayProviderRequestPort,
    target: KeywayManagedTargetPort,
    emit: (event: KeywayStreamEventPort) => void,
    signal: AbortSignal,
  ): Promise<KeywayProviderResultPort> {
    const secret = request.credential?.secret;
    if (!secret) throw Object.assign(new Error(`Managed target ${target.id} requires a credential.`), { retryable: true });
    const modelApi = await this.managedFactory(target, request.upstreamModel, secret);
    const modelRequest = managedModelRequest(request.payload, request.upstreamModel, signal);
    if (request.operation === 'generate') {
      const message = await modelApi.createMessage(modelRequest);
      return messageResult(message);
    }
    const stream = modelApi.streamMessage(modelRequest);
    const settled = stream.finalMessage().then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    );
    for await (const event of stream) emit({ type: 'data', value: toJson(event) });
    const final = await settled;
    if (!final.ok) throw final.error;
    return messageResult(final.value);
  }

  private async executeNative(
    request: KeywayProviderRequestPort,
    target: KeywayNativeTargetPort,
    emit: (event: KeywayStreamEventPort) => void,
    signal: AbortSignal,
  ): Promise<KeywayProviderResultPort> {
    const payload = record(request.payload);
    const prompt = stringValue(payload?.prompt, 'native CLI payload.prompt');
    const client = await this.nativeFactory(target, request.upstreamModel);
    try {
      const resume = optionalString(payload?.resume) ?? optionalString(payload?.sessionId);
      const model = nativeCliModelOverride(request.upstreamModel);
      const stream = client.stream(prompt, {
        signal,
        ...(model ? { model } : {}),
        ...(optionalString(payload?.workDir) ? { workDir: optionalString(payload?.workDir) } : {}),
        ...(resume ? { sessionId: resume, resume } : {}),
      });
      const settled = stream.result.then(
        value => ({ ok: true as const, value }),
        error => ({ ok: false as const, error }),
      );
      for await (const event of stream) emit({ type: 'data', value: toJson(event) });
      const final = await settled;
      if (!final.ok) throw final.error;
      if (final.value.isError) {
        throw Object.assign(new Error(final.value.text || 'Native CLI execution failed.'), { retryable: false });
      }
      return {
        output: toJson({
          text: final.value.text,
          sessionId: final.value.sessionId,
          stopReason: final.value.stopReason,
          durationMs: final.value.durationMs,
        }),
        usage: bridgeUsage(final.value),
        statusCode: 200,
        providerRequestId: final.value.sessionId || undefined,
      };
    } finally {
      await client.close();
    }
  }
}

async function defaultManagedModelApiFactory(
  target: KeywayManagedTargetPort,
  model: string,
  secret: string,
): Promise<ModelApi> {
  const config = await resolveRuntimeConfig({
    provider: target.protocol,
    model,
    apiKey: secret,
    baseURL: target.baseUrl,
    maxRetries: 0,
  });
  return target.protocol === 'openai'
    ? createOpenaiModelApi(config)
    : createHadamardModelApi(config);
}

function managedModelRequest(payload: KeywayJson, model: string, signal: AbortSignal): ModelRequest {
  const outer = record(payload);
  const value = record(outer?.modelRequest) ?? outer;
  if (!value || !Array.isArray(value.messages) || typeof value.max_tokens !== 'number') {
    throw Object.assign(new TypeError('Managed payload must be a ModelRequest or { modelRequest }.'), { retryable: false });
  }
  return { ...(value as unknown as ModelRequest), model, signal };
}

function messageResult(message: Message): KeywayProviderResultPort {
  return {
    output: toJson(message),
    usage: providerUsage(message.usage),
    providerRequestId: message.id,
  };
}

export function providerUsage(value: unknown): UsageCounters {
  const usage = record(value);
  const inputTokens = nonNegative(usage?.input_tokens);
  const outputTokens = nonNegative(usage?.output_tokens);
  return {
    requests: 1,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens: nonNegative(usage?.cache_read_input_tokens),
    cacheWriteTokens: nonNegative(usage?.cache_creation_input_tokens),
    reasoningTokens: nestedNumber(usage, ['output_tokens_details', 'reasoning_tokens']),
    audioInputTokens: nestedNumber(usage, ['input_tokens_details', 'audio_tokens']),
    audioOutputTokens: nestedNumber(usage, ['output_tokens_details', 'audio_tokens']),
    accuracy: usage ? 'actual' : 'unknown',
  };
}

export function bridgeUsage(result: HadamardBridgeRunResult): UsageCounters {
  const resultEvent = record(result.resultEvent);
  const rawUsage = record(resultEvent?.usage);
  const inputTokens = nonNegative(rawUsage?.input_tokens ?? resultEvent?.input_tokens);
  const outputTokens = nonNegative(rawUsage?.output_tokens ?? resultEvent?.output_tokens);
  const hasTokens = inputTokens > 0 || outputTokens > 0;
  return {
    requests: 1,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens: nonNegative(rawUsage?.cache_read_input_tokens),
    cacheWriteTokens: nonNegative(rawUsage?.cache_creation_input_tokens),
    reasoningTokens: nestedNumber(rawUsage, ['output_tokens_details', 'reasoning_tokens']),
    audioInputTokens: 0,
    audioOutputTokens: 0,
    ...(typeof result.totalCostUsd === 'number' && Number.isFinite(result.totalCostUsd)
      ? { costUsd: Math.max(0, result.totalCostUsd) }
      : {}),
    accuracy: hasTokens ? 'actual' : result.totalCostUsd !== undefined ? 'estimated' : 'unknown',
  };
}

export function keywayOutputToMessage(output: KeywayJson, model: string): Message {
  const value = record(output);
  if (value?.type === 'message' && value.role === 'assistant' && Array.isArray(value.content)) {
    return value as unknown as Message;
  }
  const text = optionalString(value?.text) ?? (typeof output === 'string' ? output : JSON.stringify(output));
  return {
    id: `keyway-${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  };
}

export function keywayDataToMessageStreamEvent(value: KeywayJson): MessageStreamEvent | undefined {
  const event = record(value);
  const unwrapped = event?.type === 'stream_event' ? record(event.event) : event;
  return typeof unwrapped?.type === 'string' ? unwrapped as unknown as MessageStreamEvent : undefined;
}

function toJson(value: unknown): KeywayJson {
  return JSON.parse(JSON.stringify(value)) as KeywayJson;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new TypeError(`${name} is required.`), { retryable: false });
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function nestedNumber(value: Record<string, unknown> | undefined, path: readonly string[]): number {
  let current: unknown = value;
  for (const key of path) current = record(current)?.[key];
  return nonNegative(current);
}

class ProviderHandle implements KeywayProviderHandlePort {
  readonly result: Promise<KeywayProviderResultPort>;
  private readonly queue = new AsyncQueue<KeywayStreamEventPort>();
  private readonly controller = new AbortController();

  constructor(
    signal: AbortSignal | undefined,
    operation: (
      emit: (event: KeywayStreamEventPort) => void,
      signal: AbortSignal,
    ) => Promise<KeywayProviderResultPort>,
  ) {
    if (signal?.aborted) this.controller.abort(signal.reason);
    else signal?.addEventListener('abort', () => this.cancel(signal.reason), { once: true });
    this.result = Promise.resolve().then(() => operation(event => this.queue.push(event), this.controller.signal))
      .then(result => {
        this.queue.finish();
        return result;
      }, error => {
        this.queue.fail(error);
        throw error;
      });
    void this.result.catch(() => undefined);
  }

  cancel(reason?: unknown): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  [Symbol.asyncIterator](): AsyncIterator<KeywayStreamEventPort> {
    return this.queue[Symbol.asyncIterator]();
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (error: unknown) => void }> = [];
  private ended = false;
  private error?: unknown;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  finish(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    this.error = error;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.error !== undefined) return Promise.reject(this.error);
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}
