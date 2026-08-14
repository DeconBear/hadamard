import { describe, expect, it } from 'vitest';

import { estimateTuiContextTokens, nextTuiContextTokenEstimate } from '../src/tui/tuiContextUsage.js';

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

  it('estimates idle context from system, tools, and messages instead of 0', () => {
    const tokens = estimateTuiContextTokens({
      systemPrompt: 'You are Hadamard Agent. '.repeat(200),
      tools: [{
        name: 'Read',
        description: 'Read a file from disk',
        inputJsonSchema: { type: 'object', properties: { file_path: { type: 'string' } } },
      }],
      messages: [{ role: 'user', content: '你好' }],
    });
    expect(tokens).toBeGreaterThan(200);
    const helloOnly = estimateTuiContextTokens({
      systemPrompt: '',
      tools: [],
      messages: [{ role: 'user', content: '你好' }],
    });
    expect(tokens).toBeGreaterThan(helloOnly);
    expect(helloOnly).toBeLessThan(50);
  });

  it('keeps project-instruction tokens when they move from system into a user reminder', () => {
    const project = '# Project instructions\n' + 'rule '.repeat(800);
    const tools = [{ name: 'Read', description: 'Read a file' }];
    const asSystem = estimateTuiContextTokens({
      systemPrompt: `You are Hadamard.\n\n${project}`,
      tools,
      messages: [{ role: 'user', content: 'hello' }],
    });
    const asUser = estimateTuiContextTokens({
      systemPrompt: 'You are Hadamard.',
      tools,
      messages: [
        { role: 'user', content: `<system-reminder>\n${project}\n</system-reminder>` },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(asUser).toBeGreaterThan(asSystem * 0.9);
    expect(Math.abs(asUser - asSystem)).toBeLessThan(asSystem * 0.2);
  });
});
