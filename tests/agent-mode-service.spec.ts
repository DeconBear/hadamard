import { describe, expect, it } from 'vitest';

import {
  SESSION_AGENT_MODE_KEY,
  agentModeFromChecks,
  agentModeToChecks,
  readSessionAgentMode,
  sessionAgentModePatch,
} from '../src/runtime/agentModeService.js';

describe('AgentModeService', () => {
  it('maps the TUI ReAct and CodeAct checkboxes onto the three reusable modes', () => {
    expect(agentModeFromChecks({ react: true, codeact: false })).toBe('react');
    expect(agentModeFromChecks({ react: false, codeact: true })).toBe('codeact');
    expect(agentModeFromChecks({ react: true, codeact: true })).toBe('hybrid');
    expect(() => agentModeFromChecks({ react: false, codeact: false })).toThrow(/at least one/i);

    expect(agentModeToChecks('react')).toEqual({ react: true, codeact: false });
    expect(agentModeToChecks('codeact')).toEqual({ react: false, codeact: true });
    expect(agentModeToChecks('hybrid')).toEqual({ react: true, codeact: true });
  });

  it('persists a session mode through the shared metadata key and uses a safe fallback', () => {
    expect(sessionAgentModePatch('hybrid')).toEqual({ [SESSION_AGENT_MODE_KEY]: 'hybrid' });
    expect(readSessionAgentMode({ [SESSION_AGENT_MODE_KEY]: 'codeact' })).toBe('codeact');
    expect(readSessionAgentMode({ [SESSION_AGENT_MODE_KEY]: 'single' }, 'react')).toBe('react');
  });
});
