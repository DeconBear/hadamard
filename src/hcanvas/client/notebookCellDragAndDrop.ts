import type { NotebookEditorCell } from '../notebook/types.js';

interface MarkdownDropTarget {
  cellId: string;
  index: number;
  renderedCount: number;
}

export interface NotebookCellDragOptions {
  cell(id: string): NotebookEditorCell | undefined;
  cellIndex(id: string): number;
  syncMarkdown(): void;
  moveCellTo(id: string, index: number): void;
  moveCodeToMarkdown(codeId: string, markdownId: string, blockIndex: number, renderedCount: number): void;
}

export function installNotebookCellDragAndDrop(cellsHost: HTMLElement, options: NotebookCellDragOptions): () => void {
  const controller = new AbortController();
  const signal = controller.signal;
  const indicator = document.createElement('div');
  indicator.className = 'nb-markdown-drop-indicator hidden';
  document.body.appendChild(indicator);
  let draggedCellId = '';
  let markdownDrop: MarkdownDropTarget | null = null;

  const hideIndicator = (): void => {
    indicator.classList.add('hidden');
    markdownDrop = null;
  };
  const reset = (): void => {
    draggedCellId = '';
    hideIndicator();
  };
  const dropPosition = (view: HTMLElement, clientY: number): { target: MarkdownDropTarget; top: number; left: number; width: number } => {
    const blocks = Array.from(view.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    const viewRect = view.getBoundingClientRect();
    let index = blocks.length;
    let top = blocks.length ? blocks[blocks.length - 1]!.getBoundingClientRect().bottom + 2 : viewRect.top;
    for (let position = 0; position < blocks.length; position += 1) {
      const rect = blocks[position]!.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        index = position;
        top = rect.top - 2;
        break;
      }
    }
    return {
      target: { cellId: view.dataset.nbMarkdownView || '', index, renderedCount: blocks.length },
      top,
      left: viewRect.left,
      width: viewRect.width,
    };
  };

  cellsHost.addEventListener('dragstart', event => {
    const handle = (event.target as Element | null)?.closest<HTMLElement>('[data-nb-drag]');
    if (!handle) return;
    draggedCellId = handle.dataset.nbDrag || '';
    event.dataTransfer?.setData('text/plain', draggedCellId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }, { signal });
  cellsHost.addEventListener('dragover', event => {
    const section = (event.target as Element | null)?.closest<HTMLElement>('[data-nb-cell]');
    const dragged = options.cell(draggedCellId);
    if (!section || !dragged) return;
    const view = (event.target as Element | null)?.closest<HTMLElement>('[data-nb-markdown-view]');
    if (dragged.kind === 'code' && view && cellsHost.contains(view)) {
      const position = dropPosition(view, event.clientY);
      markdownDrop = position.target;
      indicator.style.left = position.left + 'px';
      indicator.style.top = position.top + 'px';
      indicator.style.width = position.width + 'px';
      indicator.classList.remove('hidden');
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      return;
    }
    hideIndicator();
    event.preventDefault();
  }, { signal });
  cellsHost.addEventListener('drop', event => {
    const section = (event.target as Element | null)?.closest<HTMLElement>('[data-nb-cell]');
    if (!section || !draggedCellId) return;
    event.preventDefault();
    const dragged = options.cell(draggedCellId);
    if (dragged?.kind === 'code' && markdownDrop) {
      options.syncMarkdown();
      options.moveCodeToMarkdown(draggedCellId, markdownDrop.cellId, markdownDrop.index, markdownDrop.renderedCount);
    } else {
      options.moveCellTo(draggedCellId, options.cellIndex(section.dataset.nbCell || ''));
    }
    reset();
  }, { signal });
  cellsHost.addEventListener('dragleave', event => {
    if (!cellsHost.contains(event.relatedTarget as Node | null)) hideIndicator();
  }, { signal });
  cellsHost.addEventListener('dragend', reset, { signal });
  return () => {
    controller.abort();
    indicator.remove();
  };
}
