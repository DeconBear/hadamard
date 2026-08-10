import { describe, expect, it, vi } from 'vitest';

import { stripAnsi } from '../src/tui/ansi.js';
import {
  runTuiWorkspaceCommand,
  type TuiWorkspaceCommandPort,
} from '../src/tui/tuiWorkspaceCommandHandler.js';

function createPort(): TuiWorkspaceCommandPort & { output: string[][] } {
  const output: string[][] = [];
  return {
    output,
    readFile: vi.fn(() => '# comment\nfirst prompt\n\nsecond prompt'),
    gitDiff: vi.fn(() => 'diff --git a/a.ts b/a.ts'),
    exportConversation: vi.fn(),
    getSessionDiff: vi.fn(async () => ({
      files: [{ status: 'M', path: 'a.ts', additions: 2, deletions: 1 }],
    })),
    applySessionDiff: vi.fn(async () => ({ applied: true, message: 'applied' })),
    startRun: vi.fn(async () => undefined),
    appendStatic: lines => output.push([...lines]),
  };
}

function output(port: { output: string[][] }): string {
  return port.output.flat().map(stripAnsi).join('\n');
}

describe('runTuiWorkspaceCommand', () => {
  it('returns false outside its command domain', async () => {
    expect(await runTuiWorkspaceCommand('help', '', createPort())).toBe(false);
  });

  it('runs non-comment batch lines in order', async () => {
    const port = createPort();
    await runTuiWorkspaceCommand('batch', 'prompts.txt', port);
    expect(port.startRun).toHaveBeenNthCalledWith(1, 'first prompt');
    expect(port.startRun).toHaveBeenNthCalledWith(2, 'second prompt');
    expect(output(port)).toContain('batch complete — 2 prompts done');
  });

  it('reports missing and empty batch input', async () => {
    const missing = createPort();
    await runTuiWorkspaceCommand('batch', '', missing);
    expect(output(missing)).toContain('usage: /batch <file>');

    const empty = createPort();
    vi.mocked(empty.readFile).mockReturnValue('# only comments');
    await runTuiWorkspaceCommand('batch', 'empty.txt', empty);
    expect(output(empty)).toContain('batch file is empty');
  });

  it('builds the review prompt only when a git diff exists', async () => {
    const port = createPort();
    await runTuiWorkspaceCommand('review', '', port);
    expect(port.startRun).toHaveBeenCalledWith(expect.stringContaining('```diff'));

    const clean = createPort();
    vi.mocked(clean.gitDiff).mockReturnValue('');
    await runTuiWorkspaceCommand('review', '', clean);
    expect(clean.startRun).not.toHaveBeenCalled();
    expect(output(clean)).toContain('working tree is clean');
  });

  it('exports conversations and renders session diff operations', async () => {
    const exported = createPort();
    await runTuiWorkspaceCommand('export', 'chat.md', exported);
    expect(exported.exportConversation).toHaveBeenCalledWith('chat.md');
    expect(output(exported)).toContain('conversation exported to chat.md');

    const shown = createPort();
    await runTuiWorkspaceCommand('diff', 'show', shown);
    expect(output(shown)).toContain('M a.ts +2 -1');

    const applied = createPort();
    await runTuiWorkspaceCommand('diff', 'apply --confirm', applied);
    expect(applied.applySessionDiff).toHaveBeenCalledOnce();
    expect(output(applied)).toContain('applied');
  });
});
