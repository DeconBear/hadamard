import { describe, expect, it, vi } from 'vitest';

import type { TeamGraphProposal } from '../src/team/teamProposalService.js';
import { stripAnsi } from '../src/tui/ansi.js';
import {
  runTuiAssistantCommand,
  type TuiAssistantCommandPort,
} from '../src/tui/tuiAssistantCommandHandler.js';

function proposal(): TeamGraphProposal {
  return {
    id: 'proposal-1',
    assistantSessionId: 'assistant-1',
    projectPath: 'E:/project',
    teamName: 'review-team',
    baseFingerprint: null,
    baseSource: null,
    explanation: 'Add a reviewer.',
    problems: [],
    diff: {
      addedNodes: ['reviewer'],
      removedNodes: [],
      changedNodes: [],
      addedEdges: [],
      removedEdges: [],
      changedEdges: [],
    },
    draft: {
      name: 'review-team',
      mode: 'analysis',
      members: [{ model: 'test-model', name: 'reviewer' }],
    },
    status: 'pending',
    createdAt: '2026-08-10T00:00:00.000Z',
  };
}

function createPort(): TuiAssistantCommandPort & { output: string[][] } {
  const output: string[][] = [];
  return {
    output,
    assistant: {
      initialize: vi.fn(async () => undefined),
      listSessions: vi.fn(async () => [{
        id: 'assistant-1',
        title: 'Assistant (Global)',
        messageCount: 4,
        active: true,
      }]),
      createSession: vi.fn(async () => 'assistant-2'),
      resumeSession: vi.fn(async id => id === 'assistant-1' ? { title: 'Assistant (Global)' } : undefined),
      run: vi.fn(async (_prompt, onTool) => {
        onTool('ListProjects');
        return { text: 'assistant answer', proposals: [] };
      }),
      proposalDiff: vi.fn(() => ['+ reviewer']),
      applyProposal: vi.fn(async () => 'E:/project/.hadamard/teams/review-team.json'),
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

describe('runTuiAssistantCommand', () => {
  it('returns false outside the assistant command domain', async () => {
    expect(await runTuiAssistantCommand('help', '', createPort())).toBe(false);
  });

  it('lists, creates, and resumes global assistant sessions', async () => {
    const sessions = createPort();
    await runTuiAssistantCommand('assistant', 'sessions', sessions);
    expect(output(sessions)).toContain('Global Assistant Sessions');
    expect(output(sessions)).toContain('assistant-1 · Assistant (Global) · 4 messages');

    const created = createPort();
    await runTuiAssistantCommand('assistant', 'new', created);
    expect(output(created)).toContain('Global Assistant Session created: assistant-2');

    const missing = createPort();
    await runTuiAssistantCommand('assistant', 'resume missing', missing);
    expect(output(missing)).toContain('Global Assistant Session not found: missing');
  });

  it('runs chat through the assistant service and preserves tool activity output', async () => {
    const port = createPort();
    await runTuiAssistantCommand('assistant', 'chat teach me the app', port);
    expect(port.assistant.run).toHaveBeenCalledWith('teach me the app', expect.any(Function));
    expect(output(port)).toContain('⚙ ListProjects');
    expect(output(port)).toContain('assistant answer');
  });

  it('builds team prompts and applies proposals after confirmation', async () => {
    const port = createPort();
    vi.mocked(port.assistant.run).mockResolvedValue({ text: undefined, proposals: [proposal()] });
    vi.mocked(port.selectItem).mockResolvedValue('apply');

    await runTuiAssistantCommand('assistant', 'team review this project', port);

    expect(port.assistant.run).toHaveBeenCalledWith(
      expect.stringContaining('Propose a Team Graph for this request.'),
      expect.any(Function),
    );
    expect(port.assistant.applyProposal).toHaveBeenCalledWith('proposal-1');
    expect(output(port)).toContain('Team proposal · review-team');
    expect(output(port)).toContain('Team saved: E:/project/.hadamard/teams/review-team.json');
  });

  it('preserves chat and team usage validation', async () => {
    const port = createPort();
    await runTuiAssistantCommand('assistant', 'chat', port);
    await runTuiAssistantCommand('assistant', 'unknown', port);
    expect(port.assistant.run).not.toHaveBeenCalled();
    expect(output(port)).toContain('usage: /assistant chat <message>');
    expect(output(port)).toContain('usage: /assistant [chat');
  });
});
