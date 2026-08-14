import { describe, expect, it } from 'vitest';

import {
  STANDARD_CONTEXT_WINDOWS,
  clampContextWindowTokens,
  formatContextWindowTokens,
  modelContextWindowOptions,
  parseContextWindowTokens,
  resolveModelContextEntry,
} from '../src/config/modelContextWindow.js';

describe('model context-window selection', () => {
  it('parses compact token values and formats picker labels', () => {
    expect(parseContextWindowTokens('128k')).toBe(128_000);
    expect(parseContextWindowTokens('1m')).toBe(1_000_000);
    expect(parseContextWindowTokens('invalid')).toBeUndefined();
    expect(formatContextWindowTokens(128_000)).toBe('128k');
  });

  it('offers only values within the model declared maximum', () => {
    const options = modelContextWindowOptions({
      name: 'model-x',
      contextWindowTokens: 128_000,
      maxContextWindowTokens: 256_000,
    });
    expect(options).toContain(128_000);
    expect(options).toContain(256_000);
    expect(options.every(value => value <= 256_000)).toBe(true);
    expect(clampContextWindowTokens(1_000_000, {
      name: 'model-x',
      maxContextWindowTokens: 256_000,
    })).toBe(256_000);
  });

  it('offers the GUI picker choices when model metadata is not declared', () => {
    expect(modelContextWindowOptions(undefined)).toEqual(STANDARD_CONTEXT_WINDOWS);
    expect(STANDARD_CONTEXT_WINDOWS).toEqual([
      16_000,
      32_000,
      64_000,
      128_000,
      200_000,
      256_000,
      384_000,
      400_000,
      1_000_000,
      2_000_000,
    ]);
  });

  it('resolves metadata for the selected config model', () => {
    const config = {
      name: 'primary',
      runtime: 'hadamard' as const,
      provider: 'anthropic' as const,
      models: [{ name: 'model-x', contextWindowTokens: 384_000 }],
    };
    expect(resolveModelContextEntry('model-x', [config], config)).toMatchObject({
      contextWindowTokens: 384_000,
    });
  });
});
