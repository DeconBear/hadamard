import { marked } from 'marked';
import type { NotebookEditorCell } from './types.js';

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

export interface MarkdownMergeResult {
  cells: NotebookEditorCell[];
  idMap: Record<string, string>;
}

export function mergeAdjacentMarkdownCells(cells: NotebookEditorCell[]): MarkdownMergeResult {
  const merged: NotebookEditorCell[] = [];
  const idMap: Record<string, string> = {};
  for (const cell of cells) {
    const previous = merged[merged.length - 1];
    if (cell.kind !== 'markdown' || previous?.kind !== 'markdown') {
      merged.push(cell);
      continue;
    }
    const source = previous.source.trim() && cell.source.trim()
      ? previous.source.trimEnd() + '\n\n' + cell.source.trimStart()
      : previous.source || cell.source;
    merged[merged.length - 1] = { ...previous, source };
    idMap[cell.id] = previous.id;
  }
  return { cells: merged, idMap };
}
