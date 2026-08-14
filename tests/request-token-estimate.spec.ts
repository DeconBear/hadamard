import { describe, expect, it } from 'vitest';

import {
  calibrateRequestTokenMultiplier,
  estimateRequestTokenBreakdown,
} from '../src/runtime/requestTokenEstimate.js';
import { getReportedInputTokens } from '../src/runtime/modelRequestPolicy.js';

describe('request token estimates', () => {
  it('breaks a request into system, tools, and messages', () => {
    const estimate = estimateRequestTokenBreakdown({
      systemPrompt: 's'.repeat(400),
      tools: [{ name: 'Read', description: 'r'.repeat(400) }],
      messageTokens: 25,
    });
    expect(estimate.systemTokens).toBe(100);
    expect(estimate.toolTokens).toBeGreaterThan(100);
    expect(estimate.totalTokens).toBe(
      estimate.systemTokens + estimate.toolTokens + estimate.messageTokens,
    );
  });

  it('calibrates against the whole request instead of messages alone', () => {
    expect(calibrateRequestTokenMultiplier({
      currentMultiplier: 1,
      reportedInputTokens: 12_000,
      uncalibratedRequestTokens: 12_000,
    })).toBe(1);
    expect(calibrateRequestTokenMultiplier({
      currentMultiplier: 1,
      reportedInputTokens: 13_200,
      uncalibratedRequestTokens: 12_000,
    })).toBeCloseTo(1.035);
  });

  it('does not count DeepSeek cache hits twice', () => {
    expect(getReportedInputTokens({
      input_tokens: 12_000,
      output_tokens: 10,
      cache_read_input_tokens: 10_000,
      prompt_cache_hit_tokens: 10_000,
      prompt_cache_miss_tokens: 2_000,
    })).toBe(12_000);

    expect(getReportedInputTokens({
      input_tokens: 2_000,
      output_tokens: 10,
      cache_read_input_tokens: 10_000,
    })).toBe(12_000);
  });
});
