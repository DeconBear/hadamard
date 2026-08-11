import { HadamardSdkError } from '../errors.js';

export const AGENT_MODES = ['react', 'codeact', 'hybrid'] as const;
export const AGENT_NODE_MODES = [...AGENT_MODES, 'single'] as const;

export type AgentMode = typeof AGENT_MODES[number];
export type AgentNodeMode = typeof AGENT_NODE_MODES[number];

export interface AgentExecutionPolicy {
  actionSpace: 'json-tools' | 'code-cell' | 'hybrid' | 'none';
  turnPolicy: 'iterative' | 'single';
  ordinaryTools: string[];
  maxOrdinaryToolCalls?: number;
}

export type AgentExecutionPolicyErrorCode =
  | 'CODEACT_DISABLED'
  | 'INVALID_AGENT_MODE'
  | 'SINGLE_TOOL_LIMIT';

export class AgentExecutionPolicyError extends HadamardSdkError {
  constructor(message: string, code: AgentExecutionPolicyErrorCode) {
    super(message, code);
  }
}

export interface ResolveAgentExecutionPolicyOptions {
  nodeMode?: AgentNodeMode | 'inherit';
  agentMode?: AgentMode;
  sessionMode?: AgentMode;
  projectMode?: AgentMode;
  ordinaryTools?: readonly string[];
  codeActEnabled: boolean;
}

export function isAgentMode(value: unknown): value is AgentMode {
  return typeof value === 'string' && AGENT_MODES.includes(value as AgentMode);
}

export function isAgentNodeMode(value: unknown): value is AgentNodeMode {
  return typeof value === 'string' && AGENT_NODE_MODES.includes(value as AgentNodeMode);
}

export function parseAgentMode(value: unknown, label = 'agentMode'): AgentMode {
  if (!isAgentMode(value)) {
    throw new AgentExecutionPolicyError(
      `${label} must be react, codeact, or hybrid.`,
      'INVALID_AGENT_MODE',
    );
  }
  return value;
}

export function parseAgentNodeMode(value: unknown, label = 'agentMode'): AgentNodeMode {
  if (!isAgentNodeMode(value)) {
    throw new AgentExecutionPolicyError(
      `${label} must be react, codeact, hybrid, or single.`,
      'INVALID_AGENT_MODE',
    );
  }
  return value;
}

export function migrateLegacyWorkflowAgentMode(input: {
  agentMode?: unknown;
  mode?: unknown;
}): AgentNodeMode | undefined {
  if (input.agentMode !== undefined) return parseAgentNodeMode(input.agentMode);
  if (input.mode === undefined) return undefined;
  if (input.mode === 'react' || input.mode === 'single') return input.mode;
  throw new AgentExecutionPolicyError(
    'Legacy workflow mode must be react or single.',
    'INVALID_AGENT_MODE',
  );
}

export function migrateLegacyGraphAgentMode(input: {
  agentMode?: unknown;
  type?: unknown;
}): AgentNodeMode | undefined {
  if (input.agentMode !== undefined) return parseAgentNodeMode(input.agentMode);
  if (input.type === undefined || input.type === 'team') return undefined;
  if (input.type === 'react' || input.type === 'single') return input.type;
  throw new AgentExecutionPolicyError(
    'Legacy graph type must be react, single, or team.',
    'INVALID_AGENT_MODE',
  );
}

export function resolveAgentExecutionPolicy(
  options: ResolveAgentExecutionPolicyOptions,
): AgentExecutionPolicy {
  const mode = resolveMode(options);
  const ordinaryTools = uniqueTools(options.ordinaryTools ?? []);

  if ((mode === 'codeact' || mode === 'hybrid') && !options.codeActEnabled) {
    throw new AgentExecutionPolicyError(
      `Agent mode ${mode} requires projectSettings.codeAct.enabled.`,
      'CODEACT_DISABLED',
    );
  }
  if (mode === 'single') {
    if (ordinaryTools.length > 1) {
      throw new AgentExecutionPolicyError(
        'Single mode accepts at most one ordinary JSON tool.',
        'SINGLE_TOOL_LIMIT',
      );
    }
    return {
      actionSpace: ordinaryTools.length === 0 ? 'none' : 'json-tools',
      turnPolicy: 'single',
      ordinaryTools,
      maxOrdinaryToolCalls: ordinaryTools.length,
    };
  }
  if (mode === 'codeact') {
    return { actionSpace: 'code-cell', turnPolicy: 'iterative', ordinaryTools: [] };
  }
  if (mode === 'hybrid') {
    return { actionSpace: 'hybrid', turnPolicy: 'iterative', ordinaryTools };
  }
  return { actionSpace: 'json-tools', turnPolicy: 'iterative', ordinaryTools };
}

function resolveMode(options: ResolveAgentExecutionPolicyOptions): AgentNodeMode {
  if (options.nodeMode && options.nodeMode !== 'inherit') return options.nodeMode;
  return options.agentMode ?? options.sessionMode ?? options.projectMode ?? 'react';
}

function uniqueTools(tools: readonly string[]): string[] {
  return [...new Set(tools.map(tool => tool.trim()).filter(Boolean))];
}
