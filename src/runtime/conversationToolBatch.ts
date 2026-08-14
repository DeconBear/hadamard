import type { MessageParam, ToolResultBlockParam, ToolUseBlock } from '../provider/types.js';
import type { AgentToolCallEventPayload, AgentToolCallRecord } from '../types.js';
import { isRecord, nowIso } from './helpers.js';
import {
  formatHadamardTodoListLines,
  getHadamardTodoSnapshot,
} from '../tools/todo/TodoWriteTool.js';

export interface ToolUseBatch {
  concurrent: boolean;
  toolUses: ToolUseBlock[];
}

/**
 * Partition tool calls into batches: consecutive concurrency-safe tools are
 * grouped for parallel execution, everything else runs as a serial batch of
 * one. Mirrors Claude Code's read-only batching behavior.
 */
export function partitionToolUsesForConcurrency(
  toolUses: ToolUseBlock[],
  toolMap: Map<string, { isReadOnly?: (input?: unknown) => boolean; isConcurrencySafe?: () => boolean; requiresUserInteraction?: () => boolean }>,
): ToolUseBatch[] {
  const batches: ToolUseBatch[] = [];
  for (const toolUse of toolUses) {
    const adapter = toolMap.get(toolUse.name);
    let safe = false;
    if (adapter && adapter.requiresUserInteraction?.() !== true) {
      try {
        safe = adapter.isConcurrencySafe?.() ?? adapter.isReadOnly?.(toolUse.input) ?? false;
      } catch {
        safe = false;
      }
    }
    const last = batches.at(-1);
    if (safe && last?.concurrent) {
      last.toolUses.push(toolUse);
    } else {
      batches.push({ concurrent: safe, toolUses: [toolUse] });
    }
  }
  return batches;
}

export async function runSequentially<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) {
    results.push(await run(item));
  }
  return results;
}

export interface ToolUseConcurrencyToolMap {
  isReadOnly?: (input?: unknown) => boolean;
  isConcurrencySafe?: () => boolean;
  requiresUserInteraction?: () => boolean;
}

/**
 * Fail-closed concurrency classification shared by the scheduling contract:
 * only an exact \`true\` from \`isConcurrencySafe\` (else a \`true\` read-only
 * verdict) opts a call into parallelism; a throwing classifier, an
 * interactive tool, or a non-true verdict is exclusive.
 */
export function isToolUseConcurrencySafe(
  toolUse: ToolUseBlock,
  toolMap: Map<string, ToolUseConcurrencyToolMap>,
): boolean {
  const adapter = toolMap.get(toolUse.name);
  if (!adapter || adapter.requiresUserInteraction?.() === true) {
    return false;
  }
  try {
    const concurrencySafe = adapter.isConcurrencySafe?.();
    if (concurrencySafe !== undefined) {
      return concurrencySafe === true;
    }
    return adapter.isReadOnly?.(toolUse.input) === true;
  } catch {
    return false;
  }
}

export interface ToolUseSchedulerOutcome<T> {
  /** Per-index results in model order; undefined means the call was never started. */
  results: (T | undefined)[];
  /** True when the abort signal fired or an unexpected run rejection stopped new starts. */
  aborted: boolean;
}

export interface ToolUseSchedulerOptions {
  /** Upper bound for in-flight parallel-classified calls. */
  maxParallel: number;
  /** Abort signal; stops new starts and drains started calls to quiescence. */
  signal?: AbortSignal;
}

/**
 * Execute model-ordered tool calls under the dsh-style scheduling contract:
 *
 * - classification is re-read lazily right before each start (fail-closed:
 *   a throwing classifier or a non-true result is exclusive);
 * - parallel-classified calls overlap in a bounded rolling pool
 *   (`maxParallel`);
 * - an exclusive call waits for the pool to drain, runs alone, and holds its
 *   barrier through completion (the whole per-call path, including
 *   post-execute hooks — mirroring dsh's exclusive-group commit barrier);
 * - results land in model order regardless of completion order;
 * - on abort (or an unexpected `run` rejection) new starts stop, started
 *   calls drain to quiescence, and skipped calls stay `undefined` so the
 *   caller can record synthetic results and keep persisted sessions
 *   replay-valid (dsh's TOOL_ABORTED_BEFORE_DISPATCH semantics).
 *
 * `run` is expected to resolve with the per-call outcome (the engine's
 * executor normalizes every tool error into an error result). An unexpected
 * rejection is a terminal scheduler failure: started calls drain, then the
 * first failure rethrows without fabricating results.
 */
export async function executeToolUsesWithContract<T>(
  toolUses: readonly ToolUseBlock[],
  classify: (toolUse: ToolUseBlock, index: number) => boolean,
  run: (toolUse: ToolUseBlock, index: number) => Promise<T>,
  options: ToolUseSchedulerOptions,
): Promise<ToolUseSchedulerOutcome<T>> {
  const results: (T | undefined)[] = new Array<T | undefined>(toolUses.length).fill(undefined);
  const inFlight = new Set<Promise<void>>();
  const maxParallel = Math.max(1, Math.trunc(options.maxParallel) || 1);
  let nextToStart = 0;
  // Function read so control-flow narrowing never masks an abort that fires
  // across an await boundary.
  const isAborted = (): boolean => options.signal?.aborted === true;
  let aborted = isAborted();
  let failure: { index: number; error: unknown } | undefined;

  const start = (index: number): void => {
    const toolUse = toolUses[index]!;
    const promise = Promise.resolve()
      .then(() => run(toolUse, index))
      .then(
        (value) => { results[index] = value; },
        (error) => { failure ??= { index, error }; },
      )
      .finally(() => { inFlight.delete(promise); });
    inFlight.add(promise);
  };

  const drain = async (): Promise<void> => {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  };

  while (nextToStart < toolUses.length) {
    if (failure !== undefined || isAborted()) {
      aborted = true;
      break;
    }
    const index = nextToStart;
    const toolUse = toolUses[index]!;
    // Lazy fail-closed reclassification immediately before start: a registry
    // change while queued can flip a later call exclusive, and a throwing
    // classifier degrades to exclusive (dsh executionMode semantics).
    let safe = false;
    try {
      safe = classify(toolUse, index);
    } catch {
      safe = false;
    }
    if (!safe) {
      // Exclusive barrier: wait for the parallel pool to drain, then run
      // alone and hold the barrier through completion.
      await drain();
      if (failure !== undefined || isAborted()) {
        aborted = true;
        break;
      }
      nextToStart += 1;
      try {
        results[index] = await run(toolUse, index);
      } catch (error) {
        failure ??= { index, error };
        aborted = true;
        break;
      }
      continue;
    }
    if (inFlight.size >= maxParallel) {
      await Promise.race([...inFlight]);
      continue;
    }
    nextToStart += 1;
    start(index);
  }

  if (failure !== undefined) {
    // Terminal scheduler failure: drain every started dispatch, then surface
    // the first failure without fabricating results.
    await drain();
    aborted = true;
    throw failure.error;
  }
  await drain();
  if (isAborted()) {
    aborted = true;
  }
  return { results, aborted };
}

const UNPAIRED_TOOL_USE_REPAIR_TEXT = [
  'The previous run was interrupted before this tool call completed, and its',
  'outcome is unknown. If the action is read-only or idempotent, retry it;',
  'otherwise inspect the current state first to avoid duplicating work.',
].join(' ');

/**
 * Cold-resume repair (dsh repair.ts equivalent at message scope): close every
 * unpaired tool_use in the persisted history with a synthetic error result so
 * providers never reject the session on resume.
 */
export function buildUnpairedToolUseRepair(messages: readonly MessageParam[]): MessageParam | undefined {
  const toolResultIds = new Set<string>();
  const toolUseBlocks: ToolUseBlock[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        toolUseBlocks.push(block as unknown as ToolUseBlock);
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }
  const dangling = toolUseBlocks.filter(block => !toolResultIds.has(block.id));
  if (dangling.length === 0) return undefined;
  return {
    role: 'user',
    content: dangling.map(block => ({
      type: 'tool_result' as const,
      tool_use_id: block.id,
      is_error: true,
      content: UNPAIRED_TOOL_USE_REPAIR_TEXT,
    })),
  };
}

/** Synthetic call/result pair for a model call skipped by abort before dispatch. */
export function buildAbortedBeforeDispatchResult(
  toolUse: ToolUseBlock,
  now: string = nowIso(),
): { callPayload: AgentToolCallEventPayload; record: AgentToolCallRecord; resultBlock: ToolResultBlockParam } {
  const message = 'Error: tool call aborted before dispatch';
  const callPayload: AgentToolCallEventPayload = {
    id: toolUse.id,
    name: toolUse.name,
    publicName: toolUse.name,
    provider: 'local',
    input: structuredClone(toolUse.input),
    startedAt: now,
  };
  const record: AgentToolCallRecord = {
    ...callPayload,
    outputText: message,
    output: { error: message },
    isError: true,
    completedAt: now,
    durationMs: 0,
    abortedBeforeDispatch: true,
  };
  return {
    callPayload,
    record,
    resultBlock: {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: message,
      is_error: true,
    },
  };
}

export async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export function appendTextToToolResultContent(block: ToolResultBlockParam, text: string): void {
  if (block.content === undefined || block.content === null) {
    block.content = text;
    return;
  }
  if (typeof block.content === 'string') {
    block.content = `${block.content}\n\n${text}`;
    return;
  }
  if (Array.isArray(block.content)) {
    block.content.push({ type: 'text', text });
  }
}

export function isLikelyTruncatedToolUse(toolUse: ToolUseBlock): boolean {
  const input = toolUse.input;
  return (
    input !== null &&
    typeof input === 'object' &&
    Object.keys(input).length === 1 &&
    typeof (input as { raw?: unknown }).raw === 'string'
  );
}

export function buildTodoReminderText(todos: ReturnType<typeof getHadamardTodoSnapshot>): string {
  if (todos.length === 0) {
    return [
      '<system-reminder>',
      'The TodoWrite tool has not been used recently. If you are working on a multi-step task, use TodoWrite to track progress and keep exactly one item in_progress.',
      'Do not mention this reminder to the user.',
      '</system-reminder>',
    ].join('\n');
  }
  return [
    '<system-reminder>',
    'Current todo list state (re-injected for continuity):',
    formatHadamardTodoListLines(todos),
    'Continue working through pending items, update statuses with TodoWrite as you progress, and do not mention this reminder to the user.',
    '</system-reminder>',
  ].join('\n');
}
