import { describe, expect, it } from 'vitest';
import { formatTeamAskCommand, parseTeamAskArguments } from '../src/ui/commandSurface.js';

describe('team ask command parsing', () => {
  it('round-trips team names containing spaces', () => {
    const command = formatTeamAskCommand('QA Workflow', 'run the audit');
    expect(command).toBe('/team ask "QA Workflow" run the audit');
    expect(parseTeamAskArguments(command.slice('/team ask '.length))).toEqual({
      name: 'QA Workflow',
      prompt: 'run the audit',
    });
  });

  it('keeps legacy single-token team commands working', () => {
    expect(parseTeamAskArguments('reviewers inspect this')).toEqual({
      name: 'reviewers',
      prompt: 'inspect this',
    });
  });

  it('rejects a missing team name or prompt', () => {
    expect(parseTeamAskArguments('"QA Workflow"')).toBeNull();
    expect(parseTeamAskArguments('reviewers')).toBeNull();
  });
});
