import { describe, expect, it, vi } from 'vitest';

import { stripAnsi } from '../src/tui/ansi.js';
import {
  runTuiSessionCommand,
  type TuiSessionCommandPort,
} from '../src/tui/tuiSessionCommandHandler.js';

function createPort(): TuiSessionCommandPort & { output: string[][] } {
  const output: string[][] = [];
  return {
    output,
    current: () => ({ id: 'current', title: 'Chat', model: 'model-a', messageCount: 6 }),
    checkpoints: {
      list: vi.fn(async () => []),
      preview: vi.fn(async () => { throw new Error('not expected'); }),
      restore: vi.fn(async () => { throw new Error('not expected'); }),
      restoreConversation: vi.fn(async () => undefined),
    },
    rewind: vi.fn(async () => 'rewound-session'),
    listStoredSessions: vi.fn(async () => [{
      id: 'current', title: 'Chat', model: 'model-a', status: 'active', kind: 'main',
    }]),
    querySessions: vi.fn(async () => [{
      sessionId: 's-1',
      projectName: 'repo',
      type: 'user',
      title: 'Result',
      archived: false,
      pinned: true,
    }]),
    resume: vi.fn(async () => undefined),
    tree: vi.fn(async () => [{
      id: 'current', title: 'Chat', branchName: 'main', children: [],
    }]),
    ensureMessageIds: vi.fn(async () => [{ id: 'm-1', role: 'user' }]),
    fork: vi.fn(async () => 'forked'),
    clone: vi.fn(async () => 'cloned'),
    label: vi.fn(async () => undefined),
    catalogAction: vi.fn(async () => true),
    appendStatic: lines => output.push([...lines]),
  };
}

describe('runTuiSessionCommand', () => {
  it('validates rewind bounds before calling the session port', async () => {
    const invalid = createPort();
    await runTuiSessionCommand('rewind', '0', invalid);
    expect(invalid.rewind).not.toHaveBeenCalled();
    expect(invalid.output.flat().map(stripAnsi).join('\n')).toContain('usage: /rewind');

    const valid = createPort();
    await runTuiSessionCommand('rewind', '2', valid);
    expect(valid.rewind).toHaveBeenCalledWith(2);
    expect(valid.output.flat().map(stripAnsi).join('\n')).toContain('rewound 2 messages');
  });

  it('parses session catalog filters without exposing catalog infrastructure', async () => {
    const port = createPort();
    await runTuiSessionCommand(
      'sessions',
      '--type all --archived archived --project "E:/repo x" --status running --query bug',
      port,
    );
    expect(port.querySessions).toHaveBeenCalledWith({
      types: ['user', 'assistant-global', 'assistant-project', 'agent'],
      archived: 'archived',
      project: 'E:/repo x',
      status: 'running',
      query: 'bug',
    });
    expect(port.output.flat().map(stripAnsi).join('\n')).toContain('★ s-1 · repo · user · Result');
  });

  it('requires checkpoint confirmation before restore', async () => {
    const port = createPort();
    await runTuiSessionCommand('checkpoint', 'restore cp-1 both', port);
    expect(port.checkpoints.preview).not.toHaveBeenCalled();
    expect(port.output.flat().map(stripAnsi).join('\n')).toContain('--confirm');
  });

  it('keeps tree, fork, and catalog actions in the session command domain', async () => {
    const tree = createPort();
    await runTuiSessionCommand('session', 'tree', tree);
    expect(tree.output.flat().map(stripAnsi).join('\n')).toContain('main');

    const fork = createPort();
    await runTuiSessionCommand('session', 'fork m-1 review', fork);
    expect(fork.fork).toHaveBeenCalledWith('m-1', 'review');

    const rename = createPort();
    await runTuiSessionCommand('session', 'rename Better title', rename);
    expect(rename.catalogAction).toHaveBeenCalledWith('rename', 'current', 'Better title');
  });

  it('returns false for unrelated commands', async () => {
    expect(await runTuiSessionCommand('help', '', createPort())).toBe(false);
  });
});
