import type { HadamardPermissionMode, HadamardRunEffort } from '../types.js';
import type { AgentMode } from '../runtime/agentExecutionPolicy.js';

export interface AgentProfile {
  name: string;
  description?: string;
  bridgeConfig: string;
  model: string;
  /** Reusable Agents support iterative ReAct, CodeAct, or Hybrid execution. */
  agentMode?: AgentMode;
  systemPromptAppend?: string;
  promptMode?: 'extend' | 'replace';
  subagent?: boolean;
  permissionMode?: HadamardPermissionMode;
  effort?: HadamardRunEffort;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  allowedTools?: string[];
  workspaceAccess?: 'workspace' | 'full';
  maxIterations?: number;
  timeoutMs?: number;
}
