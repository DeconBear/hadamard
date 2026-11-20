import { marked } from 'marked';

export interface MarkdownBlockRange {
  start: number;
  end: number;
  type: string;
}

export function markdownBlockRanges(source: string): MarkdownBlockRange[] {
  const ranges: MarkdownBlockRange[] = [];
  let offset = 0;
  for (const token of marked.lexer(source) as Array<{ type: string; raw: string }>) {
    const start = offset;
    offset += token.raw.length;
    if (token.type === 'space' || !token.raw.trim()) continue;
    ranges.push({ start, end: offset, type: token.type });
  }
  return ranges;
}

export function markdownBlockCount(source: string): number {
  return markdownBlockRanges(source).length;
}

export function splitMarkdownAtBlock(source: string, index: number): { before: string; after: string } | null {
  const ranges = markdownBlockRanges(source);
  if (index <= 0 || index >= ranges.length) return null;
  const boundary = ranges[index]!.start;
  const before = source.slice(0, boundary).trimEnd();
  const after = source.slice(boundary).trim();
  return before && after ? { before, after } : null;
}
