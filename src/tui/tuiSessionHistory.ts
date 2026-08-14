import type { MessageParam } from '../provider/types.js';
import { buildSessionTranscriptEvents } from '../ui/sessionTranscriptView.js';
import {
  formatEditCall,
  formatInfoLine,
  formatThinking,
  formatToolCall,
  formatToolResult,
  formatUserPrompt,
} from './transcript.js';
import { renderRichText } from './tuiTextPresenter.js';

const MAX_HISTORY_EVENTS = 120;
const MAX_ASSISTANT_LINES = 40;

/** Replay stored messages into TUI scrollback lines. */
export function formatSessionHistory(
  messages: readonly MessageParam[],
  width: number,
): string[] {
  const events = buildSessionTranscriptEvents(messages, { includeThinking: true });
  if (events.length === 0) return [];
  const omitted = Math.max(0, events.length - MAX_HISTORY_EVENTS);
  const visible = omitted > 0 ? events.slice(-MAX_HISTORY_EVENTS) : events;
  const lines: string[] = [];
  if (omitted > 0) {
    lines.push(...formatInfoLine(`${omitted} earlier message${omitted === 1 ? '' : 's'} omitted`), '');
  }
  for (const event of visible) {
    if (event.type === 'user') {
      lines.push(...formatUserPrompt(event.text), '');
      continue;
    }
    if (event.type === 'assistant') {
      lines.push(...renderRichText(event.text, width, { maxLines: MAX_ASSISTANT_LINES }), '');
      continue;
    }
    if (event.type === 'thinking') {
      lines.push(...formatThinking(event.text, width));
      continue;
    }
    lines.push(
      ...(event.name === 'Edit'
        ? formatEditCall(event.input, width)
        : formatToolCall(event.name, event.input, width)),
      ...formatToolResult({ isError: event.ok === false, outputText: event.text }, width),
      '',
    );
  }
  return lines;
}
