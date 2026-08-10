import type { SessionSummary } from '../types.js';
import { filterInteractiveCommands } from '../ui/commandSurface.js';
import { A, wrapToWidth } from './ansi.js';

export function filterSlashCommands(input: string): string[] {
  return filterInteractiveCommands(input);
}

export function isTuiChatSession(session: Pick<SessionSummary, 'kind'>): boolean {
  return session.kind !== 'manager' && session.kind !== 'agent';
}

export function activeAtToken(
  text: string,
  cursor: number,
): { token: string; start: number } | null {
  for (let i = cursor - 1; i >= 0; i -= 1) {
    const ch = text[i]!;
    if (/\s/.test(ch)) return null;
    if (ch === '@') {
      if (i === 0 || /\s/.test(text[i - 1]!)) {
        return { token: text.slice(i + 1, cursor), start: i };
      }
      return null;
    }
  }
  return null;
}

export function renderRichText(
  text: string,
  width: number,
  opts: { maxLines?: number } = {},
): string[] {
  const cols = Math.max(20, width - 2);
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      out.push(`${A.dim}${'─'.repeat(Math.min(cols, 40))}${A.reset}`);
      continue;
    }
    if (inFence) {
      out.push(`${A.gray}  ${raw}${A.reset}`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      out.push(`${A.bold}${A.cyan}${heading[2]}${A.reset}`);
      continue;
    }
    if (raw.trim() === '') {
      out.push('');
      continue;
    }
    for (const line of wrapToWidth(raw, cols)) out.push(renderMarkdownInline(line));
  }
  const maxLines = opts.maxLines ?? 0;
  if (maxLines > 0 && out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    kept.push(`${A.dim}… (${out.length - maxLines} more lines)${A.reset}`);
    return kept;
  }
  return out;
}

function renderMarkdownInline(line: string): string {
  return line
    .replace(/`([^`]+)`/g, `${A.dim}$1${A.reset}`)
    .replace(/\*\*([^*]+)\*\*/g, `${A.bold}$1${A.reset}`)
    .replace(/\*([^*]+)\*/g, `${A.italic}$1${A.reset}`);
}
