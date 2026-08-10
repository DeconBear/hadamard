import { describe, expect, it } from 'vitest';

import { stripAnsi } from '../src/tui/ansi.js';
import { runTuiWorktreeCommand } from '../src/tui/tuiWorktreeCommandHandler.js';

describe('runTuiWorktreeCommand', () => {
  it('returns false for unrelated commands', async () => {
    expect(await runTuiWorktreeCommand('help', '', {
      workDir: process.cwd(),
      appendStatic: () => undefined,
    })).toBe(false);
  });

  it('preserves the usage response for a bare worktree command', async () => {
    const output: string[][] = [];
    expect(await runTuiWorktreeCommand('worktree', '', {
      workDir: process.cwd(),
      appendStatic: lines => output.push([...lines]),
    })).toBe(true);
    expect(output.flat().map(stripAnsi).join('\n')).toContain('/worktree [enter <name>|exit|list]');
  });
});
