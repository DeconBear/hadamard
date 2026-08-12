import { describe, expect, it } from 'vitest';

import { nextTuiContextTokenEstimate } from '../src/tui/tuiContextUsage.js';

describe('TUI context usage', () => {
  it('tracks the current request estimate instead of aggregate run usage', () => {
    expect(nextTuiContextTokenEstimate(undefined, {
      type: 'request.started',
      data: { requestTokenEstimate: 17_899 },
    })).toBe(17_899);

    expect(nextTuiContextTokenEstimate(17_899, {
      type: 'usage',
      data: {
        usage: {
          input_tokens: 17_899,
          cache_read_input_tokens: 493_440,
          output_tokens: 6_134,
        },
      },
    })).toBe(17_899);
  });

  it('uses the post-compaction estimate immediately', () => {
    expect(nextTuiContextTokenEstimate(114_000, {
      type: 'compaction.completed',
      data: { tokenEstimateAfter: 31_000 },
    })).toBe(31_000);
  });
});
