import type {
  HadamardPermissionMode,
  HadamardRunEffort,
} from '../types.js';

/** Fields shared by saved Agents and loaded `.md` agent definitions. */
export interface AgentRunConfigurationSource {
  systemPrompt?: string;
  systemPromptAppend?: string;
  promptMode?: 'extend' | 'replace';
  permissionMode?: HadamardPermissionMode;
  effort?: HadamardRunEffort;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  allowedTools?: string[];
  workspaceAccess?: 'workspace' | 'full';
  maxIterations?: number;
  maxToolIterations?: number;
  timeoutMs?: number;
  subagent?: boolean;
}

export interface ResolveEffectiveAgentRunOptionsInput {
  /** Prompt supplied by the caller/surface before Agent instructions. */
  systemPrompt?: string;
  /** Surface fallback. The Agent value wins when one is configured. */
  fallbackPermissionMode?: HadamardPermissionMode;
  /** Explicit, visibly selected per-run override. This wins over the Agent. */
  permissionModeOverride?: HadamardPermissionMode;
  fallbackEffort?: HadamardRunEffort;
  effortOverride?: HadamardRunEffort;
}

export interface EffectiveAgentRunOptions {
  systemPrompt?: string;
  permissionMode?: HadamardPermissionMode;
  effort?: HadamardRunEffort;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  allowedTools?: string[];
  workspaceAccess: 'workspace' | 'full';
  maxToolIterations?: number;
  timeoutMs?: number;
  subagent: boolean;
}

/**
 * Resolve one Agent's persisted options into surface-independent runtime
 * values. `replace` discards the caller prompt; `extend` appends Agent
 * instructions after it. Agent permission/effort values beat surface
 * defaults, while an explicitly supplied per-run override remains highest.
 */
export function resolveEffectiveAgentRunOptions(
  source: AgentRunConfigurationSource | null | undefined,
  input: ResolveEffectiveAgentRunOptionsInput = {},
): EffectiveAgentRunOptions {
  const instructions = source?.systemPrompt ?? source?.systemPromptAppend;
  const systemPrompt = source?.promptMode === 'replace'
    ? cleanPrompt(instructions)
    : joinPromptParts(input.systemPrompt, instructions);
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(
      input.permissionModeOverride
        ? { permissionMode: input.permissionModeOverride }
        : source?.permissionMode
          ? { permissionMode: source.permissionMode }
          : input.fallbackPermissionMode
            ? { permissionMode: input.fallbackPermissionMode }
            : {}
    ),
    ...(
      input.effortOverride
        ? { effort: input.effortOverride }
        : source?.effort
          ? { effort: source.effort }
          : input.fallbackEffort
            ? { effort: input.fallbackEffort }
            : {}
    ),
    ...(typeof source?.maxTokens === 'number' ? { maxTokens: source.maxTokens } : {}),
    ...(typeof source?.temperature === 'number' ? { temperature: source.temperature } : {}),
    ...(typeof source?.topP === 'number' ? { topP: source.topP } : {}),
    ...(source?.allowedTools?.length ? { allowedTools: [...source.allowedTools] } : {}),
    workspaceAccess: source?.workspaceAccess ?? 'workspace',
    ...(
      typeof source?.maxToolIterations === 'number'
        ? { maxToolIterations: source.maxToolIterations }
        : typeof source?.maxIterations === 'number'
          ? { maxToolIterations: source.maxIterations }
          : {}
    ),
    ...(typeof source?.timeoutMs === 'number' ? { timeoutMs: source.timeoutMs } : {}),
    subagent: source?.subagent !== false,
  };
}

function cleanPrompt(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function joinPromptParts(...parts: Array<string | undefined>): string | undefined {
  const joined = parts.map(cleanPrompt).filter((part): part is string => Boolean(part)).join('\n\n');
  return joined || undefined;
}
