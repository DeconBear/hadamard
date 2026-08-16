import { createHash } from 'node:crypto';

import type { MessageParam, Usage } from '../provider/types.js';
import {
  HadamardProviderApiError,
  HadamardSdkError,
  RunAbortedError,
  ToolExecutionError,
} from '../errors.js';
import type { AgentRequestSummary, AgentRunResult, ModelRequest } from '../types.js';
import { asError, signalAborted } from './helpers.js';

export function isModelFallbackEligibleError(error: unknown): boolean {
  if (error instanceof HadamardProviderApiError) {
    const status = error.status ?? 0;
    return status === 429 || status === 529 || (status >= 500 && status < 600);
  }
  return false;
}

// The enclosing agent run owns the hard wall-clock deadline. This higher
// per-iteration guard lets a stream survive a meaningful network outage while
// the abortable, capped backoff and run signal keep recovery bounded.
export const MAX_STREAM_INTERRUPTION_RETRIES = 60;
const STREAM_INTERRUPTION_BACKOFF_BASE_MS = 250;
const MAX_STREAM_INTERRUPTION_BACKOFF_MS = 15_000;

export function streamInterruptionBackoffMs(retry: number): number {
  const exponent = Math.min(Math.max(retry - 1, 0), 8);
  return Math.min(
    MAX_STREAM_INTERRUPTION_BACKOFF_MS,
    STREAM_INTERRUPTION_BACKOFF_BASE_MS * (2 ** exponent),
  );
}

const TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);
const TRANSPORT_ERROR_PATTERN =
  /terminated|fetch failed|socket|other side closed|premature|network|connection (?:closed|reset|error)/i;

/**
 * Transport-level failures that occur after the provider accepted the request
 * (mid-stream socket loss, abrupt connection close). HTTP-status errors are
 * excluded — the provider client already retried those before throwing. A
 * status-zero transport_error means those short provider retries were
 * exhausted while the network was still unavailable, so the enclosing run
 * keeps retrying within its own deadline/abort budget.
 */
export function isRetryableStreamInterruption(error: unknown): boolean {
  if (error instanceof HadamardProviderApiError) {
    return error.status === 0 && error.errorType === 'transport_error';
  }
  if (
    error instanceof RunAbortedError ||
    error instanceof HadamardSdkError ||
    error instanceof ToolExecutionError
  ) {
    return false;
  }
  if (!(error instanceof Error) || error.name === 'AbortError') {
    return false;
  }
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const causeCode = typeof cause?.code === 'string' ? cause.code : '';
  if (causeCode.startsWith('UND_ERR') || TRANSPORT_ERROR_CODES.has(causeCode)) {
    return true;
  }
  const causeMessage = typeof cause?.message === 'string' ? cause.message : '';
  return TRANSPORT_ERROR_PATTERN.test(`${error.message} ${causeMessage}`);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new RunAbortedError());
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new RunAbortedError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Mark the last content block of the last message with an ephemeral
 * cache_control breakpoint. One breakpoint caches the entire request prefix
 * (tools + system + conversation) on Anthropic API hosts. String-content
 * messages (e.g. the first user prompt) are converted to an equivalent single
 * text block so the breakpoint still applies — otherwise the whole request
 * goes uncached whenever the last message is a plain string.
 */
export function applyAnthropicPromptCacheBreakpoints(request: ModelRequest): {
  prefixSignature: string;
  breakpoints: { system: boolean; tools: boolean; message: boolean };
} {
  const prefixSignature = createHash('sha256')
    .update(JSON.stringify({
      system: request.system ?? null,
      tools: (request.tools ?? []).map((tool) => {
        const normalized = { ...(tool as Record<string, unknown>) };
        delete normalized.cache_control;
        return normalized;
      }),
    }))
    .digest('hex')
    .slice(0, 16);
  applyCacheControlToLastTool(request.tools);
  applyCacheControlToLastMessage(request.messages);
  return {
    prefixSignature,
    breakpoints: {
      system: typeof request.system === 'string' && request.system.length > 0,
      tools: Boolean(request.tools?.length),
      message: request.messages.length > 0,
    },
  };
}

function applyCacheControlToLastTool(tools: ModelRequest['tools']): void {
  const lastTool = tools?.at(-1);
  if (lastTool && typeof lastTool === 'object') {
    (lastTool as Record<string, unknown>).cache_control = { type: 'ephemeral' };
  }
}

function applyCacheControlToLastMessage(messages: MessageParam[]): void {
  const last = messages.at(-1);
  if (!last) {
    return;
  }
  if (typeof last.content === 'string') {
    if (last.content.length === 0) {
      return;
    }
    last.content = [
      { type: 'text', text: last.content, cache_control: { type: 'ephemeral' } },
    ];
    return;
  }
  if (!Array.isArray(last.content) || last.content.length === 0) {
    return;
  }
  const lastBlock = last.content[last.content.length - 1];
  if (lastBlock && typeof lastBlock === 'object') {
    (lastBlock as Record<string, unknown>).cache_control = { type: 'ephemeral' };
  }
}

export function getRequestByteLength(request: ModelRequest): number {
  return Buffer.byteLength(JSON.stringify({
    ...request,
    signal: undefined,
  }), 'utf8');
}

export function getReportedInputTokens(usage: AgentRunResult['usage']): number | undefined {
  if (!usage) {
    return undefined;
  }
  // DeepSeek's input_tokens already includes prompt-cache hits and misses.
  // normalizeProviderUsage mirrors hits into Anthropic's cache_read field for
  // observability, so summing that mirror would count cached input twice.
  if (
    typeof usage.input_tokens === 'number'
    && Number.isFinite(usage.input_tokens)
    && (
      typeof usage.prompt_cache_hit_tokens === 'number'
      || typeof usage.prompt_cache_miss_tokens === 'number'
    )
  ) {
    return Math.max(usage.input_tokens, 0);
  }
  const parts = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (parts.length === 0) {
    return undefined;
  }
  return parts.reduce((sum, value) => sum + Math.max(value, 0), 0);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function ensureNotAborted(signal?: AbortSignal): void {
  try {
    signalAborted(signal);
  } catch (error) {
    throw new RunAbortedError(asError(error).message, { cause: error });
  }
}

export function aggregateRequestUsage(
  requests: readonly AgentRequestSummary[],
): Usage | undefined {
  const usages = requests
    .map(request => request.usage)
    .filter((usage): usage is Usage => usage != null);
  if (usages.length === 0) return undefined;

  const aggregate: Usage = { ...usages.at(-1) };
  for (const field of ['input_tokens', 'output_tokens'] as const) {
    const values = usages
      .map(usage => usage[field])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (values.length > 0) aggregate[field] = values.reduce((sum, value) => sum + value, 0);
    else delete aggregate[field];
  }
  for (const field of ['cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
    const values = usages
      .map(usage => usage[field])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    aggregate[field] = values.length > 0
      ? values.reduce((sum, value) => sum + value, 0)
      : usages.some(usage => usage[field] === null) ? null : undefined;
  }
  return aggregate;
}

export function isAnthropicAPI(baseURL?: string): boolean {
  if (!baseURL) return true;
  try {
    const host = new URL(baseURL).hostname;
    return host === 'api.anthropic.com' || host.endsWith('.anthropic.com');
  } catch {
    return true;
  }
}

const CONTEXT_LENGTH_MISMATCH_PATTERNS = [
  'context_length_exceeded',
  'context length',
  'maximum context',
  'max context',
  'context window',
  'prompt is too long',
  'exceeds the maximum',
  'too many tokens',
  'token limit exceeded',
  'input length',
  '上下文长度',
  '超过最大',
] as const;

/**
 * Detect provider rejections caused by a context-window selection the model
 * cannot serve. The runtime turns these into a friendly, actionable error
 * telling the user to lower the configured context length.
 */
export function isContextLengthMismatchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const normalized = error.message.toLowerCase();
  return CONTEXT_LENGTH_MISMATCH_PATTERNS.some(pattern => normalized.includes(pattern));
}
