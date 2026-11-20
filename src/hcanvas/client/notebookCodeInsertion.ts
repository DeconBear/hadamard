import type { NotebookEditorData } from '../notebook/types.js';
import type { KernelDescriptor } from './kernelManager.js';
import { moveCodeCellToMarkdown, type MarkdownCodeMoveResult } from '../notebook/cellMove.js';

export function insertNotebookCodeInMarkdown(
  data: NotebookEditorData,
  markdownId: string,
  blockIndex: number,
  renderedCount: number,
  kernel: KernelDescriptor,
  newId: () => string,
): { codeId: string; result: MarkdownCodeMoveResult } | null {
  const codeId = newId();
  data.cells.push({ id: codeId, kind: 'code', source: '', kernelId: kernel.id, language: kernel.language, executable: true, outputs: [] });
  const result = moveCodeCellToMarkdown(data, codeId, markdownId, blockIndex, renderedCount, newId);
  if (!result.moved) {
    data.cells = data.cells.filter(cell => cell.id !== codeId);
    return null;
  }
  return { codeId, result };
}
