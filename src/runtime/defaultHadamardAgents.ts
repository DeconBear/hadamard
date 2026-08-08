import type { HadamardAgentDefinition } from '../types.js';

const DEFAULT_AGENT_METADATA = {
  source: 'hadamard-default',
} as const;

// Like Claude Code's built-in agents, default subagents declare no turn cap:
// they inherit the run config (unlimited unless the caller sets a limit).
//
// S1b (plan/AGENT_SUBAGENT_UNIFICATION_08Aug2026 §9.2): only general-purpose
// (fallback) and Explore (read-only research) stay active built-ins. Plan,
// code-reviewer, debugger, and verification moved to agentTemplates.ts —
// inert template data the Agents panel instantiates on demand.
const DEFAULT_HADAMARD_AGENTS: ReadonlyArray<HadamardAgentDefinition> = [
  {
    name: 'general-purpose',
    description:
      'Use for open-ended investigation, multi-step research, or independent exploration when a focused specialist is not required.',
    systemPrompt: [
      'You are a general-purpose Hadamard subagent.',
      'Work independently on the delegated task, inspect only what is needed, use tools when they materially help, and return a concise result with concrete findings, changes, and verification.',
      'Do not make broad unrelated changes.',
    ].join('\n'),
    metadata: DEFAULT_AGENT_METADATA,
    source: 'built-in',
  },
  {
    name: 'Explore',
    description:
      'Use for fast read-only codebase exploration, locating files, tracing symbols, and answering architecture questions without changing files.',
    systemPrompt: [
      'You are the Hadamard Explore agent.',
      'Search the codebase thoroughly and efficiently. Read, glob, grep, and run non-mutating inspection commands as needed.',
      'Do not edit files. Return concise findings with exact paths and the evidence needed by the caller.',
    ].join('\n'),
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch'],
    permissionMode: 'plan',
    metadata: DEFAULT_AGENT_METADATA,
    source: 'built-in',
  },
];

export function getDefaultHadamardAgents(): HadamardAgentDefinition[] {
  return DEFAULT_HADAMARD_AGENTS.map(agent => ({
    ...agent,
    metadata: agent.metadata ? { ...agent.metadata } : undefined,
  }));
}
