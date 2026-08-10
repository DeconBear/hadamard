import { describe, expect, it, vi } from 'vitest';

import { stripAnsi } from '../src/tui/ansi.js';
import {
  runTuiMemoryCommand,
  type TuiMemoryCommandPort,
} from '../src/tui/tuiMemoryCommandHandler.js';

function createPort(): TuiMemoryCommandPort & { output: string[][] } {
  const output: string[][] = [];
  return {
    output,
    runMemoryCommand: vi.fn(async () => ({
      title: 'Memory',
      message: 'ready',
      text: 'line one\nline two',
    })),
    compact: vi.fn(async () => ({
      compacted: true,
      trigger: 'manual',
      reason: 'manual',
      messagesRemoved: 3,
      tokenEstimateBefore: 100,
    })),
    compactPromptMode: () => 'hybrid',
    dreamState: vi.fn(async () => ({ enabled: true } as never)),
    dream: vi.fn(async () => ({ success: true, skipped: false } as never)),
    selectDreamAction: vi.fn(async () => 'status'),
    appendStatic: lines => output.push([...lines]),
  };
}

describe('runTuiMemoryCommand', () => {
  it('returns false for commands outside the memory domain', async () => {
    expect(await runTuiMemoryCommand('help', '', createPort())).toBe(false);
  });

  it('preserves memory result formatting', async () => {
    const port = createPort();
    expect(await runTuiMemoryCommand('memory', '', port)).toBe(true);

    const text = port.output.flat().map(stripAnsi).join('\n');
    expect(text).toContain('Memory');
    expect(text).toContain('ready');
    expect(text).toContain('line one');
    expect(port.runMemoryCommand).toHaveBeenCalledWith('status');
  });

  it('preserves compact success and failure messages', async () => {
    const success = createPort();
    await runTuiMemoryCommand('compact', 'focus on decisions', success);
    expect(success.compact).toHaveBeenCalledWith('focus on decisions');
    expect(success.output.flat().map(stripAnsi).join('\n')).toContain('3 messages summarized · mode: hybrid');

    const skipped = createPort();
    skipped.compact = vi.fn(async () => ({
      compacted: false,
      trigger: 'manual',
      reason: 'threshold_not_met',
      tokenEstimateBefore: 10,
      error: 'compact skipped: threshold_not_met',
    }));
    await runTuiMemoryCommand('compact', '', skipped);
    expect(skipped.output.flat().map(stripAnsi).join('\n')).toContain('compact skipped: threshold_not_met');
  });

  it('uses the picker for a bare dream command', async () => {
    const port = createPort();
    await runTuiMemoryCommand('dream', '', port);
    expect(port.selectDreamAction).toHaveBeenCalledTimes(1);
    expect(port.dreamState).toHaveBeenCalledTimes(1);
  });
});
