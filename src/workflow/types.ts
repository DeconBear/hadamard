import type { AgentEvent, AgentMcpServerDefinition, AgentToolDefinition } from '../types.js';
import type { AgentNodeMode } from '../runtime/agentExecutionPolicy.js';

export interface WorkflowStepDefinition {
  id: string;
  /** Human-readable description. Used as display name in events and session titles. Can be empty. */
  description: string;
  prompt: string;
  /** Per-step tools injected alongside global defaults. Strings resolved via SDK tool registry. */
  tools?: (string | AgentToolDefinition)[];
  /** Per-step MCP servers. */
  mcpServers?: AgentMcpServerDefinition[];
  allowedTools?: string[];
  /** Per-step skill directories to load (merged with global skills). */
  skillDirectories?: string[];
  model?: string | null;
  systemPrompt?: string;
  /** @deprecated Use agentMode. */
  mode?: 'react' | 'single';
  /** Node execution mode. Single permits zero or one selected ordinary tool. */
  agentMode?: AgentNodeMode | 'inherit';
  dependsOn: string[];
  retries?: number;
  timeoutMs?: number;
}

export interface WorkflowParameter {
  type: 'string' | 'number' | 'boolean' | 'json';
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface WorkflowDefinition {
  name: string;
  description: string;
  steps: WorkflowStepDefinition[];
  parameters?: Record<string, WorkflowParameter>;
  model?: string | null;
  systemPrompt?: string;
}

export interface WorkflowStepResult {
  id: string;
  name: string;
  status: 'completed' | 'failed' | 'skipped';
  text: string;
  toolCalls: string[];
  durationMs: number;
  sessionId: string;
  error?: string;
}

export interface WorkflowRunResult {
  runId: string;
  workflowName: string;
  steps: WorkflowStepResult[];
  text: string;
  durationMs: number;
  status: 'completed' | 'partial' | 'failed';
}

export interface WorkflowRunOptions {
  workDir: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}
