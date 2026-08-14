import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import type {
  AgentToolDefinition,
  HadamardSkillDefinition,
} from '../types.js';

interface ActionDispatcherInput {
  action: string;
  args?: Record<string, unknown>;
}

interface ManagedActionDispatcherOptions {
  name: string;
  description: string;
  sourcePrefix: string;
  sourceTools: AgentToolDefinition[];
}

/**
 * Keep the existing atomic implementations as the execution/validation
 * source of truth while exposing only one compact schema to the model.
 */
export function createManagedActionDispatcher(
  options: ManagedActionDispatcherOptions,
): AgentToolDefinition<ActionDispatcherInput, unknown> {
  const actions = new Map<string, AgentToolDefinition>();
  for (const sourceTool of options.sourceTools) {
    const action = sourceTool.name.startsWith(options.sourcePrefix)
      ? sourceTool.name.slice(options.sourcePrefix.length)
      : sourceTool.name;
    if (!action || actions.has(action)) {
      throw new Error(`Managed action dispatcher has a duplicate or empty action: ${action}`);
    }
    actions.set(action, sourceTool);
  }

  const resolve = (input?: ActionDispatcherInput) => {
    if (!input?.action) return undefined;
    const sourceTool = actions.get(input.action);
    if (!sourceTool) return undefined;
    const parsed = sourceTool.inputSchema.safeParse(input.args ?? {});
    return parsed.success ? { sourceTool, input: parsed.data } : undefined;
  };

  return tool(
    {
      name: options.name,
      description: options.description,
      inputSchema: z.strictObject({
        action: z.string().min(1),
        args: z.record(z.string(), z.unknown()).optional(),
      }),
      isReadOnly: input => {
        const resolved = resolve(input);
        return resolved?.sourceTool.isReadOnly?.(resolved.input) === true;
      },
      isDestructive: input => {
        const resolved = resolve(input);
        if (!resolved) return true;
        if (resolved.sourceTool.isDestructive) {
          return resolved.sourceTool.isDestructive(resolved.input);
        }
        return resolved.sourceTool.isReadOnly?.(resolved.input) !== true;
      },
      requiresUserInteraction: () =>
        options.sourceTools.some(sourceTool => sourceTool.requiresUserInteraction?.() === true),
      interruptBehavior: options.sourceTools.some(toolDefinition =>
        toolDefinition.interruptBehavior === 'cancel')
        ? 'cancel'
        : 'block',
    },
    async ({ action, args }, context, onProgress) => {
      const sourceTool = actions.get(action);
      if (!sourceTool) {
        throw new TypeError(
          `Unknown ${options.name} action "${action}". Load the matching Skill for supported actions.`,
        );
      }
      const parsed = await sourceTool.inputSchema.safeParseAsync(args ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map(issue => `${issue.path.join('.') || 'args'}: ${issue.message}`)
          .join('; ');
        throw new TypeError(`Invalid args for ${options.name} action "${action}": ${detail}`);
      }
      const output = await sourceTool.execute(
        parsed.data,
        context,
        onProgress,
      );
      if (sourceTool.outputSchema) {
        await sourceTool.outputSchema.parseAsync(output);
      }
      return output;
    },
  );
}

export function createManagedActionSkill(options: {
  name: string;
  description: string;
  whenToUse: string;
  dispatcherName: string;
  sourcePrefix: string;
  sourceTools: AgentToolDefinition[];
  guidance?: string[];
}): HadamardSkillDefinition {
  const actions = options.sourceTools.map(sourceTool => {
    const action = sourceTool.name.startsWith(options.sourcePrefix)
      ? sourceTool.name.slice(options.sourcePrefix.length)
      : sourceTool.name;
    return [
      `### ${action}`,
      sourceTool.description,
      `Arguments JSON Schema: ${JSON.stringify(sourceTool.inputJsonSchema)}`,
    ].join('\n');
  });
  return {
    name: options.name,
    description: options.description,
    whenToUse: options.whenToUse,
    prompt: [
      `Use the \`${options.dispatcherName}\` tool for this capability.`,
      `Call it as \`{"action":"<action>","args":{...}}\`.`,
      'Use only the actions and arguments documented below; validation happens at execution time.',
      ...(options.guidance ?? []),
      '',
      '## Actions',
      '',
      ...actions.flatMap(action => [action, '']),
    ].join('\n').trim(),
    source: 'custom',
    loadedFrom: 'custom',
  };
}

export function createGitHubCliSkill(options: {
  hostname?: string;
  defaultOwner?: string;
} = {}): HadamardSkillDefinition {
  const hostname = options.hostname?.trim() || 'github.com';
  const defaultOwner = options.defaultOwner?.trim();
  return {
    name: 'github',
    description:
      'Use the authenticated gh CLI for GitHub repositories, pull requests, issues, checks, releases, and API calls.',
    whenToUse:
      'Use for GitHub work. This capability intentionally registers no separate GitHub tool schemas.',
    prompt: [
      'Use the existing Bash or PowerShell tool to run the GitHub CLI (`gh`).',
      `Configured GitHub host: ${hostname}.`,
      ...(defaultOwner ? [`Configured default owner: ${defaultOwner}.`] : []),
      '',
      'Protocol:',
      '1. Check availability/authentication with `gh --version` and `gh auth status --hostname <host>` when needed.',
      '2. In a repository, let gh infer the repository. Outside one, pass `--repo HOST/OWNER/REPO` explicitly.',
      '3. Prefer native `gh repo`, `gh pr`, `gh issue`, `gh run`, and `gh release` commands.',
      '4. Prefer `--json` and `--jq` for stable structured output.',
      '5. Use `gh api` only when a native command is insufficient. GET is read-only; POST, PATCH, PUT, and DELETE mutate remote state.',
      '6. Do not put credentials in commands or output. Authentication is owned by `gh auth login`/the host environment.',
      '7. Treat create, edit, merge, close, upload, and delete operations as remote mutations and rely on normal shell approval policy.',
    ].join('\n'),
    source: 'custom',
    loadedFrom: 'custom',
  };
}
