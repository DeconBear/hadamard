import { describe, expect, it, vi } from 'vitest';

import { stripAnsi } from '../src/tui/ansi.js';
import {
  runTuiBasicCommand,
  type TuiBasicCommandPort,
} from '../src/tui/tuiBasicCommandHandler.js';

function createPort(): TuiBasicCommandPort & { output: string[][] } {
  const output: string[][] = [];
  return {
    output,
    selectItem: vi.fn(async () => undefined),
    clear: vi.fn(),
    startRun: vi.fn(async () => undefined),
    shutdown: vi.fn(),
    toolNames: () => ['Read', 'Write'],
    snapshot: () => ({
      model: 'model-a',
      inputTokens: 1250,
      outputTokens: 300,
      costUsd: 0.0123,
      usageByConfiguration: [{
        name: 'primary',
        inputTokens: 1250,
        outputTokens: 300,
        turns: 2,
        cost: '$0.0123',
        active: true,
      }],
      messages: 8,
      toolCount: 2,
      mcpToolCount: 1,
      bridgeName: 'primary',
      planMode: true,
    }),
    runGoal: vi.fn(async () => 'goal ready'),
    appendStatic: lines => output.push([...lines]),
  };
}

describe('runTuiBasicCommand', () => {
  it('keeps shared help metadata behind the picker', async () => {
    const port = createPort();
    await runTuiBasicCommand('help', '', port);
    expect(port.selectItem).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Help',
      items: expect.arrayContaining([
        expect.objectContaining({ id: 'model', label: '/model' }),
      ]),
    }));
  });

  it('preserves usage and stats output', async () => {
    const usage = createPort();
    await runTuiBasicCommand('usage', '', usage);
    const usageText = usage.output.flat().map(stripAnsi).join('\n');
    expect(usageText).toContain('1.3k in · 300 out');
    expect(usageText).toContain('By config');
    expect(usageText).toContain('primary');

    const stats = createPort();
    await runTuiBasicCommand('stats', '', stats);
    const statsText = stats.output.flat().map(stripAnsi).join('\n');
    expect(statsText).toContain('8');
    expect(statsText).toContain('bridge:primary');
    expect(statsText).toContain('plan mode');
  });

  it('delegates goal and lifecycle operations', async () => {
    const port = createPort();
    await runTuiBasicCommand('goal', 'status', port);
    expect(port.runGoal).toHaveBeenCalledWith('status');
    expect(port.output.flat().map(stripAnsi).join('\n')).toContain('goal ready');

    await runTuiBasicCommand('exit', '', port);
    expect(port.shutdown).toHaveBeenCalledTimes(1);
  });

  it('leaves agent-run coordination commands to the controller', async () => {
    expect(await runTuiBasicCommand('batch', 'prompts.txt', createPort())).toBe(false);
  });
});
