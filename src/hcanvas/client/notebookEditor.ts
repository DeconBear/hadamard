import type { EditorView } from 'codemirror';
import { renderStoredOutputsHtml } from '../execOutputs.js';
import { renderMarkdownHtml } from '../markdown.js';
import type { ComputationLanguage } from '../notebook/latexCompute.js';
import { affectedCellIds } from '../notebook/cellDependencies.js';
import { moveCodeCellToMarkdown } from '../notebook/cellMove.js';
import { installNotebookCellDragAndDrop } from './notebookCellDragAndDrop.js';
import { renderNotebookCodeCell, renderNotebookMarkdownCell } from './notebookCellMarkup.js';
import { exportNotebookHtml, exportNotebookIpynb } from './notebookExport.js';
import { renderNotebookTaskPanel } from './notebookTaskPanel.js';
import { notebookVariableNames, renderNotebookVariablesPanel } from './notebookVariablesPanel.js';
import { parseVariablesCsv, parseVariablesJson, serializeVariablesJson } from '../notebook/variablesImport.js';
import { NotebookUndoHistory } from '../notebook/undo.js';
import type { NotebookRunMode } from './notebookCodeEditor.js';
import type { NotebookEditorCell, NotebookEditorData } from '../notebook/types.js';
import {
  initializeNotebookVariables,
  normalizeNotebookVariableState,
  parseNotebookVariable,
  variablesFromEvents,
  visibleKernelEvents,
  type NotebookVariables,
  type NotebookVariableValue,
} from '../notebook/variables.js';
import { renderRuntimeEvent } from './execCell.js';
import { notebookExecutionCenter, type NotebookExecutionTask } from './notebookExecutionCenter.js';
import type { KernelDescriptor, KernelManager, KernelOutputEvent, KernelScope } from './kernelManager.js';
import { htmlToMarkdown } from './markdownEditing.js';
import { sanitizeMarkdownHtml } from './markdownSanitize.js';
import { mountNotebookCodeEditor } from './notebookCodeEditor.js';
import { installNotebookRichEditing, prepareNotebookMarkdown } from './notebookRichText.js';
import { esc, genId } from './utils.js';

export type { NotebookEditorCell, NotebookEditorData } from '../notebook/types.js';

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
  const markdownRevisions = new Map<string, number>();
  const undoHistory = new NotebookUndoHistory(20);
  const selectedCellIds = new Set<string>();
  let activeCellId = data.cells[0]?.id || '';
  let commandMode = false;
  let changeCellId = '';
  let deleteChord = false;
  const running = new Map<string, NotebookExecutionTask>();
  const subscriptions = new Map<string, () => void>();
  const taskWaits = new Map<string, { resolve: () => void; task: NotebookExecutionTask; promise: Promise<void> }>();
  let taskPanelOpen = false;
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
  normalizeNotebookVariableState(data);
  data.cells.forEach(cell => {
    if (!cell.id) cell.id = genId('nbcell');
    if (cell.kind === 'code') cell.outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
  });
  const selectedDefault = defaultKernel(kernels, data.defaultKernelId);
  if (selectedDefault) data.defaultKernelId = selectedDefault.id;

  host.innerHTML = '<div class="notebook-view">' +
    '<header class="nb-toolbar"><div class="nb-title"><strong>' + esc(options.title) + '</strong><small>' + esc(options.subtitle) + '</small></div>' +
    '<div class="nb-actions">' +
    '<select class="nb-kernel" data-nb-default-kernel aria-label="Default kernel for new cells" title="Default kernel for new cells">' + kernelOptions(kernels, data.defaultKernelId) + '</select>' +
    '<button type="button" class="btn tiny primary nb-run-all" data-nb-runall>' + PLAY + '<span>Run all</span></button>' +
    '<button type="button" class="btn tiny" data-nb-run-selected>Run selected</button>' +
    '<button type="button" class="btn tiny" data-nb-run-affected title="Run cells affected by source or variable changes" disabled>Run affected</button>' +
    '<select class="nb-kernel nb-run-scope" data-nb-run-scope aria-label="Run range" title="Run range"><option value="">More run…</option><option value="above">Run above</option><option value="below">Run below</option><option value="changed">Run changed</option><option value="restart">Restart &amp; Run all</option></select>' +
    '<button type="button" class="btn tiny nb-tool-icon" data-nb-stop title="Stop all executions" aria-label="Stop all executions">' + STOP + '</button>' +
    '<button type="button" class="btn tiny" data-nb-restart title="Restart kernels; shared variables are preserved">Restart</button>' +
    '<button type="button" class="btn tiny nb-variables-toggle" data-nb-variables aria-expanded="false">Variables <span data-nb-variable-count></span></button>' +
    '<button type="button" class="btn tiny nb-variables-toggle" data-nb-tasks aria-expanded="false">Tasks <span data-nb-task-count></span></button>' +
    '<span class="nb-save-status" data-nb-status data-tone="saved" title="Changes save automatically">Auto-save</span>' +
    '<button type="button" class="btn tiny nb-tool-icon" data-nb-export title="Export HTML" aria-label="Export HTML"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1v9m-3-3 3 3 3-3M3 10v4h10v-4"/></svg></button>' +
    '<button type="button" class="btn tiny" data-nb-export-ipynb title="Export Jupyter notebook" aria-label="Export Jupyter notebook">ipynb</button>' +
    '</div></header>' +
    '<section class="nb-variable-panel hidden" data-nb-variable-panel aria-label="Shared variables"></section>' +
    '<section class="nb-task-panel hidden" data-nb-task-panel aria-label="Notebook executions"></section>' +
    '<main class="nb-cells" data-nb-cells></main>' +
    '<footer class="nb-footer"><span>Shift+Enter run · Alt+Enter add code · Ctrl+↑↓ move cell · click a formula or image to edit</span><button type="button" data-nb-add-code>+ Code</button><button type="button" data-nb-add-md>+ Markdown</button></footer>' +
    '</div>';
  const cellsHost = host.querySelector<HTMLElement>('[data-nb-cells]')!;
  const variablePanel = host.querySelector<HTMLElement>('[data-nb-variable-panel]')!;
  const taskPanel = host.querySelector<HTMLElement>('[data-nb-task-panel]')!;

  const status = (text: string, tone = 'idle'): void => {
    const element = host.querySelector<HTMLElement>('[data-nb-status]');
    if (element && !disposed) { element.textContent = text; element.dataset.tone = tone; }
  };
  const touchMarkdown = (id: string): void => {
    markdownRevisions.set(id, (markdownRevisions.get(id) || 0) + 1);
  };
  const syncMarkdownSources = (): Map<string, number> => {
    const saved = new Map<string, number>();
    host.querySelectorAll<HTMLElement>('[data-nb-markdown-view]').forEach(view => {
      const id = view.dataset.nbMarkdownView || '';
      const revision = markdownRevisions.get(id) || 0;
      if (!revision) return;
      const cell = data.cells.find(item => item.id === id && item.kind === 'markdown');
      if (!cell) return;
      cell.source = view.querySelector('[data-nb-generated-placeholder]') ? '' : htmlToMarkdown(view).trim();
      saved.set(id, revision);
    });
    return saved;
  };
  const flush = (): Promise<void> => {
    if (editVersion === savedVersion) return saveChain;
    const markdownSaved = syncMarkdownSources();
    const targetVersion = editVersion;
    const snapshot = copy(data);
    status('Saving…', 'saving');
    saveChain = saveChain.then(async () => {
      if (savedVersion >= targetVersion) return;
      try {
        await options.persist(snapshot);
        savedVersion = targetVersion;
        for (const [id, revision] of markdownSaved) {
          if (markdownRevisions.get(id) === revision) markdownRevisions.set(id, 0);
        }
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
    if (count) count.textContent = String(notebookVariableNames(data).length);
  };
  const renderVariables = (): void => {
    updateVariableCount();
    if (variablePanelOpen) variablePanel.innerHTML = renderNotebookVariablesPanel(data);
  };
  const cellElement = (id: string): HTMLElement | null => cellsHost.querySelector<HTMLElement>('[data-nb-cell="' + CSS.escape(id) + '"]');
  const pushUndo = (): void => { undoHistory.capture(data.cells, data.variables || {}, data.initialVariables || {}, data.variablesInitialized === true); };
  const syncSelection = (): void => {
    cellsHost.querySelectorAll<HTMLElement>('[data-nb-cell]').forEach(section => {
      const selected = selectedCellIds.has(section.dataset.nbCell || '');
      section.classList.toggle('nb-cell-selected', selected);
      section.classList.toggle('nb-cell-active', (section.dataset.nbCell || '') === activeCellId);
      section.setAttribute('aria-selected', String(selected));
    });
  };
  const selectCell = (id: string, mode: 'single' | 'additive' | 'range' = 'single'): void => {
    if (!data.cells.some(cell => cell.id === id)) return;
    if (mode === 'additive') {
      if (selectedCellIds.has(id)) selectedCellIds.delete(id); else selectedCellIds.add(id);
    } else if (mode === 'range' && activeCellId) {
      const from = data.cells.findIndex(cell => cell.id === activeCellId);
      const to = data.cells.findIndex(cell => cell.id === id);
      selectedCellIds.clear();
      for (const cell of data.cells.slice(Math.min(from, to), Math.max(from, to) + 1)) selectedCellIds.add(cell.id);
    } else {
      selectedCellIds.clear();
      selectedCellIds.add(id);
    }
    activeCellId = id;
    commandMode = true;
    syncSelection();
  };
  const focusCell = (id: string, edit = false): void => {
    if (!data.cells.some(cell => cell.id === id)) return;
    if (!edit) selectCell(id);
    activeCellId = id;
    commandMode = !edit;
    cellElement(id)?.scrollIntoView({ block: 'nearest' });
    syncSelection();
    if (edit) {
      const cell = data.cells.find(item => item.id === id);
      if (cell?.kind === 'code') editors.get(id)?.focus();
      else cellElement(id)?.querySelector<HTMLElement>('[data-nb-markdown-view]')?.focus();
    } else cellElement(id)?.focus({ preventScroll: true });
  };
  const beginCellChange = (id: string): void => {
    if (changeCellId === id) return;
    pushUndo();
    changeCellId = id;
  };
  const undo = (): void => {
    const snapshot = undoHistory.restore();
    if (!snapshot) { options.toast('No notebook changes to undo.', 'info'); return; }
    data.cells = snapshot.cells;
    data.variables = snapshot.variables;
    data.initialVariables = snapshot.initialVariables;
    data.variablesInitialized = snapshot.variablesInitialized;
    activeCellId = data.cells[0]?.id || '';
    selectedCellIds.clear();
    if (activeCellId) selectedCellIds.add(activeCellId);
    changeCellId = '';
    markDirty();
    renderVariables();
    renderCells();
    syncSelection();
  };
  const setCellStatus = (id: string, text: string, tone = 'idle'): void => {
    const element = cellElement(id)?.querySelector<HTMLElement>('[data-nb-cell-status]');
    if (element) { element.textContent = text; element.dataset.tone = tone; }
    cellElement(id)?.classList.toggle('nb-cell-running', tone === 'running' || tone === 'queued');
    renderTaskPanel();
  };
  const refreshOutput = (cell: NotebookEditorCell): void => {
    const output = cellElement(cell.id)?.querySelector<HTMLElement>('[data-nb-output]');
    if (!output) return;
    const outputs = cell.outputs || [];
    output.innerHTML = outputs.length ? '<div class="nb-output-caption"><span>' + (cell.stale ? 'Output from an earlier source · run again to refresh' : 'Output') + '</span><button type="button" data-nb-clear="' + esc(cell.id) + '" title="Clear output" aria-label="Clear output">×</button></div><div class="nb-output-content">' + renderStoredOutputsHtml(outputs) + '</div>' : '';
    output.classList.toggle('nb-output-stale', cell.stale === true);
  };

  const markAffected = (changedCells: Iterable<string> = [], changedVariables: Iterable<string> = []): void => {
    const affected = affectedCellIds(data.cells, changedCells, changedVariables, { ...(data.initialVariables || {}), ...(data.variables || {}) });
    for (const cell of data.cells) {
      if (!affected.has(cell.id)) continue;
      cell.stale = true;
      cellElement(cell.id)?.classList.add('nb-code-stale');
      const caption = cellElement(cell.id)?.querySelector<HTMLElement>('.nb-output-caption > span');
      if (caption) caption.textContent = 'Dependencies changed · run affected cells to refresh';
    }
    const button = host.querySelector<HTMLButtonElement>('[data-nb-run-affected]');
    if (button) button.disabled = !affected.size;
  };

  const updateVariables = (events: KernelOutputEvent[]): boolean => {
    const next = variablesFromEvents(events);
    if (!Object.keys(next).length) return false;
    const merged = { ...(data.variables || {}), ...next };
    if (JSON.stringify(merged) === JSON.stringify(data.variables)) return false;
    data.variables = merged;
    renderVariables();
    markAffected([], Object.keys(next));
    markDirty();
    return true;
  };

  const initializeVariables = (silent = false): void => {
    pushUndo();
    markAffected([], notebookVariableNames(data));
    initializeNotebookVariables(data);
    renderVariables();
    markDirty();
    if (!silent) options.toast('Current values initialized from initial values. No cells were run.', 'success');
  };

  const renderTaskPanel = (): void => {
    renderNotebookTaskPanel(host, taskPanel, options.scope, taskPanelOpen);
  };

  const attachTask = (cell: NotebookEditorCell, task: NotebookExecutionTask, mode: NotebookRunMode = 'stay'): Promise<void> => {
    const existing = taskWaits.get(cell.id);
    if (subscriptions.has(cell.id) && existing) return existing.promise;
    let resolveWait: () => void = () => undefined;
    const promise = new Promise<void>(resolve => { resolveWait = resolve; });
    taskWaits.set(cell.id, { resolve: resolveWait, task, promise });
    running.set(cell.id, task);
    const replayed = Boolean(task.outputs);
    subscriptions.set(cell.id, () => undefined);
    setCellStatus(cell.id, task.status === 'disconnected' ? 'Reconnecting…' : task.status, task.status === 'ok' ? 'ok' : task.status === 'failed' || task.status === 'error' ? 'error' : 'running');
    if (task.outputs) {
      cell.outputs = task.outputs;
      refreshOutput(cell);
    } else {
      const output = cellElement(cell.id)?.querySelector<HTMLElement>('[data-nb-output]');
      if (output) {
        output.innerHTML = '<div class="nb-output-content"></div>';
        const content = output.querySelector<HTMLElement>('[data-nb-output-content]');
        if (content) for (const event of visibleKernelEvents(task.events)) renderRuntimeEvent(content, event);
      }
    }
    const unsubscribe = notebookExecutionCenter.subscribe(task.id, (current, event) => {
      if (event) {
        if (event.kind === 'display' || event.kind === 'result') updateVariables([event]);
        const output = cellElement(cell.id)?.querySelector<HTMLElement>('[data-nb-output-content]');
        const visible = visibleKernelEvents([event]);
        if (output && visible.length) renderRuntimeEvent(output, visible[0]!);
      }
      if (current.outputs) {
        cell.outputs = current.outputs;
        cell.stale = cell.source !== current.source;
        cell.executionCount = replayed ? Math.max(cell.executionCount || 0, 1) : (cell.executionCount || 0) + 1;
        const count = cellElement(cell.id)?.querySelector<HTMLElement>('[data-nb-execution-count]');
        if (count) count.textContent = '[' + cell.executionCount + ']';
        updateVariables(current.events);
        refreshOutput(cell);
        options.persistOutputs?.(data);
        markDirty();
        setCellStatus(cell.id, current.status === 'ok' ? (current.durationMs !== undefined ? (current.durationMs / 1000).toFixed(1) + 's' : 'Done') : current.status, current.status === 'ok' ? 'ok' : 'error');
        if (current.status === 'error' || current.status === 'failed') options.toast(current.error || 'Cell failed. See the output below the cell.', 'error');
        subscriptions.get(cell.id)?.();
        subscriptions.delete(cell.id);
        running.delete(cell.id);
        const pending = taskWaits.get(cell.id);
        taskWaits.delete(cell.id);
        pending?.resolve();
        if (!disposed && mode !== 'stay') {
          const index = data.cells.findIndex(item => item.id === cell.id);
          if (mode === 'insert') insertCell(index + 1, 'code');
          else if (data.cells[index + 1]) focusCell(data.cells[index + 1]!.id, true);
          else insertCell(index + 1, 'code');
        }
        return;
      }
      setCellStatus(cell.id, current.status === 'disconnected' ? 'Reconnecting…' : current.status, current.status === 'ok' ? 'ok' : current.status === 'failed' || current.status === 'error' ? 'error' : 'running');
    });
    if (subscriptions.has(cell.id)) subscriptions.set(cell.id, unsubscribe);
    else unsubscribe();
    return promise;
  };

  const runCell = async (cell: NotebookEditorCell, mode: NotebookRunMode = 'stay'): Promise<void> => {
    if (disposed || cell.kind !== 'code' || cell.executable === false || running.has(cell.id)) return;
    const existing = notebookExecutionCenter.getForCell(options.scope, cell.id);
    if (existing && ['queued', 'running', 'disconnected'].includes(existing.status)) {
      await attachTask(cell, existing, mode);
      return;
    }
    const manager = options.getKernelManager();
    if (!manager) { options.toast('Kernel runtime is not available.', 'error'); return; }
    const kernel = cellKernel(data, kernels, cell);
    if (!kernel) { options.toast('Install and enable a Python, Octave or C++ kernel extension first.', 'info'); return; }
    if (cell.kernelId !== kernel.id) { cell.kernelId = kernel.id; markDirty(); }
    cell.outputs = [];
    cell.stale = false;
    refreshOutput(cell);
    const task = notebookExecutionCenter.start({
      cellId: cell.id,
      notebookTitle: options.title,
      scope: options.scope,
      kernel,
      source: cell.source,
      variables: data.variables || {},
      manager,
      request: options.request,
    });
    await attachTask(cell, task, mode);
  };

  const stopCell = async (id: string): Promise<void> => {
    const task = running.get(id) || notebookExecutionCenter.getForCell(options.scope, id);
    if (task) await notebookExecutionCenter.cancel(task.id);
  };
  const stopAll = async (): Promise<void> => {
    executionGeneration += 1;
    for (const task of running.values()) await notebookExecutionCenter.cancel(task.id);
  };
  const runAll = async (): Promise<void> => {
    if (runAllActive || disposed) return;
    runAllActive = true;
    initializeVariables(true);
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
    if (!markdownRevisions.get(id)) return;
    const cell = data.cells.find(item => item.id === id && item.kind === 'markdown');
    if (!cell) return;
    const source = view.querySelector('[data-nb-generated-placeholder]') ? '' : htmlToMarkdown(view).trim();
    if (source === cell.source) return;
    cell.source = source;
    touchMarkdown(id);
    markDirty();
  };
  const insertCell = (index: number, kind: 'code' | 'markdown', source = '', language?: ComputationLanguage): void => {
    const kernel = language ? kernelForLanguage(kernels, language) : defaultKernel(kernels, data.defaultKernelId);
    const cell: NotebookEditorCell = {
      id: genId('nbcell'), kind, source,
      ...(kind === 'code' ? { executable: true, outputs: [], ...(kernel ? { kernelId: kernel.id, language: kernel.language } : {}) } : {}),
    };
    pushUndo();
    data.cells.splice(Math.max(0, Math.min(data.cells.length, index)), 0, cell);
    activeCellId = cell.id;
    selectedCellIds.clear();
    selectedCellIds.add(cell.id);
    commandMode = false;
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
    pushUndo();
    const [cell] = data.cells.splice(index, 1);
    if (cell) data.cells.splice(target, 0, cell);
    activeCellId = id;
    markDirty();
    renderCells();
    cellElement(id)?.scrollIntoView({ block: 'nearest' });
  };
  const moveCellTo = (id: string, target: number): void => {
    const index = data.cells.findIndex(cell => cell.id === id);
    if (index < 0 || index === target || target < 0 || target >= data.cells.length) return;
    pushUndo();
    const [cell] = data.cells.splice(index, 1);
    if (cell) data.cells.splice(target, 0, cell);
    activeCellId = id;
    markDirty();
    renderCells();
    cellElement(id)?.scrollIntoView({ block: 'nearest' });
  };
  const moveCodeToMarkdown = (codeId: string, markdownId: string, blockIndex: number, renderedCount: number): void => {
    if (!data.cells.some(cell => cell.id === codeId && cell.kind === 'code') || !data.cells.some(cell => cell.id === markdownId && cell.kind === 'markdown')) return;
    pushUndo();
    const result = moveCodeCellToMarkdown(data, codeId, markdownId, blockIndex, renderedCount, () => genId('nbcell'));
    if (!result.moved) return;
    if (result.markdownChanged) markdownRevisions.set(markdownId, 0);
    activeCellId = codeId; selectedCellIds.clear(); selectedCellIds.add(codeId); commandMode = true; changeCellId = '';
    markAffected(data.cells.filter(cell => cell.kind === 'code').map(cell => cell.id));
    markDirty(); renderCells(); focusCell(codeId);
    if (result.fallback) options.toast('This Markdown block could not be split safely. The code was placed next to the whole block.', 'info');
  };
  const deleteCells = (ids: string[]): void => {
    const removed = new Set(ids.filter(id => data.cells.some(cell => cell.id === id)));
    if (!removed.size) return;
    pushUndo();
    for (const id of removed) {
      if (running.has(id)) void stopCell(id);
      subscriptions.get(id)?.();
      subscriptions.delete(id);
      running.delete(id);
      const pending = taskWaits.get(id);
      taskWaits.delete(id);
      pending?.resolve();
    }
    const firstIndex = data.cells.findIndex(cell => removed.has(cell.id));
    data.cells = data.cells.filter(cell => !removed.has(cell.id));
    for (const id of removed) selectedCellIds.delete(id);
    if (removed.has(activeCellId)) activeCellId = data.cells[Math.min(Math.max(0, firstIndex), data.cells.length - 1)]?.id || '';
    if (!selectedCellIds.size && activeCellId) selectedCellIds.add(activeCellId);
    commandMode = true;
    markDirty();
    renderCells();
    syncSelection();
    if (activeCellId) cellElement(activeCellId)?.focus({ preventScroll: true });
  };
  const deleteCell = (id: string): void => { deleteCells([id]); };
  const runSelected = async (): Promise<void> => {
    const selected = data.cells.filter(cell => selectedCellIds.has(cell.id) && cell.kind === 'code' && cell.executable !== false);
    for (const cell of selected) await runCell(cell);
  };
  const runAffected = async (): Promise<void> => {
    const affected = data.cells.filter(cell => cell.kind === 'code' && cell.stale && cell.executable !== false);
    for (const cell of affected) await runCell(cell);
    const button = host.querySelector<HTMLButtonElement>('[data-nb-run-affected]');
    if (button) button.disabled = true;
  };
  const exportHtml = (): void => {
    syncMarkdownSources();
    exportNotebookHtml(options.title, data, kernels);
  };
  const exportIpynb = (): void => {
    syncMarkdownSources();
    exportNotebookIpynb(options.title, data);
  };

  const renderCodeCell = (cell: NotebookEditorCell, index: number): string => renderNotebookCodeCell(data, kernels, cell, index);
  const renderMarkdownCell = (cell: NotebookEditorCell, index: number): string => renderNotebookMarkdownCell(cell, index, data.cells.length);

  function bindMarkdown(view: HTMLElement, signal: AbortSignal): void {
    prepareNotebookMarkdown(view);
    const cell = data.cells.find(item => item.id === view.dataset.nbMarkdownView && item.kind === 'markdown');
    if (!cell) return;
    view.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input => { input.disabled = false; });
    view.addEventListener('focus', () => {
      activeCellId = cell.id;
      selectedCellIds.clear();
      selectedCellIds.add(cell.id);
      if (changeCellId !== cell.id) changeCellId = '';
      syncSelection();
      if (view.querySelector('[data-nb-generated-placeholder]')) view.innerHTML = '';
    }, { signal });
    view.addEventListener('input', () => { beginCellChange(cell.id); touchMarkdown(cell.id); markDirty(); }, { signal });
    view.addEventListener('paste', event => {
      const html = event.clipboardData?.getData('text/html');
      if (!html) return;
      event.preventDefault();
      touchMarkdown(cell.id);
      markDirty();
      document.execCommand('insertHTML', false, sanitizeMarkdownHtml(html));
    }, { signal });
    view.addEventListener('change', event => {
      if ((event.target as Element | null)?.matches('input[type="checkbox"]')) { touchMarkdown(cell.id); markDirty(); }
    }, { signal });
    view.addEventListener('blur', () => {
      changeCellId = '';
      commitMarkdown(view);
      if (!cell.source.trim()) view.innerHTML = '<p class="nb-md-placeholder" data-nb-generated-placeholder="true">Write Markdown, $E=mc^2$, or paste an image URL…</p>';
    }, { signal });
    view.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); view.blur(); focusCell(cell.id); }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); view.blur(); }
    }, { signal });
    view.addEventListener('click', event => {
      const anchor = (event.target as Element | null)?.closest('a');
      if (anchor && !event.ctrlKey && !event.metaKey) event.preventDefault();
    }, { signal });
  }

  function renderCells(): void {
    if (disposed) return;
    if (!cellsAbort) cellsAbort = new AbortController();
    const signal = cellsAbort.signal;
    const desired = new Set(data.cells.map(cell => cell.id));
    const existing = new Map<string, HTMLElement>();
    for (const child of Array.from(cellsHost.children)) {
      if (!(child instanceof HTMLElement) || !child.dataset.nbCell) continue;
      const id = child.dataset.nbCell;
      existing.set(id, child);
      if (!desired.has(id)) {
        editors.get(id)?.destroy();
        editors.delete(id);
        child.remove();
      }
    }
    let endAdd = cellsHost.querySelector<HTMLButtonElement>('[data-nb-end-add]');
    if (!endAdd) {
      endAdd = document.createElement('button');
      endAdd.type = 'button';
      endAdd.className = 'nb-end-add';
      endAdd.dataset.nbEndAdd = '';
      endAdd.textContent = '+ Add a cell';
      cellsHost.appendChild(endAdd);
    }
    data.cells.forEach((cell, index) => {
      let section = existing.get(cell.id);
      if (!section) {
        const template = document.createElement('template');
        template.innerHTML = (cell.kind === 'code' ? renderCodeCell(cell, index) : renderMarkdownCell(cell, index)).trim();
        section = template.content.firstElementChild as HTMLElement;
      } else {
        section.className = cell.kind === 'code'
          ? 'nb-cell nb-code' + (cell.stale ? ' nb-code-stale' : '') + (cell.hideCode ? ' nb-code-hidden' : '') + (cell.hideOutput ? ' nb-output-hidden' : '') + (running.has(cell.id) ? ' nb-cell-running' : '')
          : 'nb-cell nb-markdown';
        section.querySelectorAll<HTMLButtonElement>('[data-nb-up]').forEach(button => { button.disabled = index === 0; });
        section.querySelectorAll<HTMLButtonElement>('[data-nb-down]').forEach(button => { button.disabled = index === data.cells.length - 1; });
        if (cell.kind === 'code') {
          const select = section.querySelector<HTMLSelectElement>('[data-nb-cell-kernel]');
          if (select) select.value = cellKernel(data, kernels, cell)?.id || '';
          const count = section.querySelector<HTMLElement>('[data-nb-execution-count]');
          if (count) count.textContent = '[' + (cell.executionCount || ' ') + ']';
          const toggle = section.querySelector<HTMLElement>('[data-nb-toggle-code]');
          if (toggle) {
            toggle.textContent = cell.hideCode ? '›' : '⌄';
            toggle.setAttribute('aria-expanded', String(!cell.hideCode));
            toggle.setAttribute('aria-label', cell.hideCode ? 'Expand code' : 'Collapse code');
          }
        } else if (section.dataset.nbRenderedSource !== cell.source) {
          const view = section.querySelector<HTMLElement>('[data-nb-markdown-view]');
          if (view) {
            view.innerHTML = cell.source.trim() ? sanitizeMarkdownHtml(renderMarkdownHtml(cell.source)) : '<p class="nb-md-placeholder" data-nb-generated-placeholder="true">Write Markdown, $E=mc^2$, or paste an image URL…</p>';
            prepareNotebookMarkdown(view);
          }
          section.dataset.nbRenderedSource = cell.source;
        }
      }
      const reference = cellsHost.children[index] || endAdd;
      if (reference !== section) cellsHost.insertBefore(section, reference);
      if (cell.kind === 'markdown') {
        if (!section.querySelector('[data-nb-markdown-view]')?.hasAttribute('data-nb-bound')) {
          const view = section.querySelector<HTMLElement>('[data-nb-markdown-view]');
          if (view) { view.dataset.nbBound = 'true'; bindMarkdown(view, signal); }
        }
        return;
      }
      let editor = editors.get(cell.id);
      if (!editor) {
        const container = section.querySelector<HTMLElement>('[data-nb-code]');
        if (!container) return;
        const kernel = cellKernel(data, kernels, cell);
        editor = mountNotebookCodeEditor({
          parent: container, source: cell.source, language: kernel?.language || cell.language || 'text', readOnly: cell.executable === false,
          onChange: source => {
            beginCellChange(cell.id);
            cell.source = source;
            markAffected([cell.id]);
            markDirty();
          },
          onRun: mode => { void runCell(cell, mode); },
          onEscape: () => focusCell(cell.id),
          onFocus: () => {
            activeCellId = cell.id;
            selectedCellIds.clear();
            selectedCellIds.add(cell.id);
            if (changeCellId !== cell.id) changeCellId = '';
            syncSelection();
          },
          onBlur: () => { changeCellId = ''; },
          complete: async (source, position) => {
            const manager = options.getKernelManager();
            if (!manager || !kernel?.features?.includes('complete')) return null;
            try { return await manager.complete(kernel.id, options.scope, source, position); } catch { return null; }
          },
          inspect: async (source, position) => {
            const manager = options.getKernelManager();
            if (!manager || !kernel?.features?.includes('inspect')) return null;
            try { return await manager.inspect(kernel.id, options.scope, source, position); } catch { return null; }
          },
        });
        editors.set(cell.id, editor);
      }
      refreshOutput(cell);
      const existingTask = notebookExecutionCenter.getForCell(options.scope, cell.id);
      if (existingTask && (existingTask.outputs || ['queued', 'running', 'disconnected'].includes(existingTask.status))) void attachTask(cell, existingTask);
    });
    if (!selectedCellIds.size && activeCellId) selectedCellIds.add(activeCellId);
    syncSelection();
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
    else if (button.dataset.nbToggleCode || button.dataset.nbToggleOutput) {
      const id = button.dataset.nbToggleCode || button.dataset.nbToggleOutput || '';
      const cell = data.cells.find(item => item.id === id);
      if (cell) {
        pushUndo();
        if (button.dataset.nbToggleCode) cell.hideCode = !cell.hideCode;
        else cell.hideOutput = !cell.hideOutput;
        markDirty();
        renderCells();
      }
    }
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
    pushUndo();
    cell.kernelId = kernel.id;
    cell.language = kernel.language;
    if (cell.outputs?.length) cell.stale = true;
    editors.get(cell.id)?.destroy();
    editors.delete(cell.id);
    markDirty();
    renderCells();
    requestAnimationFrame(() => editors.get(cell.id)?.focus());
  });
  cellsHost.addEventListener('pointerdown', event => {
    if ((event.target as Element | null)?.closest('.cm-content, .nb-markdown-body, [contenteditable="true"]')) commandMode = false;
  });
  cellsHost.addEventListener('click', event => {
    if ((event.target as Element | null)?.closest('button, select, input, textarea, a, .cm-content, .nb-markdown-body, [contenteditable="true"]')) return;
    const section = (event.target as Element | null)?.closest<HTMLElement>('[data-nb-cell]');
    if (!section) return;
    selectCell(section.dataset.nbCell || '', event.ctrlKey || event.metaKey ? 'additive' : event.shiftKey ? 'range' : 'single');
  });
  const disposeCellDragAndDrop = installNotebookCellDragAndDrop(cellsHost, {
    cell: id => data.cells.find(cell => cell.id === id),
    cellIndex: id => data.cells.findIndex(cell => cell.id === id),
    syncMarkdown: () => { syncMarkdownSources(); },
    moveCellTo,
    moveCodeToMarkdown,
  });
  cellsHost.addEventListener('keydown', event => {
    const section = (event.target as Element | null)?.closest<HTMLElement>('[data-nb-cell]');
    const commandFocus = commandMode || (section && document.activeElement === section);
    if (!commandFocus) {
      if (event.key === 'Escape') {
        event.preventDefault();
        focusCell(activeCellId || section?.dataset.nbCell || '');
      }
      return;
    }
    const index = data.cells.findIndex(cell => cell.id === activeCellId);
    const key = event.key.toLowerCase();
    if (key === 'arrowdown' || key === 'arrowup') {
      event.preventDefault();
      const direction = key === 'arrowdown' ? 1 : -1;
      if (event.ctrlKey || event.metaKey) moveCell(activeCellId, direction);
      else {
        const next = data.cells[index + direction];
        if (next) focusCell(next.id);
      }
    } else if (key === 'enter') {
      event.preventDefault();
      focusCell(activeCellId, true);
    } else if (key === 'a' || key === 'b') {
      event.preventDefault();
      insertCell(index + (key === 'a' ? 0 : 1), 'code');
    } else if (key === 'z') {
      event.preventDefault();
      undo();
    } else if (key === 'delete' || key === 'backspace') {
      event.preventDefault();
      deleteCells([...selectedCellIds]);
    } else if (key === 'd') {
      event.preventDefault();
      if (deleteChord) {
        deleteChord = false;
        deleteCells([...selectedCellIds]);
      } else {
        deleteChord = true;
        setTimeout(() => { deleteChord = false; }, 700);
      }
    }
  });
  host.querySelector('[data-nb-runall]')?.addEventListener('click', () => { void runAll(); });
  host.querySelector('[data-nb-run-selected]')?.addEventListener('click', () => { void runSelected(); });
  host.querySelector('[data-nb-run-affected]')?.addEventListener('click', () => { void runAffected(); });
  host.querySelector<HTMLSelectElement>('[data-nb-run-scope]')?.addEventListener('change', event => {
    const select = event.target as HTMLSelectElement;
    const index = Math.max(0, data.cells.findIndex(cell => cell.id === activeCellId));
    const action = select.value;
    select.value = '';
    if (action === 'changed') { void runAffected(); return; }
    if (action === 'restart') { void restartKernels().then(runAll); return; }
    if (action !== 'above' && action !== 'below') return;
    const cells = action === 'above' ? data.cells.slice(0, index + 1) : data.cells.slice(index);
    void (async () => { for (const cell of cells) if (cell.kind === 'code') await runCell(cell); })();
  });
  host.querySelector('[data-nb-stop]')?.addEventListener('click', () => { void stopAll(); });
  host.querySelector('[data-nb-restart]')?.addEventListener('click', () => { void restartKernels(); });
  host.querySelector('[data-nb-export]')?.addEventListener('click', exportHtml);
  host.querySelector('[data-nb-export-ipynb]')?.addEventListener('click', exportIpynb);
  host.querySelector('[data-nb-add-code]')?.addEventListener('click', () => insertCell(data.cells.length, 'code'));
  host.querySelector('[data-nb-add-md]')?.addEventListener('click', () => insertCell(data.cells.length, 'markdown'));
  host.querySelector<HTMLSelectElement>('[data-nb-default-kernel]')?.addEventListener('change', event => {
    data.defaultKernelId = (event.target as HTMLSelectElement).value;
    markDirty();
  });
  const exportVariables = (): void => {
    const url = URL.createObjectURL(new Blob([serializeVariablesJson(data.initialVariables || {})], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = options.title.replace(/\.(?:hnb\.md|ipynb)$/iu, '').replace(/[\\/:*?"<>|]+/g, '-') + '-variables.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  variablePanel.addEventListener('change', async event => {
    const input = event.target as HTMLInputElement;
    if (!input.matches('[data-nb-variable-file]')) return;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = file.name.toLowerCase().endsWith('.csv') ? parseVariablesCsv(text) : parseVariablesJson(text);
      pushUndo();
      data.initialVariables = { ...(data.initialVariables || {}), ...imported };
      markAffected([], Object.keys(imported));
      markDirty();
      renderVariables();
      options.toast('Imported ' + Object.keys(imported).length + ' initial values.', 'success');
    } catch (error) {
      options.toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      input.value = '';
    }
  });
  host.querySelector('[data-nb-variables]')?.addEventListener('click', () => {
    variablePanelOpen = !variablePanelOpen;
    variablePanel.classList.toggle('hidden', !variablePanelOpen);
    host.querySelector('[data-nb-variables]')?.setAttribute('aria-expanded', String(variablePanelOpen));
    renderVariables();
  });
  host.querySelector('[data-nb-tasks]')?.addEventListener('click', () => {
    taskPanelOpen = !taskPanelOpen;
    taskPanel.classList.toggle('hidden', !taskPanelOpen);
    host.querySelector('[data-nb-tasks]')?.setAttribute('aria-expanded', String(taskPanelOpen));
    renderTaskPanel();
  });
  taskPanel.addEventListener('click', event => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button');
    if (!button) return;
    if (button.dataset.nbTaskStop) void notebookExecutionCenter.cancel(button.dataset.nbTaskStop).then(renderTaskPanel);
    else if (button.dataset.nbTaskCell) focusCell(button.dataset.nbTaskCell, true);
    else if (button.hasAttribute('data-nb-clear-tasks')) { notebookExecutionCenter.clearCompleted(); renderTaskPanel(); }
  });
  const taskRefreshTimer = setInterval(() => { if (taskPanelOpen) renderTaskPanel(); }, 1000);
  variablePanel.addEventListener('click', event => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button');
    if (!button) return;
    if (button.hasAttribute('data-nb-variable-initialize')) { initializeVariables(); return; }
    if (!data.initialVariables) return;
    if (button.hasAttribute('data-nb-variable-import')) variablePanel.querySelector<HTMLInputElement>('[data-nb-variable-file]')?.click();
    else if (button.hasAttribute('data-nb-variable-export')) exportVariables();
    else if (button.dataset.nbVariableDelete) {
      const name = button.dataset.nbVariableDelete;
      pushUndo();
      delete data.initialVariables[name];
      markAffected([], [name]);
      markDirty();
      renderVariables();
    } else if (button.hasAttribute('data-nb-variable-add')) {
      const name = variablePanel.querySelector<HTMLInputElement>('[data-nb-new-name]')!;
      const value = variablePanel.querySelector<HTMLInputElement>('[data-nb-new-value]')!;
      try {
        const variableName = name.value.trim();
        pushUndo();
        data.initialVariables[variableName] = parseNotebookVariable(name.value, value.value);
        markAffected([], [variableName]);
        markDirty();
        renderVariables();
        variablePanel.querySelector<HTMLInputElement>('[data-nb-new-name]')?.focus();
      } catch (error) { options.toast(error instanceof Error ? error.message : String(error), 'error'); }
    }
  });
  variablePanel.addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    const row = input.closest<HTMLElement>('[data-nb-variable-row]');
    if (!row || !data.initialVariables) return;
    const oldName = row.dataset.nbVariableRow || '';
    const nameInput = row.querySelector<HTMLInputElement>('[data-nb-variable-name]')!;
    const valueInput = row.querySelector<HTMLInputElement>('[data-nb-variable-value]');
    if (!valueInput) return;
    try {
      const next: NotebookVariableValue = parseNotebookVariable(nameInput.value, valueInput.value);
      const name = nameInput.value.trim();
      pushUndo();
      if (name !== oldName) delete data.initialVariables[oldName];
      data.initialVariables[name] = next;
      markAffected([], [oldName, name]);
      markDirty();
      renderVariables();
    } catch (error) {
      options.toast(error instanceof Error ? error.message : String(error), 'error');
      renderVariables();
    }
  });
  const disposeRichEditing = installNotebookRichEditing({
    root: cellsHost,
    getVariables: () => ({ ...(data.initialVariables || {}), ...(data.variables || {}) }),
    getKernelLanguage: () => computationLanguage(defaultKernel(kernels, data.defaultKernelId)),
    insertCalculation: (source, markdownId) => {
      const index = data.cells.findIndex(cell => cell.id === markdownId);
      insertCell(index < 0 ? data.cells.length : index + 1, 'code', source, computationLanguage(defaultKernel(kernels, data.defaultKernelId)));
    },
    commit: view => {
      touchMarkdown(view.dataset.nbMarkdownView || '');
      commitMarkdown(view);
    },
    openVariable: name => {
      variablePanelOpen = true;
      variablePanel.classList.remove('hidden');
      host.querySelector('[data-nb-variables]')?.setAttribute('aria-expanded', 'true');
      renderVariables();
      const row = variablePanel.querySelector<HTMLElement>('[data-nb-variable-row="' + CSS.escape(name) + '"]');
      row?.scrollIntoView({ block: 'nearest' });
      const input = row?.querySelector<HTMLInputElement>('[data-nb-variable-value]');
      input?.focus();
      input?.select();
    },
    toast: options.toast,
  });
  const onWindowMessage = (event: MessageEvent): void => {
    if (!event.data || event.data.hcOutputResize !== 1 || typeof event.data.height !== 'number') return;
    host.querySelectorAll<HTMLIFrameElement>('.exec-out-html').forEach(frame => {
      if (frame.contentWindow === event.source) frame.style.height = Math.max(80, Math.min(900, event.data.height + 8)) + 'px';
    });
  };
  window.addEventListener('message', onWindowMessage);
  const onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const target = event.target as Element | null;
    if (target?.closest('.nb-cells, .nb-inline-popover, #modalRoot .modal')) return;
    if (document.querySelector('#modalRoot .modal, .nb-inline-popover')) return;
    focusCell(activeCellId);
    event.preventDefault();
  };
  document.addEventListener('keydown', onDocumentKeydown);
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
      disposeCellDragAndDrop();
      window.removeEventListener('message', onWindowMessage);
      document.removeEventListener('keydown', onDocumentKeydown);
      for (const editor of editors.values()) editor.destroy();
      editors.clear();
      clearInterval(taskRefreshTimer);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      for (const pending of taskWaits.values()) pending.resolve();
      taskWaits.clear();
      running.clear();
      void pendingSave;
    },
  };
}
