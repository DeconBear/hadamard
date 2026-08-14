import { execFile as execFileCallback } from 'node:child_process';

import type {
  AgentToolDefinition,
  HadamardPermissionMode,
} from '../types.js';

export function joinPromptParts(...parts: Array<string | undefined>): string | undefined {
  const normalized = parts.filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  return normalized.length === 0 ? undefined : normalized.join('\n\n');
}

export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const available = signals.filter((signal): signal is AbortSignal => signal != null);
  if (available.length === 0) return undefined;
  if (available.length === 1) return available[0];
  return AbortSignal.any(available);
}

export function filterAgentTools(
  tools: AgentToolDefinition[],
  allowedTools?: string[],
  disallowedTools?: string[],
): AgentToolDefinition[] {
  const allowed = allowedTools?.length ? new Set(allowedTools) : undefined;
  const denied = new Set(disallowedTools ?? []);
  return tools.filter(toolDefinition => {
    const names = [toolDefinition.name, ...(toolDefinition.aliases ?? [])];
    if (names.some(name => denied.has(name))) return false;
    return !allowed || names.some(name => allowed.has(name));
  });
}

export function sanitizeWorkspaceName(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'agent';
}

export async function isGitWorkspaceDirty(workDir: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = execFileCallback(
          'git',
          ['-C', workDir, 'status', '--porcelain', '--untracked-files=all'],
          { windowsHide: true, signal: controller.signal },
        );
        child.on('error', reject);
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
        child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
        child.on('close', code => {
          if (code === 0) resolve({ stdout, stderr });
          else reject(new Error(`git status exited with code ${code}: ${stderr}`));
        });
      });
      return stdout.trim().length > 0;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return true;
  }
}

export function mergeUniqueByName<T extends { name: string }>(defaults: T[], overrides: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of defaults) merged.set(item.name, item);
  for (const item of overrides) merged.set(item.name, item);
  return [...merged.values()];
}

const COMPACT_SKILL_INDEX_MAX_CHARS = 6_000;
const COMPACT_SKILL_DESCRIPTION_MAX_CHARS = 96;

function compactOneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/** Build a bounded discovery index; full skill instructions stay lazy-loaded by Skill(). */
export function buildCompactSkillToolPrompt(
  skills: readonly { name: string; description?: string }[],
): string {
  if (skills.length === 0) return '';
  const header = [
    'Use Skill({ skill, args? }) when a listed skill matches the task.',
    'The call loads its full instructions on demand. Available skills:',
  ];
  const baseLines = skills.map(skill => `- ${skill.name}`);
  const fixedChars = header.join('\n').length + baseLines.join('\n').length + skills.length;
  const perDescriptionBudget = Math.max(
    0,
    Math.min(
      COMPACT_SKILL_DESCRIPTION_MAX_CHARS,
      Math.floor((COMPACT_SKILL_INDEX_MAX_CHARS - fixedChars) / skills.length) - 3,
    ),
  );
  const lines = skills.map((skill, index) => {
    const description = compactOneLine(skill.description ?? '');
    if (!description || perDescriptionBudget <= 0) return baseLines[index]!;
    const compact = description.length > perDescriptionBudget
      ? `${description.slice(0, Math.max(1, perDescriptionBudget - 1)).trimEnd()}…`
      : description;
    return `${baseLines[index]}: ${compact}`;
  });
  return [...header, ...lines].join('\n').slice(0, COMPACT_SKILL_INDEX_MAX_CHARS);
}

function normalizeToolPromptText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * Fold each tool's `prompt()` into `tools[].description` (Claude Code:
 * `description: await tool.prompt()`). Shared or identical prompt text is
 * left out so Bash-style duplicates and Glob+Grep's combined blob are not
 * copied into every tool. Callers must not also append these strings to the
 * system prompt.
 */
export async function applyResolvedToolDescriptions(
  tools: AgentToolDefinition[],
  context: { workDir: string; permissionMode?: HadamardPermissionMode },
): Promise<AgentToolDefinition[]> {
  const toolNames = tools.map(toolDefinition => toolDefinition.name);
  const resolved = await Promise.all(tools.map(async toolDefinition => {
    if (!toolDefinition.prompt) {
      return { toolDefinition, promptText: '' };
    }
    try {
      const result = await toolDefinition.prompt({
        tools: toolNames,
        workDir: context.workDir,
        permissionMode: context.permissionMode,
      });
      return { toolDefinition, promptText: result?.trim() ?? '' };
    } catch {
      return { toolDefinition, promptText: '' };
    }
  }));

  const promptCounts = new Map<string, number>();
  for (const { promptText } of resolved) {
    if (!promptText) continue;
    promptCounts.set(promptText, (promptCounts.get(promptText) ?? 0) + 1);
  }

  const emittedSharedPrompts = new Set<string>();
  return resolved.map(({ toolDefinition, promptText }) => {
    if (!promptText) return toolDefinition;
    const description = toolDefinition.description.trim();
    if (normalizeToolPromptText(promptText) === normalizeToolPromptText(description)) {
      return toolDefinition;
    }
    if ((promptCounts.get(promptText) ?? 0) > 1) {
      if (emittedSharedPrompts.has(promptText)) return toolDefinition;
      emittedSharedPrompts.add(promptText);
      return {
        ...toolDefinition,
        description: promptText.length > description.length
          ? promptText
          : `${description}\n\n${promptText}`,
      };
    }
    if (promptText.length <= description.length) {
      return toolDefinition;
    }
    return { ...toolDefinition, description: promptText };
  });
}
