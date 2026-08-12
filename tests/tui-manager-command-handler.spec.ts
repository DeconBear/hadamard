import { describe, expect, it, vi } from 'vitest';

import { stripAnsi } from '../src/tui/ansi.js';
import {
  runTuiManagerCommand,
  type TuiManagerCommandPort,
} from '../src/tui/tuiManagerCommandHandler.js';

function createPort(): TuiManagerCommandPort & { output: string[][] } {
  const output: string[][] = [];
  return {
    output,
    manager: {
      listSessions: vi.fn(async () => [{
        id: 'manager-1',
        title: 'Manager',
        messageCount: 3,
        active: true,
      }]),
      createSession: vi.fn(async () => 'manager-2'),
      resumeSession: vi.fn(async id => id === 'manager-1' ? { title: 'Manager' } : undefined),
      status: vi.fn(async () => ({
        model: 'test-model (session default)',
        readScope: 'workspace-only',
        milestones: 2,
        today: 1,
        upcoming: 3,
        designChars: null,
      })),
      config: vi.fn(async () => ({ readScope: 'workspace-only' })),
      setConfig: vi.fn(async key => key === 'bad'
        ? { ok: false, message: 'invalid key' }
        : { ok: true, message: `Manager config updated: ${key}` }),
      schedules: vi.fn(async () => []),
      run: vi.fn(async (_kind, _instruction, onNotice, onTool) => {
        onNotice('plan preview');
        onTool('ReadPlan');
        return {
          text: 'manager answer',
          proposals: [],
          designPath: 'E:/project/DESIGN.md',
        };
      }),
      proposalDiff: vi.fn(() => []),
      applyProposal: vi.fn(async () => ({ teamName: 'team', filePath: 'team.json' })),
      rejectProposal: vi.fn(),
    },
    selectItem: vi.fn(async () => undefined),
    renderRichText: text => text.split('\n'),
    appendStatic: lines => output.push([...lines]),
  };
}

function output(port: { output: string[][] }): string {
  return port.output.flat().map(stripAnsi).join('\n');
}

describe('runTuiManagerCommand', () => {
  it('returns false outside the manager command domain', async () => {
    expect(await runTuiManagerCommand('help', '', createPort())).toBe(false);
  });

  it('renders project manager status without runtime dependencies', async () => {
    const port = createPort();
    await runTuiManagerCommand('manager', 'status', port);
    expect(output(port)).toContain('model: test-model (session default)');
    expect(output(port)).toContain('plan.json: 2 milestones · 1 today · 3 upcoming');
    expect(output(port)).toContain('DESIGN.md: (none yet — /manager update)');
  });

  it('lists, creates, and resumes manager sessions', async () => {
    const list = createPort();
    await runTuiManagerCommand('manager', 'sessions', list);
    expect(output(list)).toContain('manager-1 · Manager · 3 messages');

    const created = createPort();
    await runTuiManagerCommand('manager', 'new', created);
    expect(output(created)).toContain('Manager Session created: manager-2');

    const missing = createPort();
    await runTuiManagerCommand('manager', 'resume missing', missing);
    expect(output(missing)).toContain('Manager Session not found: missing');
  });

  it('delegates config parsing and preserves success and error presentation', async () => {
    const success = createPort();
    await runTuiManagerCommand('manager', 'config set model new-model', success);
    expect(success.manager.setConfig).toHaveBeenCalledWith('model', 'new-model');
    expect(output(success)).toContain('Manager config updated: model');

    const error = createPort();
    await runTuiManagerCommand('manager', 'config set bad value', error);
    expect(output(error)).toContain('invalid key');
  });

  it('runs chat and update turns with unchanged tool and Design output', async () => {
    const chat = createPort();
    await runTuiManagerCommand('manager', 'chat inspect status', chat);
    expect(chat.manager.run).toHaveBeenCalledWith(
      'chat',
      'inspect status',
      expect.any(Function),
      expect.any(Function),
    );
    expect(output(chat)).toContain('⚡ ReadPlan');
    expect(output(chat)).toContain('manager answer');
    expect(output(chat).indexOf('plan preview')).toBeLessThan(output(chat).indexOf('⚡ ReadPlan'));

    const update = createPort();
    await runTuiManagerCommand('manager', 'update refresh', update);
    expect(output(update)).toContain('Manager: updating Design and plan documents…');
    expect(output(update)).toContain('Design updated · E:/project/DESIGN.md');
  });

  it('preserves required chat/team prompts and unknown usage', async () => {
    const port = createPort();
    await runTuiManagerCommand('manager', 'team', port);
    await runTuiManagerCommand('manager', 'unknown', port);
    expect(port.manager.run).not.toHaveBeenCalled();
    expect(output(port)).toContain('usage: /manager team <request>');
    expect(output(port)).toContain('usage: /manager [status');
  });
});
