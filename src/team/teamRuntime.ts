/**
 * Team runtime — centralized member execution for every team mode.
 *
 * All team modes (reviewer, panel-analysis) run their members through a single
 * path here, so identity, preflight, concurrency, streaming, token accounting,
 * status, and cleanup are handled in exactly one place instead of being
 * duplicated per mode.
 *
 * The concrete SDK client is supplied through the application runner port;
 * this module never imports the agentClient composition root.
 */
import type {
  AgentPoolSlot,
  AgentRunOptions,
  AgentToolDefinition,
  MemberStatus,
  TeamEvent,
  TeamMember,
} from '../types.js';
import { AgentPool } from './agentPool.js';
import type { EffectiveAgentRunOptions } from '../runtime/effectiveAgentRunOptions.js';
import type { AgentNodeMode } from '../runtime/agentExecutionPolicy.js';
import type { TeamAgentRunner, TeamAgentRunnerFactory } from '../application/teamAgentRunnerPort.js';
import { resolveTeamAgentRunnerFactory } from '../application/teamAgentRunnerRegistry.js';
import type { MemberIdentity } from './teamMemberIdentity.js';
export { buildMemberIdentities, type MemberIdentity } from './teamMemberIdentity.js';
export { TEAM_READ_ONLY_EXPERT_TOOL_NAMES } from './teamToolPolicy.js';
export { buildReadOnlyExpertTools } from './teamReadOnlyTools.js';

/** Resolve a `$ENV_VAR` apiKey reference; literal keys pass through unchanged. */
export function resolveApiKey(apiKey?: string): string | undefined {
  if (!apiKey) return undefined;
  if (apiKey.startsWith('$')) return process.env[apiKey.slice(1)];
  return apiKey;
}

/** Combine the caller's abort signal with a per-call timeout (if set). */
export function memberSignal(signal: AbortSignal | undefined, timeoutMs?: number): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return signal;
  const signals = [signal, AbortSignal.timeout(timeoutMs)].filter((s): s is AbortSignal => s != null);
  return AbortSignal.any(signals);
}

/** Run `fn` over `items` with at most `limit` in flight; preserves input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Default read-only tool names for graph agent nodes (matches buildReadOnlyExpertTools). */
/** Read-only tool set for expert/reviewer agents (no write/edit/bash/delegation). */
export interface PreflightResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate a member's configuration before running it. Conservative on purpose:
 * it flags only unambiguous misconfigurations (a `$ENV_VAR` apiKey whose variable
 * is unset, or a missing model) so members relying on global credentials still run.
 */
export function preflightMember(member: TeamMember): PreflightResult {
  if (!member.model || !member.model.trim()) {
    return { ok: false, error: 'no model configured' };
  }
  if (member.apiKey && member.apiKey.startsWith('$') && !process.env[member.apiKey.slice(1)]) {
    return { ok: false, error: `missing environment variable ${member.apiKey.slice(1)} for apiKey` };
  }
  return { ok: true };
}

export interface RunMemberOptions {
  identity: MemberIdentity;
  member: TeamMember;
  task: string;
  systemPrompt: string;
  cwd: string;
  tools: AgentToolDefinition[];
  maxIterations: number;
  timeoutMs?: number;
  /** @deprecated Whole-run retries are unsafe for side-effecting agents and are ignored. */
  reconnectAttempts?: number;
  signal?: AbortSignal;
  permissionMode?: AgentRunOptions['permissionMode'];
  permissions?: AgentRunOptions['permissions'];
  classifier?: AgentRunOptions['classifier'];
  approver?: AgentRunOptions['approver'];
  hooks?: AgentRunOptions['hooks'];
  /** Effective options from a saved Agent executor, when selected. */
  effectiveAgentOptions?: EffectiveAgentRunOptions;
  workspaceAccess?: 'workspace' | 'full';
  modelApi?: AgentRunOptions['modelApi'];
  /** Node override; otherwise the referenced Agent/member/project mode is inherited. */
  agentMode?: AgentNodeMode | 'inherit';
  /** Runtime-owned concurrency controller. Omit only for a standalone one-member call. */
  pool?: AgentPool;
  /** Optional factory override for tests and custom composition roots. */
  createRunner?: TeamAgentRunnerFactory;
  round: number;
  onEvent?: (event: TeamEvent) => void;
}

export interface MemberRunResult {
  report: string;
  status: MemberStatus;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The single member runner shared by all team modes. Handles, in one place:
 *  - preflight (skips clearly-misconfigured members with a structured status)
 *  - AgentPool slot acquire/release
 *  - SDK lifecycle (create → stream → close)
 *  - progress events (started / per tool.call / completed)
 *  - token accounting + tool-call counting
 *  - error capture into a structured MemberStatus (never throws)
 */
export async function runMemberAgent(opts: RunMemberOptions): Promise<MemberRunResult> {
  const {
    identity,
    member,
    task,
    systemPrompt,
    cwd,
    tools,
    maxIterations,
    timeoutMs,
    signal,
    round,
    onEvent,
  } = opts;
  const startedAt = Date.now();
  const base = { id: identity.id, model: identity.model, role: identity.role };

  const pre = preflightMember(member);
  if (!pre.ok) {
    const status: MemberStatus = { ...base, ok: false, skipped: true, error: pre.error, toolCalls: 0, durationMs: 0 };
    onEvent?.({ type: 'team.member.completed', ...base, round, ok: false, toolCalls: 0, durationMs: 0, error: pre.error });
    return { report: `[unavailable: ${identity.id} — ${pre.error}]`, status, inputTokens: 0, outputTokens: 0 };
  }

  onEvent?.({ type: 'team.member.started', ...base, round });

  const pool = opts.pool ?? new AgentPool(1);
  let slot: AgentPoolSlot | undefined;
  let sdk: TeamAgentRunner | undefined;

  try {
    slot = await pool.acquire(timeoutMs);
    const effective = opts.effectiveAgentOptions;
    const createRunner = opts.createRunner ?? await resolveTeamAgentRunnerFactory();
    sdk = await createRunner({
      model: member.model,
      modelApi: opts.modelApi,
      provider: member.provider,
      baseURL: member.baseURL,
      authToken: resolveApiKey(member.apiKey),
      maxTokens: effective?.maxTokens ?? member.maxTokens ?? 32000,
      workDir: cwd,
      tools,
      permissionMode: effective?.permissionMode ?? opts.permissionMode ?? 'default',
      permissions: opts.permissions,
      classifier: opts.classifier,
      approver: opts.approver,
      hooks: opts.hooks,
      maxToolIterations: effective?.maxToolIterations ?? maxIterations,
      systemPrompt: effective?.systemPrompt ?? systemPrompt,
    });
    const stream = sdk.stream(task, {
      signal: memberSignal(signal, timeoutMs),
      agentMode: opts.agentMode ?? effective?.agentMode ?? member.agentMode ?? 'inherit',
      ...(opts.agentMode === 'single' ? { inheritDefaultTools: false } : {}),
      ...(effective?.permissionMode ? { permissionMode: effective.permissionMode } : {}),
      ...(effective?.effort ? { effort: effective.effort } : {}),
      ...(typeof effective?.maxTokens === 'number' ? { maxTokens: effective.maxTokens } : {}),
      ...(typeof effective?.temperature === 'number' ? { temperature: effective.temperature } : {}),
      ...(typeof effective?.topP === 'number' ? { topP: effective.topP } : {}),
      ...(effective?.allowedTools ? { allowedTools: effective.allowedTools } : {}),
      ...(
        effective
          ? { workspaceAccess: effective.workspaceAccess }
          : opts.workspaceAccess
            ? { workspaceAccess: opts.workspaceAccess }
            : {}
      ),
      ...(typeof effective?.maxToolIterations === 'number'
        ? { maxToolIterations: effective.maxToolIterations }
        : {}),
    });
    for await (const event of stream) {
      if (event.type === 'tool.call' && onEvent) {
        onEvent({ type: 'team.member.tool', id: identity.id, model: identity.model, round, tool: event.call.publicName });
      }
    }
    const result = await stream.result;
    const inputTokens = result.usage?.input_tokens ?? 0;
    const outputTokens = result.usage?.output_tokens ?? 0;
    const toolCalls = result.toolCalls.length;
    const durationMs = Date.now() - startedAt;
    const status: MemberStatus = { ...base, ok: true, toolCalls, durationMs };
    onEvent?.({ type: 'team.member.completed', ...base, round, ok: true, toolCalls, durationMs });
    return { report: result.text, status, inputTokens, outputTokens };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startedAt;
    const status: MemberStatus = { ...base, ok: false, error: message, toolCalls: 0, durationMs };
    onEvent?.({ type: 'team.member.completed', ...base, round, ok: false, toolCalls: 0, durationMs, error: message });
    return { report: `[ERROR: ${identity.id} (${identity.model}) failed — ${message}]`, status, inputTokens: 0, outputTokens: 0 };
  } finally {
    if (sdk) await sdk.close();
    slot?.release();
  }
}
