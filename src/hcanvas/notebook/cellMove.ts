import type { NotebookEditorCell, NotebookEditorData } from './types.js';
import { markdownBlockCount, splitMarkdownAtBlock } from './markdownBlocks.js';

export interface MarkdownCodeMoveResult {
  moved: boolean;
  split: boolean;
  fallback: boolean;
  markdownChanged: boolean;
}

export function moveCodeCellToMarkdown(
  data: NotebookEditorData,
  codeId: string,
  markdownId: string,
  blockIndex: number,
  renderedCount: number,
  newId: () => string,
): MarkdownCodeMoveResult {
  const code = data.cells.find(cell => cell.id === codeId && cell.kind === 'code');
  const markdown = data.cells.find(cell => cell.id === markdownId && cell.kind === 'markdown');
  if (!code || !markdown || code.id === markdown.id) return { moved: false, split: false, fallback: false, markdownChanged: false };
  const interior = blockIndex > 0 && blockIndex < renderedCount;
  const parts = interior && renderedCount === markdownBlockCount(markdown.source)
    ? splitMarkdownAtBlock(markdown.source, blockIndex)
    : null;
  const cells = data.cells.filter(cell => cell.id !== codeId);
  const targetIndex = cells.findIndex(cell => cell.id === markdownId);
  if (targetIndex < 0) return { moved: false, split: false, fallback: false, markdownChanged: false };
  if (parts) {
    markdown.source = parts.before;
    const after: NotebookEditorCell = { id: newId(), kind: 'markdown', source: parts.after };
    cells.splice(targetIndex, 1, markdown, code, after);
  } else {
    cells.splice(targetIndex + (blockIndex === 0 ? 0 : 1), 0, code);
  }
  data.cells = cells;
  return { moved: true, split: Boolean(parts), fallback: interior && !parts, markdownChanged: Boolean(parts) };
}
