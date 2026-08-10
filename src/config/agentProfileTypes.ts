import type { HadamardPermissionMode, HadamardRunEffort } from '../types.js';

export interface AgentProfile {
  name: string;
  description?: string;
  bridgeConfig: string;
  model: string;
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
