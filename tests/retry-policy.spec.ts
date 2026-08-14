import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAgentSdk } from '../src/index.js';
import type { ModelApi, ModelRequest } from '../src/index.js';
import {
  DEFAULT_RETRY_BACKOFF,
  resolveProviderRetryPolicy,
} from '../src/provider/retryPolicy.js';
import type { Message } from '../src/provider/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

class StubModel implements ModelApi {
  async createMessage(_request: ModelRequest): Promise<Message> {
    throw new Error('not used');
  }
  streamMessage(): never {
    throw new Error('not used');
  }
}

describe('resolveProviderRetryPolicy', () => {
  it('falls back to the Claude-Code-style defaults', () => {
    const policy = resolveProviderRetryPolicy(undefined, 2);
    expect(policy.mode).toBe('normal');
    expect(policy.maxRetries).toBe(2);
    expect(policy.retryableStatuses).toEqual([408, 409, 429]);
    expect(policy.retryServerErrors).toBe(true);
    expect(policy.retryTransportErrors).toBe(true);
    expect(policy.backoff).toEqual({ ...DEFAULT_RETRY_BACKOFF });
  });

  it('resolves always mode with unbounded retries', () => {
    const policy = resolveProviderRetryPolicy({ mode: 'always' });
    expect(policy.mode).toBe('always');
    expect(policy.maxRetries).toBe(Number.POSITIVE_INFINITY);
  });

  it('maps retryable codes to the status/transport predicates', () => {
    const policy = resolveProviderRetryPolicy({
      mode: 'normal',
      maxRetries: 4,
      retryableCodes: ['RATE_LIMIT', 'SERVER'],
      backoff: { initialDelayMs: 100, maxDelayMs: 2_000, jitterRatio: 0.1 },
    });
    expect(policy.maxRetries).toBe(4);
    expect(policy.retryableStatuses).toEqual([429]);
    expect(policy.retryServerErrors).toBe(true);
    expect(policy.retryTransportErrors).toBe(false);
    expect(policy.backoff.initialDelayMs).toBe(100);
    expect(policy.backoff.maxDelayMs).toBe(2_000);
    expect(policy.backoff.jitterRatio).toBe(0.1);
  });

  it('rejects invalid modes, codes, and backoff values', () => {
    expect(() => resolveProviderRetryPolicy({ mode: 'weird' as never })).toThrow(/mode/);
    expect(() => resolveProviderRetryPolicy({ mode: 'normal', retryableCodes: ['NOPE'] })).toThrow(/retryableCodes/);
    expect(() => resolveProviderRetryPolicy({ mode: 'normal', maxRetries: -1 })).toThrow(/maxRetries/);
    expect(() => resolveProviderRetryPolicy({ mode: 'normal', backoff: { jitterRatio: 2 } })).toThrow(/jitterRatio/);
  });
});

describe('retryPolicy configuration', () => {
  it('resolves the configured policy through createAgentSdk', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-retry-home-'));
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-retry-work-'));
    const sessionDirectory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-retry-sessions-'));
    tempDirs.push(homeDir, workDir, sessionDirectory);
    const sdk = await createAgentSdk({
      model: 'test-model',
      modelApi: new StubModel(),
      homeDir,
      workDir,
      sessionDirectory,
      retryPolicy: { mode: 'normal', maxRetries: 3, retryableCodes: ['RATE_LIMIT'] },
    });
    try {
      expect(sdk.config.retryPolicy?.mode).toBe('normal');
      expect(sdk.config.retryPolicy?.maxRetries).toBe(3);
      expect(sdk.config.maxRetries).toBe(3);
      expect(sdk.config.retryPolicy?.retryableStatuses).toEqual([429]);
    } finally {
      await sdk.close();
    }
  });
});
