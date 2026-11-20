import type { NotebookEditorData } from '../notebook/types.js';
import { mergeAdjacentMarkdownCells } from '../notebook/markdownBlocks.js';

export function mergeNotebookMarkdownSegments(
  data: NotebookEditorData,
  activeCellId: string,
  selectedCellIds: Set<string>,
  markdownRevisions: Map<string, number>,
): string {
  const merged = mergeAdjacentMarkdownCells(data.cells);
  data.cells = merged.cells;
  let nextActive = activeCellId;
  for (const [removed, kept] of Object.entries(merged.idMap)) {
    markdownRevisions.delete(removed);
    if (nextActive === removed) nextActive = kept;
    if (selectedCellIds.delete(removed)) selectedCellIds.add(kept);
  }
  return nextActive || data.cells[0]?.id || '';
}

export function focusNotebookMarkdownAtEnd(view: HTMLElement | null | undefined): void {
  if (!view) return;
  view.focus();
  const range = document.createRange();
  range.selectNodeContents(view);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
