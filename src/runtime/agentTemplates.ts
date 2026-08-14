/**
 * Agent templates (S1b, plan/AGENT_SUBAGENT_UNIFICATION_08Aug2026 §9.2).
 *
 * The four former built-in agents — Plan, code-reviewer, debugger,
 * verification — are inert template data: they are NOT loaded into the
 * runtime. The Agents panel's "Add from template" action (S2) serializes a
 * template to `~/.hadamard/agents/<name>.md` (or the project agents dir);
 * from then on it is a normal, editable user agent.
 *
 * Rationale (§9.2, from the Claude Code v2.1.88 source survey): reviewer/
 * debugger/verification are workflow preferences rather than universal
 * capabilities, and plan mode itself is the plan agent — so only
 * general-purpose and Explore stay unconditionally active.
 */
import type { HadamardAgentDefinition, HadamardPermissionMode } from '../types.js';

export interface HadamardAgentTemplate {
  name: string;
  description: string;
  /** Extra frontmatter keys (beyond name/description) for the generated .md. */
  frontmatter: Record<string, string | number | boolean | string[]>;
  /** Markdown body = the agent's prompt. */
  body: string;
}

const READ_ONLY_RESEARCH_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch'];

const HADAMARD_AGENT_TEMPLATES: ReadonlyArray<HadamardAgentTemplate> = [
  {
    name: 'Plan',
    description:
      'Use for implementation planning after exploration when the task spans multiple modules or has meaningful design tradeoffs.',
    frontmatter: {
      permissionMode: 'plan',
      tools: READ_ONLY_RESEARCH_TOOLS,
      projectInstructions: 'omit',
    },
    body: [
      'You are the Hadamard Plan agent.',
      'Inspect the relevant implementation and produce a concrete, ordered engineering plan.',
      'Do not edit files. Identify contracts, risks, tests, and verification commands; avoid speculative scope.',
    ].join('\n'),
  },
  {
    name: 'code-reviewer',
    description:
      'Use proactively after completing significant code changes, and for focused risk review, regression analysis, missing tests, and maintainability issues.',
    frontmatter: {},
    body: [
      'You are a focused code-review subagent.',
      'Prioritize correctness bugs, regressions, missing tests, unsafe behavior, and unclear contracts. Ground findings in specific files or commands when possible.',
      'Keep the review concise and actionable.',
    ].join('\n'),
  },
  {
    name: 'debugger',
    description:
      'Use proactively for failing tests, logs, runtime errors, and root-cause analysis before proposing or applying a fix.',
    frontmatter: {},
    body: [
      'You are a focused debugging subagent.',
      'Trace failures from observable evidence, inspect relevant files and logs, identify the likely root cause, and report the smallest safe fix path with verification.',
      'Avoid speculative rewrites.',
    ].join('\n'),
  },
  {
    name: 'verification',
    description:
      'Use proactively after implementation to run independent verification, probe edge cases, and try to disprove that the change is complete.',
    frontmatter: {},
    body: [
      'You are an independent verification specialist.',
      'Run the relevant checks and inspect observable behavior. Do not accept code reading or a green unit test alone as proof.',
      'Look for missing integration coverage, broken edge cases, unsafe behavior, and claims unsupported by command output.',
      'Report PASS or FAIL for each check with concrete evidence.',
    ].join('\n'),
  },
];

export function getHadamardAgentTemplates(): HadamardAgentTemplate[] {
  return HADAMARD_AGENT_TEMPLATES.map(template => ({
    ...template,
    frontmatter: { ...template.frontmatter },
  }));
}

export function getHadamardAgentTemplate(name: string): HadamardAgentTemplate | undefined {
  return HADAMARD_AGENT_TEMPLATES.find(template => template.name === name);
}

/** Materialize a template as a runnable in-memory definition (tests, preview). */
export function hadamardAgentTemplateToDefinition(
  template: HadamardAgentTemplate,
): HadamardAgentDefinition {
  const permissionMode = template.frontmatter.permissionMode;
  const tools = template.frontmatter.tools;
  const projectInstructions = template.frontmatter.projectInstructions;
  return {
    name: template.name,
    description: template.description,
    systemPrompt: template.body,
    ...(typeof permissionMode === 'string'
      ? { permissionMode: permissionMode as HadamardPermissionMode }
      : {}),
    ...(Array.isArray(tools) ? { allowedTools: tools.map(String) } : {}),
    ...(projectInstructions === 'inherit' || projectInstructions === 'omit'
      ? { projectInstructions }
      : {}),
    metadata: { source: 'template' },
    source: 'custom',
  };
}
