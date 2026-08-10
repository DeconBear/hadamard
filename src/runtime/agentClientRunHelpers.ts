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

export async function collectToolPrompts(
  tools: AgentToolDefinition[],
  context: { workDir: string; permissionMode?: HadamardPermissionMode },
): Promise<string[]> {
  const parts: string[] = [];
  const toolNames = tools.map(toolDefinition => toolDefinition.name);
  for (const toolDefinition of tools) {
    if (!toolDefinition.prompt) continue;
    try {
      const result = await toolDefinition.prompt({
        tools: toolNames,
        workDir: context.workDir,
        permissionMode: context.permissionMode,
      });
      if (result && result.trim().length > 0) parts.push(result.trim());
    } catch {
      // Optional tool prompt failures do not fail the run.
    }
  }
  return parts;
}
