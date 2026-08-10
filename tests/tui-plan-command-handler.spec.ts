import { describe, expect, it, vi } from 'vitest';

import { stripAnsi } from '../src/tui/ansi.js';
import {
  runTuiPlanCommand,
  type TuiPlanCommandPort,
} from '../src/tui/tuiPlanCommandHandler.js';

function createPort(overrides: Partial<TuiPlanCommandPort> = {}): TuiPlanCommandPort & { output: string[][] } {
  const output: string[][] = [];
  let mode: ReturnType<TuiPlanCommandPort['currentPermissionMode']> = 'default';
  return {
    output,
    defaultPermissionMode: () => 'bypassPermissions',
    currentPermissionMode: () => mode,
    setPermissionMode: vi.fn(async value => { mode = value; }),
    readPlan: () => null,
    planFile: () => 'C:/repo/.hadamard/plan.md',
    openPlanFile: () => true,
    startRun: vi.fn(async () => undefined),
    renderRichText: text => text.split('\n'),
    appendStatic: lines => output.push([...lines]),
    ...overrides,
  };
}

describe('runTuiPlanCommand', () => {
  it('returns false for unrelated commands', async () => {
    expect(await runTuiPlanCommand('help', '', createPort())).toBe(false);
  });

  it('enters plan mode and renders an existing plan', async () => {
    const port = createPort({ readPlan: () => '# Plan\nDo it' });
    await runTuiPlanCommand('plan', '', port);
    expect(port.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(port.output.flat().map(stripAnsi).join('\n')).toContain('# Plan');
  });

  it('requires a plan before approval and restores the default permission mode', async () => {
    const missing = createPort();
    await runTuiPlanCommand('plan', 'approve', missing);
    expect(missing.output.flat().map(stripAnsi).join('\n')).toContain('there is no saved plan to approve');
    expect(missing.setPermissionMode).not.toHaveBeenCalled();

    const existing = createPort({ readPlan: () => 'ready' });
    await runTuiPlanCommand('plan', 'approve', existing);
    expect(existing.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
  });

  it('passes revision feedback to the agent while staying in plan mode', async () => {
    const port = createPort();
    await runTuiPlanCommand('plan', 'revise add tests', port);
    expect(port.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(port.startRun).toHaveBeenCalledWith(expect.stringContaining('add tests'));
  });
});
