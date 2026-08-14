import type { AgentExecutionPolicy } from '../runtime/agentExecutionPolicy.js';
import type { AgentToolDefinition } from '../types.js';
import { CODE_CELL_TOOL_NAME } from './codeCellTool.js';

export interface AgentModePromptCapabilities {
  hostCapabilities?: readonly string[];
}

export function buildAgentModePrompt(
  policy: AgentExecutionPolicy,
  capabilities: AgentModePromptCapabilities = {},
): string {
  if (policy.turnPolicy === 'single') {
    if (policy.actionSpace === 'none') {
      return 'Answer this node once and finish directly. No tools are available.';
    }
    return [
      'This is a bounded single-tool node.',
      `You may call at most one ordinary tool: ${policy.ordinaryTools[0]}.`,
      'After that result, produce the final answer immediately. Do not start another tool call.',
    ].join('\n');
  }
  if (policy.actionSpace === 'code-cell') {
    return codeCellInstructions(capabilities);
  }
  if (policy.actionSpace === 'hybrid') {
    return [
      'You have two action planes.',
      'Use ordinary JSON tools for deterministic metadata, permission-sensitive filesystem actions, external services, and one-step host operations.',
      'Use CodeCell for loops, data transformations, mathematical work, experiments, and multi-step computation.',
      'Prefer ordinary structured calls before CodeCell when both would mutate the same state in one action group.',
      codeCellInstructions(capabilities),
    ].join('\n\n');
  }
  return '';
}

export function filterToolsForExecutionPolicy(
  tools: readonly AgentToolDefinition[],
  policy: AgentExecutionPolicy,
): AgentToolDefinition[] {
  const ordinaryNames = new Set(policy.ordinaryTools);
  const codeCell = tools.filter(tool => tool.name === CODE_CELL_TOOL_NAME);
  if (policy.actionSpace === 'none') return [];
  if (policy.actionSpace === 'code-cell') return codeCell;
  const ordinary = tools.filter(tool => tool.name !== CODE_CELL_TOOL_NAME && ordinaryNames.has(tool.name));
  return policy.actionSpace === 'hybrid' ? [...ordinary, ...codeCell] : ordinary;
}

function codeCellInstructions(capabilities: AgentModePromptCapabilities): string {
  const host = capabilities.hostCapabilities?.length
    ? `Allowed host RPC capabilities: ${capabilities.hostCapabilities.join(', ')}.`
    : 'Host RPC capabilities are explicit and may be unavailable; never assume direct access to provider credentials.';
  return [
    'Use CodeCell with language="python" and executable Python source.',
    'The namespace persists for this session until a restart, crash, interrupt, or idle cleanup changes the generation.',
    'Inspect stdout, stderr, the structured final-expression result, artifact references, and stateLost after every cell.',
    host,
    'Keep cells auditable and bounded. Finish only when the requested observable result is verified.',
  ].join('\n');
}
