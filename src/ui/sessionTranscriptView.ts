import type { MessageParam, ToolResultBlockParam, ToolUseBlock } from '../provider/types.js';
import { isHadamardProjectInstructionMessage } from '../memory/projectInstructionContext.js';

export type SessionTranscriptEvent =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      input: unknown;
      ok: boolean;
      text: string;
    };

/**
 * Flatten a stored conversation into the same event shapes the live GUI/TUI
 * streams emit, so resume can replay history through the normal render path.
 * Matches Claude Code seeding REPL `initialMessages` and Codex restoring the
 * rollout transcript into the TUI conversation view.
 */
export function buildSessionTranscriptEvents(
  messages: readonly MessageParam[],
  options: { includeThinking?: boolean } = {},
): SessionTranscriptEvent[] {
  const events: SessionTranscriptEvent[] = [];
  const results = new Map<string, { ok: boolean; text: string }>();

  for (const message of messages) {
    if (isHadamardProjectInstructionMessage(message)) continue;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block && typeof block === 'object' && block.type === 'tool_result') {
        const result = block as ToolResultBlockParam;
        results.set(result.tool_use_id, {
          ok: result.is_error !== true,
          text: stringifyToolResult(result.content),
        });
      }
    }
  }

  for (const message of messages) {
    if (isHadamardProjectInstructionMessage(message)) continue;
    const content = message.content;
    if (typeof content === 'string') {
      if (content.trim()) {
        events.push({ type: message.role === 'assistant' ? 'assistant' : 'user', text: content });
      }
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
        const text = (block as { text: string }).text;
        if (text.trim()) {
          events.push({ type: message.role === 'assistant' ? 'assistant' : 'user', text });
        }
      } else if (block.type === 'thinking' && options.includeThinking === true) {
        const thinking = typeof (block as { thinking?: unknown }).thinking === 'string'
          ? (block as { thinking: string }).thinking
          : '';
        if (thinking.trim()) events.push({ type: 'thinking', text: thinking });
      } else if (block.type === 'tool_use') {
        const call = block as ToolUseBlock;
        const result = results.get(call.id);
        events.push({
          type: 'tool',
          id: call.id,
          name: call.name,
          input: call.input,
          ok: result ? result.ok : true,
          text: result ? result.text : '',
        });
      }
    }
  }

  return events;
}

function stringifyToolResult(content: ToolResultBlockParam['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
        return (block as { text: string }).text;
      }
      try {
        return JSON.stringify(block);
      } catch {
        return '';
      }
    })
    .join('\n');
}
