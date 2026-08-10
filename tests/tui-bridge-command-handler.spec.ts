import { describe, expect, it, vi } from 'vitest';

import { stripAnsi } from '../src/tui/ansi.js';
import {
  runTuiBridgeCommand,
  type TuiBridgeCommandPort,
} from '../src/tui/tuiBridgeCommandHandler.js';

function createPort(): TuiBridgeCommandPort & { output: string[][] } {
  const output: string[][] = [];
  return {
    output,
    runs: {
      run: vi.fn(async () => undefined),
      background: vi.fn(async () => undefined),
      listRuns: vi.fn(),
      stop: vi.fn(),
      status: vi.fn(),
      history: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
    },
    configuration: {
      switchProvider: vi.fn(async () => undefined),
      setup: vi.fn(async () => undefined),
      manage: vi.fn(async () => undefined),
      disable: vi.fn(async () => undefined),
      selectModel: vi.fn(async () => undefined),
      help: vi.fn(),
      openBoard: vi.fn(async () => undefined),
    },
    appendStatic: lines => output.push([...lines]),
  };
}

describe('runTuiBridgeCommand', () => {
  it('validates prompts and native session ids', async () => {
    const missing = createPort();
    await runTuiBridgeCommand('bridge', 'run', missing);
    expect(missing.runs.run).not.toHaveBeenCalled();
    expect(missing.output.flat().map(stripAnsi).join('\n')).toContain('usage: /bridge run');

    const resume = createPort();
    await runTuiBridgeCommand('bridge', 'resume native-1', resume);
    expect(resume.runs.resume).toHaveBeenCalledWith('native-1');
  });

  it('routes run and configuration actions to separate small ports', async () => {
    const run = createPort();
    await runTuiBridgeCommand('bridge', 'background inspect logs', run);
    expect(run.runs.background).toHaveBeenCalledWith('inspect logs');

    const config = createPort();
    await runTuiBridgeCommand('bridge', 'model model-x', config);
    expect(config.configuration.selectModel).toHaveBeenCalledWith('model-x');
  });

  it('opens the bridge board for a bare command and ignores unrelated commands', async () => {
    const port = createPort();
    expect(await runTuiBridgeCommand('bridge', '', port)).toBe(true);
    expect(port.configuration.openBoard).toHaveBeenCalledTimes(1);
    expect(await runTuiBridgeCommand('help', '', port)).toBe(false);
  });
});
