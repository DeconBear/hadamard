/**
 * S1b (plan/AGENT_SUBAGENT_UNIFICATION_08Aug2026 §9.2/§9.5):
 * - built-in agents shrink to exactly { general-purpose, Explore }; the other
 *   four live on as inert templates in agentTemplates.ts;
 * - the Agent/Task tool classifies per delegation target, so plan mode may
 *   delegate to read-only subagents (Explore) while write-capable or unknown
 *   targets stay blocked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDefaultHadamardAgents } from '../src/runtime/defaultHadamardAgents.js';
import {
  getHadamardAgentTemplate,
  getHadamardAgentTemplates,
  hadamardAgentTemplateToDefinition,
} from '../src/runtime/agentTemplates.js';
import { createHadamardTaskTool } from '../src/runtime/hadamardAgents.js';
import { decideHadamardToolPermission } from '../src/runtime/hadamardPermissions.js';
import { createHadamardCoreTools } from '../src/tools/hadamardCoreTools.js';
import { serializeAgentDefinitionMarkdown } from '../src/config/agentDefinitionMigration.js';
import { parseAgentDefinitionMarkdown } from '../src/runtime/hadamardAgentDefinitions.js';
import type {
  AgentToolDefinition,
  HadamardAgentDefinition,
  HadamardTaskToolInput,
} from '../src/types.js';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 's1b-plan-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('built-in agent set (S1b §9.2)', () => {
  it('keeps exactly general-purpose and Explore as active built-ins', () => {
    expect(getDefaultHadamardAgents().map(agent => agent.name)).toEqual(['general-purpose', 'Explore']);
  });

  it('templates carry the four removed agents with complete fields', () => {
    const templates = getHadamardAgentTemplates();
    expect(templates.map(template => template.name).sort())
      .toEqual(['Plan', 'code-reviewer', 'debugger', 'verification']);
    for (const template of templates) {
      expect(template.description.trim().length).toBeGreaterThan(0);
      expect(template.body.trim().length).toBeGreaterThan(0);
    }
    const plan = getHadamardAgentTemplate('Plan')!;
    expect(plan.frontmatter.permissionMode).toBe('plan');
    expect(plan.frontmatter.tools).toEqual(
      expect.arrayContaining(['Read', 'Glob', 'Grep', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch']),
    );
  });

  it('template definitions round-trip through the .md format', () => {
    const template = getHadamardAgentTemplate('Plan')!;
    const markdown = serializeAgentDefinitionMarkdown(
      { name: template.name, description: template.description, ...template.frontmatter },
      template.body,
    );
    const definition = parseAgentDefinitionMarkdown({
      filePath: '/virtual/Plan.md',
      fallbackName: 'Plan',
      source: 'user',
      content: markdown,
    });
    expect(definition?.name).toBe('Plan');
    expect(definition?.permissionMode).toBe('plan');
    expect(definition?.allowedTools).toEqual(template.frontmatter.tools);
    expect(definition?.systemPrompt).toBe(template.body);
  });
});

// ── plan-mode delegation (§9.5) ───────────────────────────────────────

function buildTaskTool(definitions: HadamardAgentDefinition[]): AgentToolDefinition {
  return createHadamardTaskTool({
    getAgentDefinition: name => definitions.find(definition => definition.name === name),
    listAvailableTools: () => createHadamardCoreTools({ cwd: workDir }),
    runAgent: async () => {
      throw new Error('not executed in permission tests');
    },
    launchBackgroundAgent: async () => {
      throw new Error('not executed in permission tests');
    },
  });
}

async function decidePlanMode(
  toolDefinition: AgentToolDefinition,
  toolInput: unknown,
  publicName = 'Agent',
) {
  return decideHadamardToolPermission({
    mode: 'plan',
    rules: [],
    runId: 'run-1',
    workDir,
    toolName: publicName,
    publicName,
    prompt: '',
    toolInput,
    iteration: 0,
    adapter: {
      isReadOnly: toolDefinition.isReadOnly as ((input?: unknown) => boolean) | undefined,
      isDestructive: toolDefinition.isDestructive as ((input?: unknown) => boolean) | undefined,
      isPlanReadOnly: toolDefinition.isPlanReadOnly as ((input?: unknown) => boolean) | undefined,
    },
  });
}

describe('plan-mode delegation (S1b §9.5)', () => {
  const builtins = getDefaultHadamardAgents();
  const writer: HadamardAgentDefinition = {
    name: 'writer',
    description: 'Write-capable agent',
    allowedTools: ['Read', 'Write'],
  };
  const unrestricted: HadamardAgentDefinition = {
    name: 'unrestricted',
    description: 'No whitelist = full toolset',
  };
  const definitions = [...builtins, writer, unrestricted];
  const taskTool = buildTaskTool(definitions);

  it('allows delegating to read-only Explore (whitelist incl. command-classified shells)', () => {
    const input: HadamardTaskToolInput = { subagent_type: 'Explore', prompt: 'survey the repo' };
    expect(taskTool.isPlanReadOnly?.(input)).toBe(true);
  });

  it('plan mode allows the Explore delegation at the permission layer', async () => {
    const decision = await decidePlanMode(taskTool, { subagent_type: 'Explore', prompt: 'survey' });
    expect(decision.behavior).toBe('allow');
  });

  it('plan mode denies delegating to a write-capable definition', async () => {
    const decision = await decidePlanMode(taskTool, { subagent_type: 'writer', prompt: 'edit files' });
    expect(decision.behavior).toBe('deny');
    expect(decision.reason).toMatch(/plan mode/i);
  });

  it('plan mode denies delegating to a definition without a tool whitelist', async () => {
    const decision = await decidePlanMode(taskTool, { subagent_type: 'unrestricted', prompt: 'x' });
    expect(decision.behavior).toBe('deny');
  });

  it('plan mode denies delegating to an unknown target', async () => {
    const decision = await decidePlanMode(taskTool, { subagent_type: 'ghost', prompt: 'x' });
    expect(decision.behavior).toBe('deny');
  });

  it('plan mode denies an implicit delegation (general-purpose fallback is full-toolset)', async () => {
    const decision = await decidePlanMode(taskTool, { prompt: 'no explicit target' });
    expect(decision.behavior).toBe('deny');
  });

  it('regression: plan mode still denies direct mutating tools and allows read-only Bash', async () => {
    const coreTools = createHadamardCoreTools({ cwd: workDir });
    const write = coreTools.find(tool => tool.name === 'Write')!;
    const bash = coreTools.find(tool => tool.name === 'Bash')!;
    const writeDecision = await decidePlanMode(write, { file_path: 'a.ts', content: 'x' }, 'Write');
    expect(writeDecision.behavior).toBe('deny');
    const bashReadDecision = await decidePlanMode(bash, { command: 'git status' }, 'Bash');
    expect(bashReadDecision.behavior).toBe('allow');
    const bashWriteDecision = await decidePlanMode(bash, { command: 'rm -rf build' }, 'Bash');
    expect(bashWriteDecision.behavior).toBe('deny');
  });

  it('template-instantiated Plan stays delegatable in plan mode (read-only whitelist)', () => {
    const planDefinition = hadamardAgentTemplateToDefinition(getHadamardAgentTemplate('Plan')!);
    const tool = buildTaskTool([...definitions, planDefinition]);
    expect(tool.isPlanReadOnly?.({ subagent_type: 'Plan', prompt: 'draft a plan' })).toBe(true);
  });
});
