import { ConfigurationError } from '../errors.js';

/**
 * Provider request-retry policy (dsh retry-policy equivalent): resolved once
 * per provider route and applied by the HTTP clients' retry loops.
 *
 * @module src/provider/retryPolicy
 */

export interface HadamardRetryPolicyConfig {
  /** normal = bounded retry of configured transient failures; always = retry until success or abort. */
  mode: 'normal' | 'always';
  /** Maximum retries after the first request (normal mode only). */
  maxRetries?: number;
  /** Stable failure codes eligible for retry: RATE_LIMIT, SERVER, TIMEOUT, CONFLICT, EMPTY_RESPONSE, TRANSPORT. */
  retryableCodes?: string[];
  /** Bounded exponential backoff with symmetric jitter. */
  backoff?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
  };
}

export interface ResolvedProviderRetryPolicy {
  mode: 'normal' | 'always';
  /** Infinity for always mode. */
  maxRetries: number;
  retryableStatuses: number[];
  retryServerErrors: boolean;
  retryTransportErrors: boolean;
  backoff: { initialDelayMs: number; maxDelayMs: number; jitterRatio: number };
}

export const DEFAULT_RETRYABLE_CODES = [
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
] as const;

const KNOWN_RETRYABLE_CODES = new Set<string>([...DEFAULT_RETRYABLE_CODES, 'CONFLICT']);

/** Claude-Code-style backoff defaults. */
export const DEFAULT_RETRY_BACKOFF = { initialDelayMs: 500, maxDelayMs: 30_000, jitterRatio: 0.25 } as const;

export function resolveProviderRetryPolicy(
  input: HadamardRetryPolicyConfig | undefined,
  fallbackMaxRetries = 2,
): ResolvedProviderRetryPolicy {
  if (input === undefined) {
    return {
      mode: 'normal',
      maxRetries: fallbackMaxRetries,
      retryableStatuses: [408, 409, 429],
      retryServerErrors: true,
      retryTransportErrors: true,
      backoff: { ...DEFAULT_RETRY_BACKOFF },
    };
  }
  if (input.mode !== 'normal' && input.mode !== 'always') {
    throw new ConfigurationError('Invalid retryPolicy mode "' + String(input.mode) + '". Expected normal or always.');
  }
  if (input.maxRetries !== undefined && (!Number.isSafeInteger(input.maxRetries) || input.maxRetries < 0)) {
    throw new ConfigurationError('retryPolicy.maxRetries must be a non-negative safe integer.');
  }
  const codes = input.retryableCodes ?? [...DEFAULT_RETRYABLE_CODES];
  for (const code of codes) {
    if (!KNOWN_RETRYABLE_CODES.has(code)) {
      throw new ConfigurationError('Invalid retryPolicy.retryableCodes entry "' + code + '".');
    }
  }
  const codeSet = new Set(codes);
  const retryableStatuses: number[] = [];
  if (codeSet.has('RATE_LIMIT')) retryableStatuses.push(429);
  if (codeSet.has('TIMEOUT')) retryableStatuses.push(408);
  if (codeSet.has('CONFLICT')) retryableStatuses.push(409);
  const backoff = {
    initialDelayMs: positiveInteger(
      input.backoff?.initialDelayMs,
      DEFAULT_RETRY_BACKOFF.initialDelayMs,
      'retryPolicy.backoff.initialDelayMs',
    ),
    maxDelayMs: positiveInteger(
      input.backoff?.maxDelayMs,
      DEFAULT_RETRY_BACKOFF.maxDelayMs,
      'retryPolicy.backoff.maxDelayMs',
    ),
    jitterRatio: input.backoff?.jitterRatio ?? DEFAULT_RETRY_BACKOFF.jitterRatio,
  };
  if (!Number.isFinite(backoff.jitterRatio) || backoff.jitterRatio < 0 || backoff.jitterRatio > 1) {
    throw new ConfigurationError('retryPolicy.backoff.jitterRatio must be between 0 and 1.');
  }
  return {
    mode: input.mode,
    maxRetries: input.mode === 'always' ? Number.POSITIVE_INFINITY : input.maxRetries ?? fallbackMaxRetries,
    retryableStatuses,
    retryServerErrors: codeSet.has('SERVER'),
    retryTransportErrors: codeSet.has('TRANSPORT') || codeSet.has('EMPTY_RESPONSE'),
    backoff,
  };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ConfigurationError(name + ' must be a positive safe integer.');
  }
  return resolved;
}
