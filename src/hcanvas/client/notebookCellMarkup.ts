import type { NotebookEditorCell, NotebookEditorData } from '../notebook/types.js';
import type { KernelDescriptor } from './kernelManager.js';
import { sanitizeMarkdownHtml } from './markdownSanitize.js';
import { renderMarkdownHtml } from '../markdown.js';
import { esc } from './utils.js';

const PLAY = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.2 1.8v8.4L10 6z"/></svg>';

function cellKernel(data: NotebookEditorData, kernels: KernelDescriptor[], cell: NotebookEditorCell): KernelDescriptor | null {
  return kernels.find(kernel => kernel.id === cell.kernelId)
    || kernels.find(kernel => kernel.language === cell.language || kernel.id === cell.language || (kernel.defaultFor || []).includes(cell.language || ''))
    || kernels.find(kernel => kernel.id === data.defaultKernelId)
    || kernels.find(kernel => kernel.language === 'python')
    || kernels[0]
    || null;
}

function kernelOptions(kernels: KernelDescriptor[], selected?: string): string {
  if (!kernels.length) return '<option value="">No kernel installed</option>';
  return kernels.map(kernel => '<option value="' + esc(kernel.id) + '"' + (kernel.id === selected ? ' selected' : '') + '>' + esc(kernel.label || kernel.language || kernel.id) + '</option>').join('');
}

export function renderNotebookCodeCell(data: NotebookEditorData, kernels: KernelDescriptor[], cell: NotebookEditorCell, index: number): string {
  const kernel = cellKernel(data, kernels, cell);
  const executable = cell.executable !== false;
  return '<section class="nb-cell nb-code' + (cell.stale ? ' nb-code-stale' : '') + (cell.hideCode ? ' nb-code-hidden' : '') + (cell.hideOutput ? ' nb-output-hidden' : '') + '" data-nb-cell="' + esc(cell.id) + '" tabindex="0" aria-label="Code cell">' +
    '<div class="nb-cell-content"><header class="nb-cell-head"><span class="nb-cell-drag nb-code-drag" draggable="true" data-nb-drag="' + esc(cell.id) + '" title="Drag to reorder or drop between Markdown paragraphs">⋮⋮</span>' +
    '<button type="button" class="nb-icon-btn nb-code-collapse" data-nb-toggle-code="' + esc(cell.id) + '" title="Collapse or expand code" aria-label="' + (cell.hideCode ? 'Expand code' : 'Collapse code') + '" aria-expanded="' + String(!cell.hideCode) + '">' + (cell.hideCode ? '›' : '⌄') + '</button>' +
    '<select class="nb-cell-kernel" data-nb-cell-kernel="' + esc(cell.id) + '" aria-label="Cell kernel">' + kernelOptions(kernels, kernel?.id) + '</select>' +
    '<span class="nb-execution-count" data-nb-execution-count>[' + (cell.executionCount || ' ') + ']</span><span class="nb-cell-status" data-nb-cell-status data-tone="idle">' + (executable ? '' : 'Read-only code fence') + '</span>' +
    '<button type="button" class="nb-icon-btn nb-run-btn nb-code-run" title="Run cell (Shift+Enter)" aria-label="Run cell" data-nb-run="' + esc(cell.id) + '"' + (!executable ? ' disabled' : '') + '>' + PLAY + '</button>' +
    '<span class="nb-cell-actions"><button type="button" class="nb-icon-btn" title="Show or hide output" data-nb-toggle-output="' + esc(cell.id) + '">▤</button><button type="button" class="nb-icon-btn" title="Add code below" data-nb-insert-code="' + esc(cell.id) + '">+</button><button type="button" class="nb-icon-btn" title="Move up" data-nb-up="' + esc(cell.id) + '"' + (index === 0 ? ' disabled' : '') + '>↑</button><button type="button" class="nb-icon-btn" title="Move down" data-nb-down="' + esc(cell.id) + '"' + (index === data.cells.length - 1 ? ' disabled' : '') + '>↓</button><button type="button" class="nb-icon-btn danger" title="Delete cell" data-nb-delete="' + esc(cell.id) + '">×</button></span></header>' +
    '<div class="nb-code-input" data-nb-code="' + esc(cell.id) + '"></div><div class="nb-output' + (cell.stale ? ' nb-output-stale' : '') + '" data-nb-output></div></div></section>';
}

export function renderNotebookMarkdownCell(cell: NotebookEditorCell, index: number, cellCount: number): string {
  const preview = cell.source.trim() ? sanitizeMarkdownHtml(renderMarkdownHtml(cell.source)) : '<p class="nb-md-placeholder" data-nb-generated-placeholder="true">Write Markdown, $E=mc^2$, or paste an image URL…</p>';
  return '<section class="nb-cell nb-markdown" data-nb-cell="' + esc(cell.id) + '" data-nb-rendered-source="' + esc(cell.source) + '" tabindex="0" aria-label="Markdown cell"><div class="nb-markdown-rail"><span class="nb-cell-drag" draggable="true" data-nb-drag="' + esc(cell.id) + '" title="Drag to reorder or drop between Markdown paragraphs">⋮⋮</span><span>MD</span></div>' +
    '<div class="nb-markdown-body" contenteditable="true" spellcheck="true" role="textbox" aria-multiline="true" aria-label="Markdown cell" data-nb-markdown-view="' + esc(cell.id) + '">' + preview + '</div>' +
    '<div class="nb-markdown-hover-actions"><button type="button" class="nb-icon-btn" title="Add code below" data-nb-insert-code="' + esc(cell.id) + '">+</button><button type="button" class="nb-icon-btn" title="Move up" data-nb-up="' + esc(cell.id) + '"' + (index === 0 ? ' disabled' : '') + '>↑</button><button type="button" class="nb-icon-btn" title="Move down" data-nb-down="' + esc(cell.id) + '"' + (index === cellCount - 1 ? ' disabled' : '') + '>↓</button><button type="button" class="nb-icon-btn danger" title="Delete cell" data-nb-delete="' + esc(cell.id) + '">×</button></div></section>';
}
