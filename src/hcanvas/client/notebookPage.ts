/**
 * Page-based multi-language notebook viewer.
 *
 * Data lives in `page.extension.data` (document JSON under the workspace
 * `.hcanvas/docs` folder), not in a sidecar file. Every code cell can pick its
 * own kernel (Python, Octave, C++, ...) and outputs are stored on the cell.
 */
import type { HcPage } from '../types.js';
import { renderMarkdownHtml } from '../markdown.js';
import { renderStoredOutputsHtml, type HcStoredOutput } from '../execOutputs.js';
import { eventsToStoredOutputs, renderRuntimeEvent } from './execCell.js';
import { persistKernelOutputAssets } from './kernelOutputAssets.js';
import type { KernelDescriptor, KernelManager, KernelOutputEvent } from './kernelManager.js';
import { esc, genId } from './utils.js';

export interface NotebookPageDeps {
  request<T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T>;
  getKernelManager(): KernelManager | null;
  getKernels(): KernelDescriptor[];
  savePageData(pageId: string, data: unknown): Promise<boolean>;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

export interface NotebookPageContext {
  pageId?: string;
  name?: string;
  data?: unknown;
}

export interface NotebookPageCell {
  id: string;
  kind: 'code' | 'markdown';
  source: string;
  kernelId?: string;
  outputs?: HcStoredOutput[];
}

export interface NotebookPageData {
  version: 1;
  cells: NotebookPageCell[];
  defaultKernelId?: string;
}

const NOTEBOOK_FORMAT = 'hadamard-notebook';

function normalizeData(raw: unknown, kernels: KernelDescriptor[]): NotebookPageData {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const cells: NotebookPageCell[] = [];
  if (Array.isArray(source.cells)) {
    for (const item of source.cells) {
      if (!item || typeof item !== 'object') continue;
      const cell = item as Record<string, unknown>;
      if (cell.kind !== 'code' && cell.kind !== 'markdown') continue;
      cells.push({
        id: typeof cell.id === 'string' && cell.id ? cell.id : genId('nbcell'),
        kind: cell.kind,
        source: typeof cell.source === 'string' ? cell.source : '',
        ...(typeof cell.kernelId === 'string' ? { kernelId: cell.kernelId } : {}),
        ...(Array.isArray(cell.outputs) ? { outputs: cell.outputs as HcStoredOutput[] } : {}),
      });
    }
  }
  const defaultKernelId = typeof source.defaultKernelId === 'string' && source.defaultKernelId
    ? source.defaultKernelId
    : pickDefaultKernel(kernels);
  if (!cells.length) {
    cells.push({ id: genId('nbcell'), kind: 'markdown', source: '# Untitled notebook\n\nPick a kernel in each code cell, then press Shift+Enter to run it.' });
    cells.push({ id: genId('nbcell'), kind: 'code', source: starterCode(defaultKernelId), ...(defaultKernelId ? { kernelId: defaultKernelId } : {}) });
  }
  return { version: 1, cells, ...(defaultKernelId ? { defaultKernelId } : {}) };
}

function pickDefaultKernel(kernels: KernelDescriptor[]): string {
  for (const preferred of ['python', 'octave', 'cpp']) {
    const match = kernels.find(kernel => kernel.language === preferred || kernel.id === preferred);
    if (match) return match.id;
  }
  return kernels[0]?.id || '';
}

function starterCode(kernelId: string): string {
  const kernel = kernelId;
  if (kernel === 'octave') return 'disp("Hello from Octave");';
  if (kernel === 'cpp') return 'cout << "Hello from C++" << endl;';
  if (kernel === 'python') return 'print("Hello from Python")';
  return 'print("Hello")';
}

export function notebookPageMarkup(): string {
  return '<div class="masters-head"><strong>Notebook pages</strong><small>Multi-language executable notebook stored inside this document</small></div>' +
    '<div class="preset-grid"><button type="button" class="preset-btn" data-notebook-page><strong>Notebook</strong><small>Markdown + Python / Octave / C++ code cells</small></button></div>';
}

export function createNotebookPageDefinition(kernels: KernelDescriptor[], name = 'Notebook'): HcPage {
  const defaultKernelId = pickDefaultKernel(kernels);
  const data: NotebookPageData = {
    version: 1,
    ...(defaultKernelId ? { defaultKernelId } : {}),
    cells: [
      { id: genId('nbcell'), kind: 'markdown', source: '# ' + name + '\n\n每个 code cell 可以选择自己的内核（Python / GNU Octave / C++ 等），按 Shift+Enter 运行。' },
      { id: genId('nbcell'), kind: 'code', source: starterCode(defaultKernelId), ...(defaultKernelId ? { kernelId: defaultKernelId } : {}) },
    ],
  };
  return {
    id: genId('page'),
    name,
    mode: 'extension',
    width: 1280,
    height: 820,
    background: '#ffffff',
    extension: { format: NOTEBOOK_FORMAT, data },
  };
}

export function mountNotebookPage(host: HTMLElement, deps: NotebookPageDeps, context: NotebookPageContext): { dispose(): void } | null {
  if (!context.pageId) return null;
  const pageId = context.pageId;
  let kernels = deps.getKernels();
  let data = normalizeData(context.data, kernels);
  let dirty = false;
  let saving = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const running = new Map<string, { handle: { cancel(): Promise<void> } | null; outputs: KernelOutputEvent[] }>();

  host.classList.add('notebook-host');
  host.classList.add('notebook-page-host');

  const setStatus = (text: string, tone: 'idle' | 'dirty' | 'saving' | 'saved' | 'error' = 'idle'): void => {
    const status = host.querySelector<HTMLElement>('[data-nb-status]');
    if (status) { status.textContent = text; status.dataset.tone = tone; }
  };
  const markDirty = (): void => {
    dirty = true;
    setStatus('Unsaved', 'dirty');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void save(); }, 600);
  };
  const save = async (): Promise<void> => {
    if (!dirty || saving || disposed) return;
    saving = true;
    setStatus('Saving…', 'saving');
    try {
      const payload: NotebookPageData = { version: 1, ...(data.defaultKernelId ? { defaultKernelId: data.defaultKernelId } : {}), cells: data.cells };
      await deps.savePageData(pageId, payload);
      dirty = false;
      setStatus('Saved', 'saved');
    } catch (error) {
      setStatus('Save failed', 'error');
      deps.toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      saving = false;
    }
  };
  const kernelById = (id: string | undefined): KernelDescriptor | null => id ? kernels.find(kernel => kernel.id === id) || null : null;
  const cellKernel = (cell: NotebookPageCell): KernelDescriptor | null => kernelById(cell.kernelId) || kernelById(data.defaultKernelId) || kernels[0] || null;
  const kernelOptionsHtml = (selected: string | undefined): string => {
    if (!kernels.length) return '<option value="">No kernel installed</option>';
    return kernels.map(kernel => '<option value="' + esc(kernel.id) + '"' + (kernel.id === selected ? ' selected' : '') + '>' + esc(kernel.label || kernel.language || kernel.id) + '</option>').join('');
  };
  const outputFor = (cell: NotebookPageCell): HcStoredOutput[] => Array.isArray(cell.outputs) ? cell.outputs : [];

  const runCell = async (cell: NotebookPageCell, index: number): Promise<void> => {
    const manager = deps.getKernelManager();
    if (!manager) { deps.toast('Kernel runtime is not available.', 'error'); return; }
    const kernel = cellKernel(cell);
    if (!kernel) { deps.toast('Install a kernel extension (Python, Octave or C++) first.', 'info'); return; }
    if (running.has(cell.id)) return;
    if (cell.kernelId !== kernel.id) { cell.kernelId = kernel.id; markDirty(); }
    const cellEl = host.querySelector<HTMLElement>('[data-nb-cell="' + index + '"]');
    const outputEl = cellEl?.querySelector<HTMLElement>('[data-nb-output]');
    const statusEl = cellEl?.querySelector<HTMLElement>('[data-nb-cell-status]');
    if (statusEl) { statusEl.textContent = 'running'; statusEl.dataset.tone = 'running'; }
    if (outputEl) outputEl.innerHTML = '';
    const state = { handle: null as { cancel(): Promise<void> } | null, outputs: [] as KernelOutputEvent[] };
    running.set(cell.id, state);
    try {
      const handle = await manager.execute(kernel.id, cell.source, { scope: { kind: 'page', key: pageId }, cellId: cell.id });
      state.handle = handle;
      handle.onOutput(event => {
        state.outputs.push(event);
        if (outputEl) renderRuntimeEvent(outputEl, event);
      });
      const result = await handle.done;
      const stored = eventsToStoredOutputs(result.outputs);
      const persisted = await persistKernelOutputAssets(stored, { sessionId: handle.sessionId, executionId: handle.executionId }, { request: deps.request });
      cell.outputs = persisted;
      if (outputEl) outputEl.innerHTML = renderStoredOutputsHtml(persisted);
      if (statusEl) { statusEl.textContent = result.status === 'ok' ? 'ok' : result.status; statusEl.dataset.tone = result.status === 'ok' ? 'ok' : 'error'; }
      markDirty();
      if (result.status === 'error') deps.toast('Cell failed; see traceback.', 'error');
    } catch (error) {
      if (statusEl) { statusEl.textContent = 'error'; statusEl.dataset.tone = 'error'; }
      deps.toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      running.delete(cell.id);
    }
  };

  const runAll = async (): Promise<void> => {
    for (let index = 0; index < data.cells.length; index += 1) {
      const cell = data.cells[index];
      if (cell?.kind !== 'code') continue;
      await runCell(cell, index);
    }
  };

  const restartKernels = async (): Promise<void> => {
    const manager = deps.getKernelManager();
    if (!manager) return;
    const ids = new Set<string>();
    for (const cell of data.cells) {
      if (cell.kind !== 'code') continue;
      const kernel = cellKernel(cell);
      if (kernel) ids.add(kernel.id);
    }
    try {
      for (const id of ids) await manager.restart(id, { kind: 'page', key: pageId });
      deps.toast('Kernels restarted; variables cleared.', 'success');
    } catch (error) { deps.toast(error instanceof Error ? error.message : String(error), 'error'); }
  };

  const stopAll = async (): Promise<void> => {
    for (const state of running.values()) await state.handle?.cancel().catch(() => undefined);
  };

  const renderCodeCell = (cell: NotebookPageCell, index: number): string => {
    const outputs = outputFor(cell);
    const kernel = cellKernel(cell);
    return '<section class="nb-cell nb-code" data-nb-cell="' + index + '">' +
      '<header class="nb-cell-head">' +
      '<select class="nb-cell-kernel" data-nb-cell-kernel="' + index + '" aria-label="Cell kernel">' + kernelOptionsHtml(kernel?.id) + '</select>' +
      '<span class="nb-cell-status" data-nb-cell-status data-tone="idle"></span>' +
      '<span class="nb-cell-actions">' +
      '<button type="button" class="btn tiny primary" data-nb-run="' + index + '">Run</button>' +
      '<button type="button" class="btn tiny" data-nb-up="' + index + '">↑</button>' +
      '<button type="button" class="btn tiny" data-nb-down="' + index + '">↓</button>' +
      '<button type="button" class="btn tiny" data-nb-insert="' + index + '">＋</button>' +
      '<button type="button" class="btn tiny danger" data-nb-delete="' + index + '">×</button>' +
      '</span></header>' +
      '<textarea class="nb-code-input" data-nb-code="' + index + '" spellcheck="false" rows="' + Math.min(18, Math.max(3, cell.source.split('\n').length)) + '">' + esc(cell.source) + '</textarea>' +
      '<div class="nb-output" data-nb-output>' + (outputs.length ? renderStoredOutputsHtml(outputs) : '') + '</div>' +
      '</section>';
  };

  const renderMarkdownCell = (cell: NotebookPageCell, index: number): string => {
    const preview = cell.source.trim()
      ? renderMarkdownHtml(cell.source)
      : '<p class="nb-md-placeholder">Double-click to write markdown</p>';
    return '<section class="nb-cell nb-markdown" data-nb-cell="' + index + '">' +
      '<div class="nb-markdown-body" data-nb-markdown-view="' + index + '">' + preview + '</div>' +
      '<div class="nb-markdown-hover-actions">' +
      '<button type="button" class="nb-icon-btn" title="Edit markdown" data-nb-edit-markdown="' + index + '">Edit</button>' +
      '<button type="button" class="nb-icon-btn" title="Move up" data-nb-up="' + index + '">↑</button>' +
      '<button type="button" class="nb-icon-btn" title="Move down" data-nb-down="' + index + '">↓</button>' +
      '<button type="button" class="nb-icon-btn danger" title="Delete cell" data-nb-delete="' + index + '">×</button>' +
      '</div>' +
      '<div class="nb-markdown-edit hidden" data-nb-markdown-edit="' + index + '">' +
      '<textarea class="nb-markdown-input" data-nb-markdown-input="' + index + '" spellcheck="false" rows="' + Math.min(16, Math.max(3, cell.source.split('\n').length + 1)) + '">' + esc(cell.source) + '</textarea>' +
      '<div class="nb-markdown-actions"><span class="nb-md-hint">Ctrl+Enter 保存 · Esc 取消</span><button type="button" class="btn tiny" data-nb-markdown-cancel="' + index + '">Cancel</button><button type="button" class="btn tiny primary" data-nb-markdown-save="' + index + '">Done</button></div>' +
      '</div></section>';
  };

  const toggleMarkdownEdit = (index: number, editing: boolean): void => {
    const edit = host.querySelector<HTMLElement>('[data-nb-markdown-edit="' + index + '"]');
    const view = host.querySelector<HTMLElement>('[data-nb-markdown-view="' + index + '"]');
    if (!edit || !view) return;
    edit.classList.toggle('hidden', !editing);
    view.classList.toggle('hidden', editing);
    if (editing) host.querySelector<HTMLTextAreaElement>('[data-nb-markdown-input="' + index + '"]')?.focus();
  };

  const commitMarkdown = (index: number): void => {
    const cell = data.cells[index];
    const input = host.querySelector<HTMLTextAreaElement>('[data-nb-markdown-input="' + index + '"]');
    if (!cell || cell.kind !== 'markdown' || !input) return;
    cell.source = input.value;
    markDirty();
    renderAll();
  };

  const insertCell = (afterIndex: number): void => {
    const kernel = kernelById(data.defaultKernelId) || kernels[0] || null;
    data.cells.splice(afterIndex + 1, 0, { id: genId('nbcell'), kind: 'code', source: '', ...(kernel ? { kernelId: kernel.id } : {}) });
    markDirty();
    renderAll();
    requestAnimationFrame(() => { host.querySelector<HTMLTextAreaElement>('[data-nb-code="' + (afterIndex + 1) + '"]')?.focus(); });
  };

  const deleteCell = (index: number): void => {
    if (!data.cells[index]) return;
    data.cells.splice(index, 1);
    markDirty();
    renderAll();
  };

  const moveCell = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= data.cells.length) return;
    const [cell] = data.cells.splice(index, 1);
    if (cell) data.cells.splice(target, 0, cell);
    markDirty();
    renderAll();
  };

  const exportHtml = (): void => {
    const title = context.name || 'Notebook';
    const body = data.cells.map(cell => {
      if (cell.kind === 'markdown') return '<section class="md">' + renderMarkdownHtml(cell.source) + '</section>';
      const kernel = cellKernel(cell);
      return '<section class="code"><div class="cell-kernel">' + esc(kernel?.label || kernel?.language || 'code') + '</div><pre>' + esc(cell.source) + '</pre><div class="out">' + renderStoredOutputsHtml(outputFor(cell)) + '</div></section>';
    }).join('\n');
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' +
      'body{font:15px/1.6 Inter,system-ui,sans-serif;color:#1f2430;max-width:900px;margin:40px auto;padding:0 20px;background:#faf8f3}' +
      '.md h1,.md h2{font-family:Georgia,serif}.code{margin:18px 0}.cell-kernel{font:10px Inter,sans-serif;color:#8a8276;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}.code pre{background:#171923;color:#e2e8f0;padding:14px;border-radius:10px;overflow:auto;font:12px/1.55 ui-monospace,Consolas,monospace}' +
      '.out img{max-width:100%}.out pre{white-space:pre-wrap;background:#fff;border:1px solid #e3ded3;border-radius:8px;padding:10px}.out iframe{width:100%;min-height:180px;border:1px solid #e3ded3;border-radius:8px}.exec-out-error{color:#b42318}</style></head><body>' + body + '</body></html>';
    const blob = new Blob([html], { type: 'text/html' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = title.replace(/[^A-Za-z0-9_-]+/g, '-') + '.html';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 3000);
  };

  const bindCells = (): void => {
    host.querySelectorAll<HTMLTextAreaElement>('[data-nb-code]').forEach(textarea => {
      const index = Number(textarea.dataset.nbCode);
      const cell = data.cells[index];
      if (!cell || cell.kind !== 'code') return;
      textarea.addEventListener('input', () => {
        cell.source = textarea.value;
        markDirty();
        const outputEl = textarea.parentElement?.querySelector<HTMLElement>('[data-nb-output]');
        if (outputEl) outputEl.innerHTML = '';
      });
      textarea.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || !(event.shiftKey || event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        void runCell(cell, index);
      });
    });
    host.querySelectorAll<HTMLSelectElement>('[data-nb-cell-kernel]').forEach(select => {
      const index = Number(select.dataset.nbCellKernel);
      const cell = data.cells[index];
      if (!cell || cell.kind !== 'code') return;
      select.addEventListener('change', () => { cell.kernelId = select.value; markDirty(); });
    });
    host.querySelectorAll<HTMLButtonElement>('[data-nb-run]').forEach(button => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.nbRun);
        const cell = data.cells[index];
        if (cell?.kind === 'code') void runCell(cell, index);
      });
    });
    host.querySelectorAll<HTMLButtonElement>('[data-nb-insert]').forEach(button => button.addEventListener('click', () => insertCell(Number(button.dataset.nbInsert))));
    host.querySelectorAll<HTMLButtonElement>('[data-nb-delete]').forEach(button => button.addEventListener('click', () => deleteCell(Number(button.dataset.nbDelete))));
    host.querySelectorAll<HTMLButtonElement>('[data-nb-up]').forEach(button => button.addEventListener('click', () => moveCell(Number(button.dataset.nbUp), -1)));
    host.querySelectorAll<HTMLButtonElement>('[data-nb-down]').forEach(button => button.addEventListener('click', () => moveCell(Number(button.dataset.nbDown), 1)));
    host.querySelectorAll<HTMLButtonElement>('[data-nb-edit-markdown]').forEach(button => button.addEventListener('click', () => toggleMarkdownEdit(Number(button.dataset.nbEditMarkdown), true)));
    host.querySelectorAll<HTMLButtonElement>('[data-nb-markdown-cancel]').forEach(button => button.addEventListener('click', () => toggleMarkdownEdit(Number(button.dataset.nbMarkdownCancel), false)));
    host.querySelectorAll<HTMLButtonElement>('[data-nb-markdown-save]').forEach(button => button.addEventListener('click', () => commitMarkdown(Number(button.dataset.nbMarkdownSave))));
    host.querySelectorAll<HTMLElement>('[data-nb-markdown-view]').forEach(view => view.addEventListener('dblclick', () => toggleMarkdownEdit(Number(view.dataset.nbMarkdownView), true)));
    host.querySelectorAll<HTMLTextAreaElement>('[data-nb-markdown-input]').forEach(input => {
      const index = Number(input.dataset.nbMarkdownInput);
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commitMarkdown(index); }
        if (event.key === 'Escape') { event.preventDefault(); toggleMarkdownEdit(index, false); }
      });
    });
  };

  const renderAll = (): void => {
    kernels = deps.getKernels();
    const title = context.name || 'Notebook';
    host.innerHTML = '<div class="notebook-view">' +
      '<header class="nb-toolbar"><div class="nb-title"><strong data-nb-title>' + esc(title) + '</strong><small>Notebook page · saved in this document · ' + (kernels.length ? kernels.length + ' kernel' + (kernels.length === 1 ? '' : 's') : 'no kernels installed') + '</small></div>' +
      '<div class="nb-actions">' +
      '<select class="nb-kernel" data-nb-default-kernel aria-label="Default kernel for new cells">' + kernelOptionsHtml(data.defaultKernelId) + '</select>' +
      '<button type="button" class="btn tiny primary" data-nb-runall>Run all</button>' +
      '<button type="button" class="btn tiny" data-nb-stop>Stop</button>' +
      '<button type="button" class="btn tiny" data-nb-restart>Restart kernels</button>' +
      '<span class="nb-save-status" data-nb-status data-tone="idle"></span>' +
      '<button type="button" class="btn tiny" data-nb-export>Export HTML</button>' +
      '</div></header>' +
      '<main class="nb-cells">' + data.cells.map((cell, index) => cell.kind === 'code' ? renderCodeCell(cell, index) : renderMarkdownCell(cell, index)).join('') + '</main>' +
      '<footer class="nb-footer"><span>Shift+Enter / Ctrl+Enter · Run all executes each cell with its own kernel · cells saved in document data</span>' +
      '<button type="button" class="btn tiny" data-nb-add-code>+ Code cell</button>' +
      '<button type="button" class="btn tiny" data-nb-add-md>+ Markdown cell</button></footer>' +
      '</div>';
    bindCells();
    host.querySelector<HTMLSelectElement>('[data-nb-default-kernel]')?.addEventListener('change', event => {
      data.defaultKernelId = (event.target as HTMLSelectElement).value;
      markDirty();
    });
    host.querySelector('[data-nb-runall]')?.addEventListener('click', () => { void runAll(); });
    host.querySelector('[data-nb-stop]')?.addEventListener('click', () => { void stopAll(); });
    host.querySelector('[data-nb-restart]')?.addEventListener('click', () => { void restartKernels(); });
    host.querySelector('[data-nb-export]')?.addEventListener('click', exportHtml);
    host.querySelector('[data-nb-add-code]')?.addEventListener('click', () => insertCell(data.cells.length - 1));
    host.querySelector('[data-nb-add-md]')?.addEventListener('click', () => { data.cells.push({ id: genId('nbcell'), kind: 'markdown', source: '' }); markDirty(); renderAll(); });
    setStatus(dirty ? 'Unsaved' : 'Saved', dirty ? 'dirty' : 'saved');
  };

  renderAll();
  return {
    dispose() {
      disposed = true;
      if (saveTimer) clearTimeout(saveTimer);
      if (dirty) void save();
      void stopAll();
    },
  };
}
