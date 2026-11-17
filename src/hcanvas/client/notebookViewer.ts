import { notebookCellKey, parseNotebook, serializeNotebook, type NotebookCell, type NotebookCodeCell, type NotebookMarkdownCell, type ParsedNotebook } from '../notebook/format.js';
import { renderMarkdownHtml } from '../markdown.js';
import { renderStoredOutputsHtml, type HcStoredOutput } from '../execOutputs.js';
import { eventsToStoredOutputs, renderRuntimeEvent } from './execCell.js';
import { persistKernelOutputAssets } from './kernelOutputAssets.js';
import type { KernelDescriptor, KernelManager, KernelOutputEvent } from './kernelManager.js';
import { esc } from './utils.js';
import type { BuiltinViewer, BuiltinViewerContext } from './builtinViewers.js';
import { mountNotebookPage, type NotebookPageContext } from './notebookPage.js';

export interface NotebookViewerDeps {
  request<T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T>;
  getKernelManager(): KernelManager | null;
  getKernels(): KernelDescriptor[];
  savePageData(pageId: string, data: unknown): Promise<boolean>;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

interface NotebookFileContext {
  rootId: string;
  path: string;
}

function fitCodeTextarea(textarea: HTMLTextAreaElement): void {
  const maxHeight = 520;
  textarea.style.height = 'auto';
  const next = Math.min(Math.max(textarea.scrollHeight, 34), maxHeight);
  textarea.style.height = next + 'px';
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

const CACHE_VERSION = 1;

interface OutputCache {
  v: number;
  cells: Record<string, { sourceHash?: string; outputs: HcStoredOutput[] }>;
}

function cacheKeyFor(rootId: string, path: string): string {
  return 'hcanvas.notebook.outputs.v1:' + rootId + ':' + path;
}

function loadCache(rootId: string, path: string): OutputCache {
  try {
    const raw = localStorage.getItem(cacheKeyFor(rootId, path));
    if (!raw) return { v: CACHE_VERSION, cells: {} };
    const parsed = JSON.parse(raw) as OutputCache;
    if (!parsed || parsed.v !== CACHE_VERSION || typeof parsed.cells !== 'object') return { v: CACHE_VERSION, cells: {} };
    return parsed;
  } catch {
    return { v: CACHE_VERSION, cells: {} };
  }
}

function saveCache(rootId: string, path: string, cache: OutputCache): void {
  try {
    const entries = Object.entries(cache.cells);
    // Keep the cache bounded: drop the oldest cells when it grows too large.
    while (entries.length > 80) entries.shift();
    const trimmed: OutputCache = { v: CACHE_VERSION, cells: Object.fromEntries(entries) };
    localStorage.setItem(cacheKeyFor(rootId, path), JSON.stringify(trimmed));
  } catch {
    /* localStorage quota exceeded: outputs remain in memory for this session */
  }
}

function chooseKernel(kernels: KernelDescriptor[], parsed: ParsedNotebook): string {
  const hint = (parsed.frontmatter.values.kernel || '').trim().toLowerCase();
  if (hint) {
    const match = kernels.find(kernel => kernel.id.toLowerCase() === hint || kernel.language.toLowerCase() === hint);
    if (match) return match.id;
  }
  const python = kernels.find(kernel => kernel.language === 'python') || kernels.find(kernel => (kernel.defaultFor || []).includes('python'));
  return (python || kernels[0])?.id || '';
}

function cellTitle(cell: NotebookCell, index: number): string {
  if (cell.kind === 'code') return 'Code · ' + (cell.language || 'text');
  return 'Markdown';
}

export function createNotebookViewer(deps: NotebookViewerDeps): BuiltinViewer {
  return {
    mount(host: HTMLElement, context: BuiltinViewerContext) {
      const pageContext = context.page as NotebookPageContext | undefined;
      if (pageContext?.pageId) {
        return mountNotebookPage(host, deps, pageContext) || {};
      }
      const file = context.file as NotebookFileContext | undefined;
      if (!file?.rootId || !file.path) {
        host.innerHTML = '<div class="extension-viewer-error"><strong>Notebook needs a file or page</strong><small>Open a .hnb.md file or create a Notebook page from Pages → Add a page.</small></div>';
        return {};
      }
      return mountNotebook(host, deps, file);
    },
  };
}

function mountNotebook(host: HTMLElement, deps: NotebookViewerDeps, file: NotebookFileContext): { dispose(): void } {
  let parsed: ParsedNotebook | null = null;
  let kernels: KernelDescriptor[] = [];
  let kernelId = '';
  let dirty = false;
  let saving = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let cache = loadCache(file.rootId, file.path);
  const kernelScope = { kind: 'file' as const, key: file.rootId + ':' + file.path };
  const running = new Map<number, { handle: { cancel(): Promise<void> } | null; outputs: KernelOutputEvent[] }>();

  host.classList.add('notebook-host');
  host.innerHTML = '<div class="notebook-loading">Loading notebook…</div>';

  const scopeName = file.path.split('/').pop() || file.path;

  const readFile = async (): Promise<string> => {
    const result = await deps.request<{ file: { content: string } }>('/api/files/read?root=' + encodeURIComponent(file.rootId) + '&path=' + encodeURIComponent(file.path));
    return result.file.content;
  };

  const writeFile = async (content: string): Promise<void> => {
    await deps.request('/api/files/write', {
      method: 'POST',
      body: JSON.stringify({ root: file.rootId, path: file.path, content }),
    });
  };

  const setStatus = (text: string, tone: 'idle' | 'dirty' | 'saving' | 'saved' | 'error' = 'idle'): void => {
    const status = host.querySelector<HTMLElement>('[data-nb-status]');
    if (status) {
      status.textContent = text;
      status.dataset.tone = tone;
    }
  };

  const markDirty = (): void => {
    dirty = true;
    setStatus('Unsaved', 'dirty');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void save(); }, 700);
  };

  const save = async (): Promise<void> => {
    if (!parsed || !dirty || saving || disposed) return;
    saving = true;
    setStatus('Saving…', 'saving');
    try {
      await writeFile(serializeNotebook(parsed));
      dirty = false;
      setStatus('Saved', 'saved');
    } catch (error) {
      setStatus('Save failed', 'error');
      deps.toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      saving = false;
    }
  };

  const outputFor = (cell: NotebookCodeCell, index: number): HcStoredOutput[] => {
    const key = notebookCellKey(index, cell.source);
    return cache.cells[key]?.outputs || [];
  };

  const setOutputs = (cell: NotebookCodeCell, index: number, outputs: HcStoredOutput[]): void => {
    const key = notebookCellKey(index, cell.source);
    cache.cells[key] = { outputs };
    saveCache(file.rootId, file.path, cache);
  };

  const clearOutputs = (cell: NotebookCodeCell, index: number): void => {
    const key = notebookCellKey(index, cell.source);
    delete cache.cells[key];
    saveCache(file.rootId, file.path, cache);
  };

  const kernelOptions = (): KernelDescriptor[] => kernels;

  const selectedKernel = (): KernelDescriptor | null => kernels.find(kernel => kernel.id === kernelId) || null;

  const runCell = async (cell: NotebookCodeCell, index: number): Promise<void> => {
    const manager = deps.getKernelManager();
    if (!manager) { deps.toast('Kernel runtime is not available.', 'error'); return; }
    const kernel = selectedKernel();
    if (!kernel) { deps.toast('Install a kernel extension (Python Kernel) first.', 'info'); return; }
    if (running.has(index)) return;
    const cellEl = host.querySelector<HTMLElement>('[data-nb-cell="' + index + '"]');
    const outputEl = cellEl?.querySelector<HTMLElement>('[data-nb-output]');
    const statusEl = cellEl?.querySelector<HTMLElement>('[data-nb-cell-status]');
    if (statusEl) { statusEl.textContent = 'running'; statusEl.dataset.tone = 'running'; }
    if (outputEl) outputEl.innerHTML = '';
    const state = { handle: null as { cancel(): Promise<void> } | null, outputs: [] as KernelOutputEvent[] };
    running.set(index, state);
    try {
      const handle = await manager.execute(kernel.id, cell.source, { scope: kernelScope, cellId: 'nb' + index });
      state.handle = handle;
      handle.onOutput(event => {
        state.outputs.push(event);
        if (outputEl) renderRuntimeEvent(outputEl, event);
      });
      const result = await handle.done;
      const outputs = eventsToStoredOutputs(result.outputs);
      const persisted = await persistKernelOutputAssets(outputs, { sessionId: handle.sessionId, executionId: handle.executionId }, { request: deps.request });
      setOutputs(cell, index, persisted);
      if (outputEl) {
        outputEl.innerHTML = renderStoredOutputsHtml(persisted);
      }
      if (statusEl) {
        statusEl.textContent = result.status === 'ok' ? 'ok' : result.status;
        statusEl.dataset.tone = result.status === 'ok' ? 'ok' : 'error';
      }
      if (result.status === 'error') deps.toast('Cell failed; see traceback.', 'error');
    } catch (error) {
      if (statusEl) { statusEl.textContent = 'error'; statusEl.dataset.tone = 'error'; }
      deps.toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      running.delete(index);
    }
  };

  const runAll = async (): Promise<void> => {
    if (!parsed) return;
    for (let index = 0; index < parsed.cells.length; index += 1) {
      const cell = parsed.cells[index];
      if (cell?.kind !== 'code') continue;
      await runCell(cell, index);
    }
  };

  const restartKernel = async (): Promise<void> => {
    const manager = deps.getKernelManager();
    const kernel = selectedKernel();
    if (!manager || !kernel) return;
    try {
      await manager.restart(kernel.id, kernelScope);
      deps.toast('Kernel restarted; variables cleared.', 'success');
    } catch (error) {
      deps.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const stopAll = async (): Promise<void> => {
    for (const state of running.values()) await state.handle?.cancel().catch(() => undefined);
  };

  const renderCodeCell = (cell: NotebookCodeCell, index: number): string => {
    const outputs = outputFor(cell, index);
    return '<section class="nb-cell nb-code" data-nb-cell="' + index + '">' +
      '<header class="nb-cell-head"><span class="nb-cell-kind">' + esc(cellTitle(cell, index)) + '</span>' +
      '<span class="nb-cell-status" data-nb-cell-status data-tone="idle"></span>' +
      '<span class="nb-cell-actions">' +
      '<button type="button" class="btn tiny primary nb-run-btn" title="Run cell (Shift+Enter)" data-nb-run="' + index + '">Run</button>' +
      '<button type="button" class="btn tiny nb-icon-action" title="Move up" data-nb-up="' + index + '">↑</button>' +
      '<button type="button" class="btn tiny nb-icon-action" title="Move down" data-nb-down="' + index + '">↓</button>' +
      '<button type="button" class="btn tiny nb-icon-action" title="Insert code cell below" data-nb-insert="' + index + '">＋</button>' +
      '<button type="button" class="btn tiny nb-icon-action danger" title="Delete cell" data-nb-delete="' + index + '">×</button>' +
      '</span></header>' +
      '<textarea class="nb-code-input" data-nb-code="' + index + '" spellcheck="false" wrap="soft" rows="1">' + esc(cell.source) + '</textarea>' +
      '<div class="nb-output" data-nb-output>' + (outputs.length ? renderStoredOutputsHtml(outputs) : '') + '</div>' +
      '</section>';
  };

  const renderMarkdownCell = (cell: NotebookMarkdownCell, index: number): string => {
    const preview = (cell.source || '').trim()
      ? renderMarkdownHtml(cell.source || '')
      : '<p class="nb-md-placeholder">Click to write markdown</p>';
    return '<section class="nb-cell nb-markdown" data-nb-cell="' + index + '">' +
      '<div class="nb-markdown-body" data-nb-markdown-view="' + index + '">' + preview + '</div>' +
      '<div class="nb-markdown-hover-actions">' +
      '<button type="button" class="nb-icon-btn" title="Move up" data-nb-up="' + index + '">↑</button>' +
      '<button type="button" class="nb-icon-btn" title="Move down" data-nb-down="' + index + '">↓</button>' +
      '<button type="button" class="nb-icon-btn danger" title="Delete cell" data-nb-delete="' + index + '">×</button>' +
      '</div>' +
      '<div class="nb-markdown-edit hidden" data-nb-markdown-edit="' + index + '" data-nb-markdown-index="' + index + '">' +
      '<textarea class="nb-markdown-input" data-nb-markdown-input="' + index + '" spellcheck="false" rows="' + Math.min(16, Math.max(3, cell.source.split('\n').length + 1)) + '">' + esc(cell.source) + '</textarea>' +
      '<div class="nb-markdown-actions"><span class="nb-md-hint">Ctrl+Enter 保存 · Esc 取消</span><button type="button" class="btn tiny" data-nb-markdown-cancel="' + index + '">Cancel</button><button type="button" class="btn tiny primary" data-nb-markdown-save="' + index + '">Done</button></div>' +
      '</div></section>';
  };

  const bindCells = (): void => {
    if (!parsed) return;
    host.querySelectorAll<HTMLTextAreaElement>('[data-nb-code]').forEach(textarea => {
      const index = Number(textarea.dataset.nbCode);
      const cell = parsed!.cells[index];
      if (cell?.kind !== 'code') return;
      textarea.addEventListener('input', () => {
        cell.source = textarea.value;
        markDirty();
        fitCodeTextarea(textarea);
        // The output cache key changes with the source; clear the stale output.
        const outputEl = textarea.parentElement?.querySelector<HTMLElement>('[data-nb-output]');
        if (outputEl) outputEl.innerHTML = '';
      });
      textarea.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || !(event.shiftKey || event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        void runCell(cell, index);
      });
    });
    host.querySelectorAll<HTMLTextAreaElement>('[data-nb-code]').forEach(fitCodeTextarea);
    host.querySelectorAll<HTMLButtonElement>('[data-nb-run]').forEach(button => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.nbRun);
        const cell = parsed?.cells[index];
        if (cell?.kind === 'code') void runCell(cell, index);
      });
    });
    host.querySelectorAll<HTMLButtonElement>('[data-nb-insert]').forEach(button => {
      button.addEventListener('click', () => insertCell(Number(button.dataset.nbInsert)));
    });
    host.querySelectorAll<HTMLButtonElement>('[data-nb-delete]').forEach(button => {
      button.addEventListener('click', () => deleteCell(Number(button.dataset.nbDelete)));
    });
    host.querySelectorAll<HTMLButtonElement>('[data-nb-up]').forEach(button => {
      button.addEventListener('click', () => moveCell(Number(button.dataset.nbUp), -1));
    });
    host.querySelectorAll<HTMLButtonElement>('[data-nb-down]').forEach(button => {
      button.addEventListener('click', () => moveCell(Number(button.dataset.nbDown), 1));
    });
    host.querySelectorAll<HTMLButtonElement>('[data-nb-markdown-cancel]').forEach(button => {
      button.addEventListener('click', () => toggleMarkdownEdit(Number(button.dataset.nbMarkdownCancel), false));
    });
    host.querySelectorAll<HTMLButtonElement>('[data-nb-markdown-save]').forEach(button => {
      button.addEventListener('click', () => commitMarkdown(Number(button.dataset.nbMarkdownSave)));
    });
    host.querySelectorAll<HTMLElement>('[data-nb-markdown-view]').forEach(view => {
      view.addEventListener('click', event => {
        const target = event.target as Element | null;
        if (target?.closest('a')) return;
        if (window.getSelection()?.toString()) return;
        event.preventDefault();
        toggleMarkdownEdit(Number(view.dataset.nbMarkdownView), true);
      });
    });
    host.querySelectorAll<HTMLTextAreaElement>('[data-nb-markdown-input]').forEach(input => {
      const index = Number(input.dataset.nbMarkdownInput);
      const editor = input.closest<HTMLElement>('.nb-markdown-edit');
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commitMarkdown(index); }
        if (event.key === 'Escape') { event.preventDefault(); toggleMarkdownEdit(index, false); }
      });
    });
  };

  const toggleMarkdownEdit = (index: number, editing: boolean): void => {
    const edit = host.querySelector<HTMLElement>('[data-nb-markdown-edit="' + index + '"]');
    const view = host.querySelector<HTMLElement>('[data-nb-markdown-view="' + index + '"]');
    if (!edit || !view) return;
    edit.classList.toggle('hidden', !editing);
    view.classList.toggle('hidden', editing);
    if (editing) {
      const input = host.querySelector<HTMLTextAreaElement>('[data-nb-markdown-input="' + index + '"]');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  };

  const commitMarkdown = (index: number): void => {
    if (!parsed) return;
    const cell = parsed.cells[index];
    const input = host.querySelector<HTMLTextAreaElement>('[data-nb-markdown-input="' + index + '"]');
    if (cell?.kind !== 'markdown' || !input) return;
    cell.source = input.value;
    markDirty();
    renderAll();
  };

  const insertCell = (afterIndex: number): void => {
    if (!parsed) return;
    parsed.cells.splice(afterIndex + 1, 0, { kind: 'code', info: 'python exec', language: 'python', exec: true, source: '' });
    markDirty();
    renderAll();
    requestAnimationFrame(() => {
      const textarea = host.querySelector<HTMLTextAreaElement>('[data-nb-code="' + (afterIndex + 1) + '"]');
      textarea?.focus();
    });
  };

  const deleteCell = (index: number): void => {
    if (!parsed) return;
    const cell = parsed.cells[index];
    if (!cell) return;
    if (cell.kind === 'code') clearOutputs(cell, index);
    parsed.cells.splice(index, 1);
    markDirty();
    renderAll();
  };

  const moveCell = (index: number, delta: number): void => {
    if (!parsed) return;
    const target = index + delta;
    if (target < 0 || target >= parsed.cells.length) return;
    const [cell] = parsed.cells.splice(index, 1);
    if (cell) parsed.cells.splice(target, 0, cell);
    markDirty();
    renderAll();
  };

  const exportHtml = (): void => {
    if (!parsed) return;
    const body = parsed.cells.map((cell, index) => {
      if (cell.kind === 'markdown') return '<section class="md">' + renderMarkdownHtml(cell.source) + '</section>';
      const outputs = outputFor(cell, index);
      return '<section class="code"><pre>' + esc(cell.source) + '</pre><div class="out">' + renderStoredOutputsHtml(outputs) + '</div></section>';
    }).join('\n');
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(scopeName) + '</title><style>' +
      'body{font:15px/1.6 Inter,system-ui,sans-serif;color:#1f2430;max-width:900px;margin:40px auto;padding:0 20px;background:#faf8f3}' +
      '.md h1,.md h2{font-family:Georgia,serif}.code{margin:18px 0}.code pre{background:#171923;color:#e2e8f0;padding:14px;border-radius:10px;overflow:auto;font:12px/1.55 ui-monospace,Consolas,monospace}' +
      '.out img{max-width:100%}.out pre{white-space:pre-wrap;background:#fff;border:1px solid #e3ded3;border-radius:8px;padding:10px}.out iframe{width:100%;min-height:180px;border:1px solid #e3ded3;border-radius:8px}' +
      '.exec-out-error{color:#b42318}</style></head><body>' + body + '</body></html>';
    const blob = new Blob([html], { type: 'text/html' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = scopeName.replace(/\.hnb\.md$/i, '') + '.html';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 3000);
  };

  const renderAll = (): void => {
    if (!parsed) return;
    const kernelList = kernelOptions();
    host.innerHTML = '<div class="notebook-view">' +
      '<header class="nb-toolbar"><div class="nb-title"><strong data-nb-title></strong><small data-nb-path></small></div>' +
      '<div class="nb-actions">' +
      '<select class="nb-kernel" data-nb-kernel>' + (kernelList.length
        ? kernelList.map(kernel => '<option value="' + esc(kernel.id) + '"' + (kernel.id === kernelId ? ' selected' : '') + '>' + esc(kernel.label || kernel.id) + '</option>').join('')
        : '<option value="">No kernel installed</option>') + '</select>' +
      '<button type="button" class="btn tiny primary" data-nb-runall>Run all</button>' +
      '<button type="button" class="btn tiny" data-nb-stop>Stop</button>' +
      '<button type="button" class="btn tiny" data-nb-restart>Restart kernel</button>' +
      '<span class="nb-save-status" data-nb-status data-tone="idle"></span>' +
      '<button type="button" class="btn tiny" data-nb-export>Export HTML</button>' +
      '</div></header>' +
      '<main class="nb-cells">' + parsed.cells.map((cell, index) => cell.kind === 'code' ? renderCodeCell(cell, index) : renderMarkdownCell(cell, index)).join('') + '</main>' +
      '<footer class="nb-footer"><span>Shift+Enter / Ctrl+Enter run a cell · Click Markdown to edit directly · outputs cached locally</span>' +
      '<button type="button" class="btn tiny" data-nb-add-code>+ Code cell</button>' +
      '<button type="button" class="btn tiny" data-nb-add-md>+ Markdown cell</button></footer>' +
      '</div>';
    host.querySelector('[data-nb-title]')!.textContent = scopeName;
    host.querySelector('[data-nb-path]')!.textContent = file.path;
    bindCells();
    host.querySelector('[data-nb-kernel]')?.addEventListener('change', event => {
      kernelId = (event.target as HTMLSelectElement).value;
      deps.toast('Kernel: ' + kernelId, 'info');
    });
    host.querySelector('[data-nb-runall]')?.addEventListener('click', () => { void runAll(); });
    host.querySelector('[data-nb-stop]')?.addEventListener('click', () => { void stopAll(); });
    host.querySelector('[data-nb-restart]')?.addEventListener('click', () => { void restartKernel(); });
    host.querySelector('[data-nb-export]')?.addEventListener('click', exportHtml);
    host.querySelector('[data-nb-add-code]')?.addEventListener('click', () => insertCell(parsed!.cells.length - 1));
    host.querySelector('[data-nb-add-md]')?.addEventListener('click', () => {
      if (!parsed) return;
      parsed.cells.push({ kind: 'markdown', source: '' });
      markDirty();
      renderAll();
    });
    setStatus(dirty ? 'Unsaved' : 'Saved', dirty ? 'dirty' : 'saved');
  };

  const boot = async (): Promise<void> => {
    try {
      const content = await readFile();
      parsed = parseNotebook(content);
      kernels = deps.getKernels();
      kernelId = chooseKernel(kernels, parsed);
      renderAll();
    } catch (error) {
      host.innerHTML = '<div class="extension-viewer-error"><strong>Notebook failed to open</strong><small>' + esc(error instanceof Error ? error.message : String(error)) + '</small></div>';
    }
  };

  const fitAllCodeTextareas = (): void => { host.querySelectorAll<HTMLTextAreaElement>('[data-nb-code]').forEach(fitCodeTextarea); };
  let fitQueued = false;
  const codeResizeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
        if (fitQueued) return;
        fitQueued = true;
        requestAnimationFrame(() => { fitQueued = false; fitAllCodeTextareas(); });
      })
    : null;
  codeResizeObserver?.observe(host);

  const commitVisibleMarkdownOnOutsideClick = (event: PointerEvent): void => {
    const editor = host.querySelector<HTMLElement>('.nb-markdown-edit:not(.hidden)');
    if (!editor) return;
    if (editor.contains(event.target as Node)) return;
    const index = Number(editor.dataset.nbMarkdownIndex);
    if (Number.isInteger(index)) commitMarkdown(index);
  };
  document.addEventListener('pointerdown', commitVisibleMarkdownOnOutsideClick, true);
  void boot();

  return {
    dispose() {
      document.removeEventListener('pointerdown', commitVisibleMarkdownOnOutsideClick, true);
      codeResizeObserver?.disconnect();
      disposed = true;
      if (saveTimer) clearTimeout(saveTimer);
      if (dirty) void save();
      void stopAll();
    },
  };
}
