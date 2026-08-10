import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stripAnsi } from '../src/tui/ansi.js';
import {
  runTuiWorkflowCommand,
  type TuiWorkflowCommandPort,
} from '../src/tui/tuiWorkflowCommandHandler.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function createPort(): Promise<TuiWorkflowCommandPort & { output: string[][] }> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-tui-workflow-'));
  roots.push(workDir);
  const output: string[][] = [];
  return {
    output,
    workDir,
    homeDir: workDir,
    selectItem: vi.fn(async () => undefined),
    promptText: vi.fn(async () => undefined),
    runWorkflowScript: vi.fn(async () => ({ result: 'done', errors: [] })),
    renderRichText: text => text.split('\n'),
    appendStatic: lines => output.push([...lines]),
  };
}

describe('runTuiWorkflowCommand', () => {
  it('returns false for commands outside workflow and automation', async () => {
    expect(await runTuiWorkflowCommand('help', '', await createPort())).toBe(false);
  });

  it('keeps the workflow picker available when no scripts are saved', async () => {
    const port = await createPort();
    await runTuiWorkflowCommand('workflows', '', port);
    expect(port.selectItem).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Workflows',
      items: [expect.objectContaining({ id: '__orchestrate__' })],
    }));
  });

  it('reports missing saved workflows without invoking the runtime', async () => {
    const port = await createPort();
    await runTuiWorkflowCommand('workflows', 'run missing task', port);
    expect(port.runWorkflowScript).not.toHaveBeenCalled();
    expect(port.output.flat().map(stripAnsi).join('\n')).toContain('workflow not found: missing');
  });

  it('lists empty automation state and validates subcommands', async () => {
    const list = await createPort();
    await runTuiWorkflowCommand('automation', 'list', list);
    expect(list.output.flat().map(stripAnsi).join('\n')).toContain('No automation tasks configured.');

    const invalid = await createPort();
    await runTuiWorkflowCommand('automation', 'remove', invalid);
    expect(invalid.output.flat().map(stripAnsi).join('\n')).toContain('usage: /automation');
  });
});
