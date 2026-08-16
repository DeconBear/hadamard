import { describe, expect, it } from 'vitest';

import {
  HadamardContributionHost,
  codeDispatchFormatterKey,
  createCodeDispatchTranscriptContribution,
  defaultCodeDispatchTranscriptFormatter,
} from '../src/index.js';

const event = {
  type: 'tool.code_dispatch' as const,
  runId: 'run-x',
  iteration: 2,
  rootCallId: 'cell-1',
  subCallId: 'cell-1:host:3',
  name: 'Read',
  phase: 'settle' as const,
  isError: false,
  summary: 'contents',
  timestamp: '2026-08-16T00:00:00.000Z',
};


describe('code dispatch transcript formatter', () => {
  it('renders the default structured audit copy', () => {
    const text = defaultCodeDispatchTranscriptFormatter({ runId: 'run-x', iteration: 2, event });
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.kind).toBe('code-dispatch');
    expect(parsed.name).toBe('Read');
    expect(parsed.summary).toBe('contents');
  });

  it('registers and revokes the formatter through the contribution host', async () => {
    const host = new HadamardContributionHost();
    await host.loadMany([createCodeDispatchTranscriptContribution()]);
    expect(host.getService(codeDispatchFormatterKey)).toBe(defaultCodeDispatchTranscriptFormatter);
    await host.dispose();
    expect(host.getService(codeDispatchFormatterKey)).toBeUndefined();
  });
});

