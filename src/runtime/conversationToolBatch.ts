import type { ToolResultBlockParam, ToolUseBlock } from '../provider/types.js';
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


