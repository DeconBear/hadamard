import { describe, expect, it } from 'vitest';

import { selectOutputCacheEntries } from '../src/hcanvas/execOutputs.js';

describe('Notebook output cache budget', () => {
  const entries: Array<[string, { outputs: Array<{ text: string }> }]> = [
    ['a', { outputs: [{ text: 'a'.repeat(100) }] }],
    ['b', { outputs: [{ text: 'b'.repeat(100) }] }],
    ['c', { outputs: [{ text: 'c'.repeat(100) }] }],
  ];

  it('keeps all entries within budget', () => {
    expect(selectOutputCacheEntries(entries, 10_000).map(entry => entry[0])).toEqual(['a', 'b', 'c']);
  });

  it('drops the oldest entries first under pressure', () => {
    const only = selectOutputCacheEntries(entries, 260).map(entry => entry[0]);
    expect(only).toEqual(['c']);
  });

  it('disables cache when budget is zero', () => {
    expect(selectOutputCacheEntries(entries, 0)).toEqual([]);
  });
});
