import {
  isAgentMode,
  type AgentMode,
} from './agentExecutionPolicy.js';

export const SESSION_AGENT_MODE_KEY = '__hadamardAgentMode';

export interface AgentModeChecks {
  react: boolean;
  codeact: boolean;
}

export function agentModeToChecks(mode: AgentMode): AgentModeChecks {
  return {
    react: mode === 'react' || mode === 'hybrid',
    codeact: mode === 'codeact' || mode === 'hybrid',
  };
}

export function agentModeFromChecks(checks: AgentModeChecks): AgentMode {
  if (checks.react && checks.codeact) return 'hybrid';
  if (checks.react) return 'react';
  if (checks.codeact) return 'codeact';
  throw new Error('Select at least one execution mode: ReAct or CodeAct.');
}

export function readSessionAgentMode(
  metadata: Record<string, unknown> | undefined,
  fallback: AgentMode = 'react',
): AgentMode {
  const value = metadata?.[SESSION_AGENT_MODE_KEY];
  return isAgentMode(value) ? value : fallback;
}

export function sessionAgentModePatch(mode: AgentMode): Record<string, AgentMode> {
  return { [SESSION_AGENT_MODE_KEY]: mode };
}
