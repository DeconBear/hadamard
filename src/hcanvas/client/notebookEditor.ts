import type { EditorView } from 'codemirror';
import type { HcStoredOutput } from '../execOutputs.js';
import { renderStoredOutputsHtml } from '../execOutputs.js';
import { renderMarkdownHtml } from '../markdown.js';
import type { ComputationLanguage } from '../notebook/latexCompute.js';
import {
  normalizeNotebookVariables,
  parseNotebookVariable,
  variableValueKind,
  variableValueText,
  variablesFromEvents,
  visibleKernelEvents,
  type NotebookVariables,
  type NotebookVariableValue,
} from '../notebook/variables.js';
import { eventsToStoredOutputs, renderRuntimeEvent } from './execCell.js';
import { persistKernelOutputAssets } from './kernelOutputAssets.js';
import type { KernelDescriptor, KernelExecutionHandle, KernelManager, KernelOutputEvent, KernelScope } from './kernelManager.js';
import { htmlToMarkdown } from './markdownEditing.js';
import { sanitizeMarkdownHtml } from './markdownSanitize.js';
import { mountNotebookCodeEditor } from './notebookCodeEditor.js';
import { installNotebookRichEditing, prepareNotebookMarkdown } from './notebookRichText.js';
import { esc, genId } from './utils.js';

export interface NotebookEditorCell {
  id: string;
  kind: 'code' | 'markdown';
  source: string;
  kernelId?: string;
  language?: string;
  executable?: boolean;
  outputs?: HcStoredOutput[];
  executionCount?: number;
  stale?: boolean;
}

export interface NotebookEditorData {
  cells: NotebookEditorCell[];
  defaultKernelId?: string;
  variables?: NotebookVariables;
}

export interface NotebookEditorOptions {
  host: HTMLElement;
  title: string;
  subtitle: string;
  kernels: KernelDescriptor[];
  scope: KernelScope;
  data: NotebookEditorData;
  request<T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T>;
  getKernelManager(): KernelManager | null;
  persist(data: NotebookEditorData): Promise<void>;
  persistOutputs?(data: NotebookEditorData): void;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

export interface NotebookEditorHandle {
  dispose(): void;
  flush(): Promise<void>;
  runAll(): Promise<void>;
}

const PLAY = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.2 1.8v8.4L10 6z"/></svg>';
const STOP = '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1"/></svg>';

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function kernelForLanguage(kernels: KernelDescriptor[], language: string | undefined): KernelDescriptor | null {
  const normalized = (language || '').toLowerCase();
  return kernels.find(kernel => kernel.id.toLowerCase() === normalized || kernel.language.toLowerCase() === normalized || (kernel.defaultFor || []).some(item => item.toLowerCase() === normalized)) || null;
}

function defaultKernel(kernels: KernelDescriptor[], requested?: string): KernelDescriptor | null {
  return kernels.find(kernel => kernel.id === requested) || kernelForLanguage(kernels, 'python') || kernelForLanguage(kernels, 'octave') || kernelForLanguage(kernels, 'cpp') || kernels[0] || null;
}

function cellKernel(data: NotebookEditorData, kernels: KernelDescriptor[], cell: NotebookEditorCell): KernelDescriptor | null {
  return kernels.find(kernel => kernel.id === cell.kernelId) || kernelForLanguage(kernels, cell.language) || defaultKernel(kernels, data.defaultKernelId);
}

function kernelOptions(kernels: KernelDescriptor[], selected?: string): string {
  if (!kernels.length) return '<option value="">No kernel installed</option>';
  return kernels.map(kernel => '<option value="' + esc(kernel.id) + '"' + (kernel.id === selected ? ' selected' : '') + '>' + esc(kernel.label || kernel.language || kernel.id) + '</option>').join('');
}

function computationLanguage(kernel: KernelDescriptor | null): ComputationLanguage {
  const language = kernel?.language.toLowerCase();
  return language === 'octave' || language === 'matlab' ? 'octave' : language === 'cpp' || language === 'c++' ? 'cpp' : 'python';
}

export function mountNotebookEditor(options: NotebookEditorOptions): NotebookEditorHandle {
  const { host, data } = options;
  const kernels = options.kernels;
  const editors = new Map<string, EditorView>();
  const editVersions = new Map<string, number>();
  const running = new Map<string, { handle: KernelExecutionHandle | null; cancelRequested: boolean }>();
  let cellsAbort: AbortController | null = null;
  let disposed = false;
  let runAllActive = false;
  let executionGeneration = 0;
  let editVersion = 0;
  let savedVersion = 0;
  let saveChain: Promise<void> = Promise.resolve();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let variablePanelOpen = false;

  host.classList.add('notebook-host');
  data.variables = normalizeNotebookVariables(data.variables);
  data.cells.forEach(cell => {
    if (!cell.id) cell.id = genId('nbcell');
    if (cell.kind === 'code') cell.outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
    editVersions.set(cell.id, 0);
  });
  const selectedDefault = defaultKernel(kernels, data.defaultKernelId);
  if (selectedDefault) data.defaultKernelId = selectedDefault.id;

  host.innerHTML = '<div class="notebook-view">' +
    '<header class="nb-toolbar"><div class="nb-title"><strong>' + esc(options.title) + '</strong><small>' + esc(options.subtitle) + '</small></div>' +
    '<div class="nb-actions">' +
    '<select class="nb-kernel" data-nb-default-kernel aria-label="Default kernel for new cells" title="Default kernel for new cells">' + kernelOptions(kernels, data.defaultKernelId) + '</select>' +
    '<button type="button" class="btn tiny primary nb-run-all" data-nb-runall>' + PLAY + '<span>Run all</span></button>' +
    '<button type="button" class="btn tiny nb-tool-icon" data-nb-stop title="Stop all executions" aria-label="Stop all executions">' + STOP + '</button>' +
    '<button type="button" class="btn tiny" data-nb-restart title="Restart kernels; shared variables are preserved">Restart</button>' +
    '<button type="button" class="btn tiny nb-variables-toggle" data-nb-variables aria-expanded="false">Variables <span data-nb-variable-count></span></button>' +
    '<span class="nb-save-status" data-nb-status data-tone="saved" title="Changes save automatically">Auto-save</span>' +
    '<button type="button" class="btn tiny nb-tool-icon" data-nb-export title="Export HTML" aria-label="Export HTML"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1v9m-3-3 3 3 3-3M3 10v4h10v-4"/></svg></button>' +
    '</div></header>' +
    '<section class="nb-variable-panel hidden" data-nb-variable-panel aria-label="Shared variables"></section>' +
    '<main class="nb-cells" data-nb-cells></main>' +
    '<footer class="nb-footer"><span>Shift+Enter run · Alt+Enter add code below · click a formula or image to edit</span><button type="button" data-nb-add-code>+ Code</button><button type="button" data-nb-add-md>+ Markdown</button></footer>' +
    '</div>';
  const cellsHost = host.querySelector<HTMLElement>('[data-nb-cells]')!;
  const variablePanel = host.querySelector<HTMLElement>('[data-nb-variable-panel]')!;

  const status = (text: string, tone = 'idle'): void => {
    const element = host.querySelector<HTMLElement>('[data-nb-status]');
    if (element && !disposed) { element.textContent = text; element.dataset.tone = tone; }
  };
  const syncMarkdownSources = (): void => {
    host.querySelectorAll<HTMLElement>('[data-nb-markdown-view]').forEach(view => {
      const cell = data.cells.find(item => item.id === view.dataset.nbMarkdownView && item.kind === 'markdown');
      if (!cell) return;
      cell.source = view.querySelector('.nb-md-placeholder') ? '' : htmlToMarkdown(view).trim();
    });
  };
  const flush = (): Promise<void> => {
    if (editVersion === savedVersion) return saveChain;
    syncMarkdownSources();
    const targetVersion = editVersion;
    const snapshot = copy(data);
    status('Saving…', 'saving');
    saveChain = saveChain.then(async () => {
      if (savedVersion >= targetVersion) return;
      try {
        await options.persist(snapshot);
        savedVersion = targetVersion;
        status(savedVersion === editVersion ? 'Auto-save' : 'Saving…', savedVersion === editVersion ? 'saved' : 'saving');
      } catch (error) {
        status('Save failed · edit to retry', 'error');
        options.toast(error instanceof Error ? error.message : String(error), 'error');
      }
    });
    return saveChain;
  };
  const markDirty = (): void => {
    editVersion += 1;
    status('Editing…', 'dirty');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void flush(); }, 650);
  };
  const updateVariableCount = (): void => {
    const count = host.querySelector<HTMLElement>('[data-nb-variable-count]');
    if (count) count.textContent = String(Object.keys(data.variables || {}).length);
  };
  const renderVariables = (): void => {
    updateVariableCount();
    if (!variablePanelOpen) return;
    const variables = data.variables || {};
    const rows = Object.entries(variables).map(([name, value]) => '<div class="nb-variable-row" data-nb-variable-row="' + esc(name) + '">' +
      '<input class="nb-variable-name" data-nb-variable-name value="' + esc(name) + '" aria-label="Variable name">' +
      '<input class="nb-variable-value" data-nb-variable-value value="' + esc(variableValueText(value)) + '" aria-label="Value of ' + esc(name) + '" spellcheck="false">' +
      '<span class="nb-variable-kind">' + esc(variableValueKind(value)) + '</span>' +
      '<button type="button" class="nb-icon-btn danger" data-nb-variable-delete="' + esc(name) + '" title="Remove shared variable" aria-label="Remove ' + esc(name) + '">×</button></div>').join('');
    variablePanel.innerHTML = '<div class="nb-variable-intro"><div><strong>Shared variables</strong><small>Explicit JSON values available to Python, Octave and C++. Use names directly and publish changes with <code>hc_set("name", value)</code>.</small></div><span>Kernel restarts preserve these values</span></div>' +
      '<div class="nb-variable-head"><span>Name</span><span>Value / JSON</span><span>Type</span><span></span></div>' +
      (rows || '<p class="nb-variable-empty">No shared variables yet. Add one below, or call <code>hc_set("answer", 42)</code> in a code cell.</p>') +
      '<div class="nb-variable-add"><input data-nb-new-name placeholder="distance" aria-label="New variable name" spellcheck="false"><input data-nb-new-value placeholder="120.5" aria-label="New variable value" spellcheck="false"><button type="button" class="btn tiny" data-nb-variable-add>Add variable</button></div>';
  };
  const cellElement = (id: string): HTMLElement | null => cellsHost.querySelector<HTMLElement>('[data-nb-cell="' + CSS.escape(id) + '"]');
  const setCellStatus = (id: string, text: string, tone = 'idle'): void => {
    const element = cellElement(id)?.querySelector<HTMLElement>('[data-nb-cell-status]');
    if (element) { element.textContent = text; element.dataset.tone = tone; }
    cellElement(id)?.classList.toggle('nb-cell-running', tone === 'running' || tone === 'queued');
  };
  const refreshOutput = (cell: NotebookEditorCell): void => {
    const output = cellElement(cell.id)?.querySelector<HTMLElement>('[data-nb-output]');
    if (!output) return;
    const outputs = cell.outputs || [];
    output.innerHTML = outputs.length ? '<div class="nb-output-caption"><span>' + (cell.stale ? 'Output from an earlier source · run again to refresh' : 'Output') + '</span><button type="button" data-nb-clear="' + esc(cell.id) + '" title="Clear output" aria-label="Clear output">×</button></div><div class="nb-output-content">' + renderStoredOutputsHtml(outputs) + '</div>' : '';
    output.classList.toggle('nb-output-stale', cell.stale === true);
  };

  const updateVariables = (events: KernelOutputEvent[]): boolean => {
    const next = variablesFromEvents(events);
    if (!Object.keys(next).length) return false;
    const merged = { ...(data.variables || {}), ...next };
    if (JSON.stringify(merged) === JSON.stringify(data.variables)) return false;
    data.variables = merged;
    renderVariables();
    markDirty();
    return true;
  };

  const runCell = async (cell: NotebookEditorCell): Promise<void> => {
    if (disposed || cell.kind !== 'code' || cell.executable === false || running.has(cell.id)) return;
    const manager = options.getKernelManager();
    if (!manager) { options.toast('Kernel runtime is not available.', 'error'); return; }
    const kernel = cellKernel(data, kernels, cell);
    if (!kernel) { options.toast('Install and enable a Python, Octave or C++ kernel extension first.', 'info'); return; }
    if (cell.kernelId !== kernel.id) { cell.kernelId = kernel.id; markDirty(); }
    const source = cell.source;
    const version = editVersions.get(cell.id) || 0;
    const state = { handle: null as KernelExecutionHandle | null, cancelRequested: false };
    running.set(cell.id, state);
    cell.outputs = [];
    cell.stale = false;
    refreshOutput(cell);
    const liveOutput = cellElement(cell.id)?.querySelector<HTMLElement>('[data-nb-output]');
    if (liveOutput) liveOutput.innerHTML = '<div class="nb-output-content"></div>';
    setCellStatus(cell.id, 'Starting…', 'queued');
    try {
      const handle = await manager.execute(kernel.id, source, { scope: options.scope, cellId: cell.id, variables: data.variables });
      state.handle = handle;
      if (state.cancelRequested) void handle.cancel();
      setCellStatus(cell.id, 'Running', 'running');
      handle.onOutput(event => {
        if (event.kind === 'display' || event.kind === 'result') updateVariables([event]);
        if (disposed) return;
        const output = cellElement(cell.id)?.querySelector<HTMLElement>('[data-nb-output-content]');
        const visible = visibleKernelEvents([event]);
        if (output && visible.length) renderRuntimeEvent(output, visible[0]!);
      });
      const result = await handle.done;
      updateVariables(result.outputs);
      const visible = visibleKernelEvents(result.outputs);
      const stored = eventsToStoredOutputs(visible);
      cell.outputs = await persistKernelOutputAssets(stored, { sessionId: handle.sessionId, executionId: handle.executionId }, options);
      cell.stale = (editVersions.get(cell.id) || 0) !== version;
      cell.executionCount = (cell.executionCount || 0) + 1;
      const count = cellElement(cell.id)?.querySelector<HTMLElement>('[data-nb-execution-count]');
      if (count) count.textContent = '[' + cell.executionCount + ']';
      setCellStatus(cell.id, result.status === 'ok' ? (result.durationMs !== undefined ? (result.durationMs / 1000).toFixed(1) + 's' : 'Done') : result.status, result.status === 'ok' ? 'ok' : 'error');
      refreshOutput(cell);
      options.persistOutputs?.(data);
      markDirty();
      if (result.status === 'error') options.toast('Cell failed. See the error output below the cell.', 'error');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cell.outputs = [{ id: 'runtime_' + Date.now().toString(36), kind: 'error', ename: 'NotebookRuntimeError', evalue: message, traceback: [] }];
      setCellStatus(cell.id, 'Failed', 'error');
      refreshOutput(cell);
      markDirty();
      options.persistOutputs?.(data);
      options.toast(message, 'error');
    } finally {
      running.delete(cell.id);
    }
  };

  const stopAll = async (): Promise<void> => {
    executionGeneration += 1;
    for (const state of running.values()) {
      state.cancelRequested = true;
      if (state.handle) await state.handle.cancel().catch(() => undefined);
    }
  };
  const runAll = async (): Promise<void> => {
    if (runAllActive || disposed) return;
    runAllActive = true;
    const generation = executionGeneration;
    host.querySelector<HTMLButtonElement>('[data-nb-runall]')?.setAttribute('disabled', '');
    try {
      for (const cell of data.cells) {
        if (disposed || generation !== executionGeneration) break;
        if (cell.kind === 'code' && cell.executable !== false) await runCell(cell);
      }
    } finally {
      runAllActive = false;
      host.querySelector<HTMLButtonElement>('[data-nb-runall]')?.removeAttribute('disabled');
    }
  };
  const restartKernels = async (): Promise<void> => {
    const manager = options.getKernelManager();
    if (!manager) return;
    await stopAll();
    const ids = new Set(data.cells.filter(cell => cell.kind === 'code').map(cell => cellKernel(data, kernels, cell)?.id).filter((id): id is string => Boolean(id)));
    try {
      for (const id of ids) await manager.restart(id, options.scope);
      options.toast('Kernels restarted. Shared variables will be restored on the next run.', 'success');
    } catch (error) { options.toast(error instanceof Error ? error.message : String(error), 'error'); }
  };

  const commitMarkdown = (view: HTMLElement): void => {
    const id = view.dataset.nbMarkdownView || '';
    const cell = data.cells.find(item => item.id === id && item.kind === 'markdown');
    if (!cell) return;
    const source = view.querySelector('.nb-md-placeholder') ? '' : htmlToMarkdown(view).trim();
    if (source === cell.source) return;
    cell.source = source;
    markDirty();
  };
  const insertCell = (index: number, kind: 'code' | 'markdown', source = '', language?: ComputationLanguage): void => {
    const kernel = language ? kernelForLanguage(kernels, language) : defaultKernel(kernels, data.defaultKernelId);
    const cell: NotebookEditorCell = {
      id: genId('nbcell'), kind, source,
      ...(kind === 'code' ? { executable: true, outputs: [], ...(kernel ? { kernelId: kernel.id, language: kernel.language } : {}) } : {}),
    };
    data.cells.splice(Math.max(0, Math.min(data.cells.length, index)), 0, cell);
    editVersions.set(cell.id, 0);
    markDirty();
    renderCells();
    requestAnimationFrame(() => {
      if (kind === 'code') editors.get(cell.id)?.focus();
      else cellElement(cell.id)?.querySelector<HTMLElement>('[data-nb-markdown-view]')?.focus();
    });
  };
  const moveCell = (id: string, delta: number): void => {
    const index = data.cells.findIndex(cell => cell.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= data.cells.length) return;
    const [cell] = data.cells.splice(index, 1);
    if (cell) data.cells.splice(target, 0, cell);
    markDirty();
    renderCells();
    cellElement(id)?.scrollIntoView({ block: 'nearest' });
  };
  const deleteCell = (id: string): void => {
    const index = data.cells.findIndex(cell => cell.id === id);
    if (index < 0) return;
    const state = running.get(id);
    if (state) { state.cancelRequested = true; void state.handle?.cancel(); }
    data.cells.splice(index, 1);
    markDirty();
    renderCells();
  };
  const exportHtml = (): void => {
    syncMarkdownSources();
    const body = data.cells.map(cell => {
      if (cell.kind === 'markdown') return '<section class="md">' + sanitizeMarkdownHtml(renderMarkdownHtml(cell.source)) + '</section>';
      const kernel = cellKernel(data, kernels, cell);
      return '<section class="code"><div class="cell-kernel">' + esc(kernel?.label || cell.language || 'code') + '</div><pre>' + esc(cell.source) + '</pre><div class="out">' + (cell.outputs?.length ? renderStoredOutputsHtml(cell.outputs) : '') + '</div></section>';
    }).join('\n');
    const variables = Object.keys(data.variables || {}).length ? '<details><summary>Shared variables</summary><pre>' + esc(JSON.stringify(data.variables, null, 2)) + '</pre></details>' : '';
    const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(options.title) + '</title><style>' +
      'body{font:15px/1.65 Inter,system-ui,sans-serif;color:#252b36;max-width:900px;margin:40px auto;padding:0 24px;background:#faf8f3}.md h1,.md h2{font-family:Georgia,serif}.code{margin:20px 0}.cell-kernel{font:10px Inter,sans-serif;color:#8a8276;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}.code>pre{background:#181b23;color:#e6e9f0;padding:16px;border-radius:12px;overflow:auto;font:12.5px/1.6 ui-monospace,Consolas,monospace}.out img,section img{max-width:100%;height:auto}.out pre{white-space:pre-wrap;background:#fff;border:1px solid #e3ded3;border-radius:8px;padding:10px}.out iframe{width:100%;min-height:180px;border:1px solid #e3ded3;border-radius:8px}.exec-out-error{color:#b42318}details{margin:28px 0}details pre{white-space:pre-wrap}</style></head><body>' + body + variables + '</body></html>';
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = options.title.replace(/\.hnb\.md$/iu, '').replace(/[\\/:*?"<>|]+/g, '-') + '.html';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  };

  function renderCodeCell(cell: NotebookEditorCell, index: number): string {
    const kernel = cellKernel(data, kernels, cell);
    const executable = cell.executable !== false;
    return '<section class="nb-cell nb-code' + (cell.stale ? ' nb-code-stale' : '') + '" data-nb-cell="' + esc(cell.id) + '">' +
      '<div class="nb-cell-rail"><button type="button" class="nb-run-btn" title="Run cell (Shift+Enter)" aria-label="Run cell" data-nb-run="' + esc(cell.id) + '"' + (!executable ? ' disabled' : '') + '>' + PLAY + '</button><span class="nb-execution-count" data-nb-execution-count>[' + (cell.executionCount || ' ') + ']</span></div>' +
      '<div class="nb-cell-content"><header class="nb-cell-head"><select class="nb-cell-kernel" data-nb-cell-kernel="' + esc(cell.id) + '" aria-label="Cell kernel">' + kernelOptions(kernels, kernel?.id) + '</select>' +
      '<span class="nb-cell-status" data-nb-cell-status data-tone="idle">' + (executable ? '' : 'Read-only code fence') + '</span>' +
      '<span class="nb-cell-actions"><button type="button" class="nb-icon-btn" title="Add code below" data-nb-insert-code="' + esc(cell.id) + '">+</button><button type="button" class="nb-icon-btn" title="Move up" data-nb-up="' + esc(cell.id) + '"' + (index === 0 ? ' disabled' : '') + '>↑</button><button type="button" class="nb-icon-btn" title="Move down" data-nb-down="' + esc(cell.id) + '"' + (index === data.cells.length - 1 ? ' disabled' : '') + '>↓</button><button type="button" class="nb-icon-btn danger" title="Delete cell" data-nb-delete="' + esc(cell.id) + '">×</button></span></header>' +
      '<div class="nb-code-input" data-nb-code="' + esc(cell.id) + '"></div><div class="nb-output' + (cell.stale ? ' nb-output-stale' : '') + '" data-nb-output></div></div></section>';
  }

  function renderMarkdownCell(cell: NotebookEditorCell, index: number): string {
    const preview = cell.source.trim() ? sanitizeMarkdownHtml(renderMarkdownHtml(cell.source)) : '<p class="nb-md-placeholder">Write Markdown, $E=mc^2$, or paste an image URL…</p>';
    return '<section class="nb-cell nb-markdown" data-nb-cell="' + esc(cell.id) + '"><div class="nb-markdown-rail"><span>MD</span></div>' +
      '<div class="nb-markdown-body" contenteditable="true" spellcheck="true" role="textbox" aria-multiline="true" aria-label="Markdown cell" data-nb-markdown-view="' + esc(cell.id) + '">' + preview + '</div>' +
      '<div class="nb-markdown-hover-actions"><button type="button" class="nb-icon-btn" title="Add code below" data-nb-insert-code="' + esc(cell.id) + '">+</button><button type="button" class="nb-icon-btn" title="Move up" data-nb-up="' + esc(cell.id) + '"' + (index === 0 ? ' disabled' : '') + '>↑</button><button type="button" class="nb-icon-btn" title="Move down" data-nb-down="' + esc(cell.id) + '"' + (index === data.cells.length - 1 ? ' disabled' : '') + '>↓</button><button type="button" class="nb-icon-btn danger" title="Delete cell" data-nb-delete="' + esc(cell.id) + '">×</button></div></section>';
  }

  function bindMarkdown(view: HTMLElement, signal: AbortSignal): void {
    prepareNotebookMarkdown(view);
    const cell = data.cells.find(item => item.id === view.dataset.nbMarkdownView && item.kind === 'markdown');
    if (!cell) return;
    view.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => { input.disabled = false; });
    view.addEventListener('focus', () => { if (view.querySelector('.nb-md-placeholder')) view.innerHTML = ''; }, { signal });
    view.addEventListener('input', () => markDirty(), { signal });
    view.addEventListener('paste', event => {
      const html = event.clipboardData?.getData('text/html');
      if (!html) return;
      event.preventDefault();
      document.execCommand('insertHTML', false, sanitizeMarkdownHtml(html));
    }, { signal });
    view.addEventListener('blur', () => {
      commitMarkdown(view);
      if (!cell.source.trim()) view.innerHTML = '<p class="nb-md-placeholder">Write Markdown, $E=mc^2$, or paste an image URL…</p>';
    }, { signal });
    view.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); view.blur(); }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); view.blur(); }
    }, { signal });
    view.addEventListener('click', event => {
      const anchor = (event.target as Element | null)?.closest('a');
      if (anchor && !event.ctrlKey && !event.metaKey) event.preventDefault();
    }, { signal });
  }

  function renderCells(): void {
    if (disposed) return;
    cellsAbort?.abort();
    cellsAbort = new AbortController();
    const signal = cellsAbort.signal;
    for (const editor of editors.values()) editor.destroy();
    editors.clear();
    cellsHost.innerHTML = data.cells.map((cell, index) => cell.kind === 'code' ? renderCodeCell(cell, index) : renderMarkdownCell(cell, index)).join('') +
      '<button type="button" class="nb-end-add" data-nb-end-add>+ Add a cell</button>';
    for (const cell of data.cells) {
      if (cell.kind !== 'code') {
        const view = cellsHost.querySelector<HTMLElement>('[data-nb-markdown-view="' + CSS.escape(cell.id) + '"]');
        if (view) bindMarkdown(view, signal);
        continue;
      }
      const container = cellsHost.querySelector<HTMLElement>('[data-nb-code="' + CSS.escape(cell.id) + '"]');
      if (!container) continue;
      const kernel = cellKernel(data, kernels, cell);
      const editor = mountNotebookCodeEditor({
        parent: container, source: cell.source, language: kernel?.language || cell.language || 'text', readOnly: cell.executable === false,
        onChange: source => {
          cell.source = source;
          editVersions.set(cell.id, (editVersions.get(cell.id) || 0) + 1);
          if (cell.outputs?.length) { cell.stale = true; cellElement(cell.id)?.classList.add('nb-code-stale'); }
          const caption = cellElement(cell.id)?.querySelector<HTMLElement>('.nb-output-caption > span');
          if (caption && cell.stale) caption.textContent = 'Output from an earlier source · run again to refresh';
          markDirty();
        },
        onRun: () => { void runCell(cell); },
        onInsert: () => insertCell(data.cells.findIndex(item => item.id === cell.id) + 1, 'code'),
        onFocus: () => {
          cellsHost.querySelectorAll('.nb-cell-active').forEach(element => element.classList.remove('nb-cell-active'));
          cellElement(cell.id)?.classList.add('nb-cell-active');
        },
      });
      editors.set(cell.id, editor);
      refreshOutput(cell);
    }
  }

  cellsHost.addEventListener('click', event => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button');
    if (!button) return;
    if (button.dataset.nbRun) {
      const cell = data.cells.find(item => item.id === button.dataset.nbRun);
      if (cell) void runCell(cell);
    } else if (button.dataset.nbDelete) deleteCell(button.dataset.nbDelete);
    else if (button.dataset.nbUp) moveCell(button.dataset.nbUp, -1);
    else if (button.dataset.nbDown) moveCell(button.dataset.nbDown, 1);
    else if (button.dataset.nbInsertCode) insertCell(data.cells.findIndex(cell => cell.id === button.dataset.nbInsertCode) + 1, 'code');
    else if (button.dataset.nbClear) {
      const cell = data.cells.find(item => item.id === button.dataset.nbClear);
      if (cell) { cell.outputs = []; cell.stale = false; refreshOutput(cell); markDirty(); options.persistOutputs?.(data); }
    } else if (button.hasAttribute('data-nb-end-add')) insertCell(data.cells.length, 'code');
  });
  cellsHost.addEventListener('change', event => {
    const select = (event.target as Element | null)?.closest<HTMLSelectElement>('[data-nb-cell-kernel]');
    if (!select) return;
    const cell = data.cells.find(item => item.id === select.dataset.nbCellKernel);
    const kernel = kernels.find(item => item.id === select.value);
    if (!cell || !kernel) return;
    cell.kernelId = kernel.id;
    cell.language = kernel.language;
    if (cell.outputs?.length) cell.stale = true;
    markDirty();
    renderCells();
    requestAnimationFrame(() => editors.get(cell.id)?.focus());
  });
  host.querySelector('[data-nb-runall]')?.addEventListener('click', () => { void runAll(); });
  host.querySelector('[data-nb-stop]')?.addEventListener('click', () => { void stopAll(); });
  host.querySelector('[data-nb-restart]')?.addEventListener('click', () => { void restartKernels(); });
  host.querySelector('[data-nb-export]')?.addEventListener('click', exportHtml);
  host.querySelector('[data-nb-add-code]')?.addEventListener('click', () => insertCell(data.cells.length, 'code'));
  host.querySelector('[data-nb-add-md]')?.addEventListener('click', () => insertCell(data.cells.length, 'markdown'));
  host.querySelector<HTMLSelectElement>('[data-nb-default-kernel]')?.addEventListener('change', event => {
    data.defaultKernelId = (event.target as HTMLSelectElement).value;
    markDirty();
  });
  host.querySelector('[data-nb-variables]')?.addEventListener('click', () => {
    variablePanelOpen = !variablePanelOpen;
    variablePanel.classList.toggle('hidden', !variablePanelOpen);
    host.querySelector('[data-nb-variables]')?.setAttribute('aria-expanded', String(variablePanelOpen));
    renderVariables();
  });
  variablePanel.addEventListener('click', event => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button');
    if (!button || !data.variables) return;
    if (button.dataset.nbVariableDelete) {
      delete data.variables[button.dataset.nbVariableDelete];
      markDirty();
      renderVariables();
    } else if (button.hasAttribute('data-nb-variable-add')) {
      const name = variablePanel.querySelector<HTMLInputElement>('[data-nb-new-name]')!;
      const value = variablePanel.querySelector<HTMLInputElement>('[data-nb-new-value]')!;
      try {
        data.variables[name.value.trim()] = parseNotebookVariable(name.value, value.value);
        markDirty();
        renderVariables();
        variablePanel.querySelector<HTMLInputElement>('[data-nb-new-name]')?.focus();
      } catch (error) { options.toast(error instanceof Error ? error.message : String(error), 'error'); }
    }
  });
  variablePanel.addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    const row = input.closest<HTMLElement>('[data-nb-variable-row]');
    if (!row || !data.variables) return;
    const oldName = row.dataset.nbVariableRow || '';
    const nameInput = row.querySelector<HTMLInputElement>('[data-nb-variable-name]')!;
    const valueInput = row.querySelector<HTMLInputElement>('[data-nb-variable-value]')!;
    try {
      const next: NotebookVariableValue = parseNotebookVariable(nameInput.value, valueInput.value);
      const name = nameInput.value.trim();
      if (name !== oldName) delete data.variables[oldName];
      data.variables[name] = next;
      markDirty();
      renderVariables();
    } catch (error) {
      options.toast(error instanceof Error ? error.message : String(error), 'error');
      renderVariables();
    }
  });
  const disposeRichEditing = installNotebookRichEditing({
    root: cellsHost,
    getVariables: () => data.variables || {},
    getKernelLanguage: () => computationLanguage(defaultKernel(kernels, data.defaultKernelId)),
    insertCalculation: (source, markdownId) => {
      const index = data.cells.findIndex(cell => cell.id === markdownId);
      insertCell(index < 0 ? data.cells.length : index + 1, 'code', source, computationLanguage(defaultKernel(kernels, data.defaultKernelId)));
    },
    commit: commitMarkdown,
    toast: options.toast,
  });
  const onWindowMessage = (event: MessageEvent): void => {
    if (!event.data || event.data.hcOutputResize !== 1 || typeof event.data.height !== 'number') return;
    host.querySelectorAll<HTMLIFrameElement>('.exec-out-html').forEach(frame => {
      if (frame.contentWindow === event.source) frame.style.height = Math.max(80, Math.min(900, event.data.height + 8)) + 'px';
    });
  };
  window.addEventListener('message', onWindowMessage);
  renderVariables();
  renderCells();

  return {
    flush,
    runAll,
    dispose() {
      if (disposed) return;
      host.querySelectorAll<HTMLElement>('[data-nb-markdown-view]').forEach(commitMarkdown);
      if (saveTimer) clearTimeout(saveTimer);
      const pendingSave = flush();
      disposed = true;
      cellsAbort?.abort();
      disposeRichEditing();
      window.removeEventListener('message', onWindowMessage);
      for (const editor of editors.values()) editor.destroy();
      editors.clear();
      void stopAll();
      void pendingSave;
    },
  };
}
