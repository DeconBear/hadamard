import { notebookCellKey, parseNotebook, serializeNotebook, type NotebookCell, type ParsedNotebook } from '../notebook/format.js';
import { selectOutputCacheEntries, type HcStoredOutput } from '../execOutputs.js';
import type { KernelDescriptor, KernelManager } from './kernelManager.js';
import { esc, genId } from './utils.js';
import type { BuiltinViewer, BuiltinViewerContext } from './builtinViewers.js';
import { mountNotebookPage, type NotebookPageContext } from './notebookPage.js';
import { mountNotebookEditor, type NotebookEditorData, type NotebookEditorHandle } from './notebookEditor.js';
import type { NotebookVariables } from '../notebook/variables.js';

export interface NotebookViewerDeps {
  request<T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T>;
  getKernelManager(): KernelManager | null;
  getKernels(): KernelDescriptor[];
  savePageData(pageId: string, data: unknown): Promise<boolean>;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

interface NotebookFileContext { rootId: string; path: string; }
interface OutputCache { v: number; cells: Record<string, { outputs: HcStoredOutput[]; count?: number }>; }

const CACHE_VERSION = 2;
const DEFAULT_OUTPUT_CACHE_BYTES = 4 * 1024 * 1024;

function cacheKeyFor(rootId: string, path: string): string { return 'hcanvas.notebook.outputs.v2:' + rootId + ':' + path; }
function legacyCacheKeyFor(rootId: string, path: string): string { return 'hcanvas.notebook.outputs.v1:' + rootId + ':' + path; }

function loadCache(rootId: string, path: string): OutputCache {
  for (const key of [cacheKeyFor(rootId, path), legacyCacheKeyFor(rootId, path)]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as OutputCache;
      if (parsed && (parsed.v === 1 || parsed.v === CACHE_VERSION) && parsed.cells && typeof parsed.cells === 'object') return { v: CACHE_VERSION, cells: parsed.cells };
    } catch { /* Try the previous cache or start empty. */ }
  }
  return { v: CACHE_VERSION, cells: {} };
}

function saveCache(rootId: string, path: string, cache: OutputCache, budgetBytes = DEFAULT_OUTPUT_CACHE_BYTES): void {
  try {
    const entries = selectOutputCacheEntries(Object.entries(cache.cells).slice(-80), budgetBytes);
    localStorage.setItem(cacheKeyFor(rootId, path), JSON.stringify({ v: CACHE_VERSION, cells: Object.fromEntries(entries) }));
  } catch { /* Outputs remain in memory if storage is full. */ }
}

function chooseKernel(kernels: KernelDescriptor[], parsed: ParsedNotebook): string {
  const hint = (parsed.frontmatter.values.kernel || '').trim().toLowerCase();
  const match = kernels.find(kernel => kernel.id.toLowerCase() === hint || kernel.language.toLowerCase() === hint);
  return match?.id || kernels.find(kernel => kernel.language === 'python')?.id || kernels[0]?.id || '';
}

function parseVariableField(values: Record<string, string>, field: string): NotebookVariables {
  try {
    const value = JSON.parse(values[field] || '{}') as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as NotebookVariables : {};
  } catch { return {}; }
}

export interface ResolvedNotebookVariableState {
  initialVariables: NotebookVariables;
  variables: NotebookVariables;
  variablesInitialized: boolean;
}

/**
 * Resolve the variable state stored in .hnb.md frontmatter.
 *
 * Files written before the variable-state split only stored `variables:` and
 * used it for the live runtime values. Such a legacy file has neither
 * `current_variables:` nor `variables_initialized:`, so its initial values are
 * also used as the current values: otherwise the next run would send an empty
 * variable map to the kernel (hc_get then falls back to its default and cells
 * that depend on shared state fail). New files keep the two fields distinct and
 * an explicit `variables_initialized: false` still means "not initialized yet".
 */
export function resolveNotebookVariableState(values: Record<string, string>): ResolvedNotebookVariableState {
  const initialVariables = parseVariableField(values, 'variables');
  let variables = parseVariableField(values, 'current_variables');
  const hasInitializedFlag = Object.prototype.hasOwnProperty.call(values, 'variables_initialized');
  const hasCurrentField = Object.prototype.hasOwnProperty.call(values, 'current_variables');
  // Only files written before the initial/current split (no initialized flag and
  // no current_variables field) treat variables: as both initial and current.
  // A new file with variables_initialized: false must keep current empty until
  // the user clicks Initialize/Run all, even though it has initial values.
  const legacyFallback = !hasInitializedFlag && !hasCurrentField && !Object.keys(variables).length && Object.keys(initialVariables).length > 0;
  if (legacyFallback) variables = initialVariables;
  const variablesInitialized = hasInitializedFlag
    ? values.variables_initialized === 'true'
    : legacyFallback || Object.keys(variables).length > 0;
  return { initialVariables, variables, variablesInitialized };
}

function withFrontmatterValues(parsed: ParsedNotebook, data: NotebookEditorData, kernels: KernelDescriptor[]): void {
  const kernel = kernels.find(item => item.id === data.defaultKernelId);
  const initial = Object.keys(data.initialVariables || {}).length ? JSON.stringify(data.initialVariables) : '';
  const current = Object.keys(data.variables || {}).length ? JSON.stringify(data.variables) : '';
  const initialized = data.variablesInitialized === true;
  const lines = parsed.frontmatter.raw.split(/\r?\n/u).filter(line => !/^\s*(?:kernel|variables|current_variables|variables_initialized)\s*:/iu.test(line));
  if (kernel) lines.push('kernel: ' + kernel.id);
  if (initial) lines.push('variables: ' + initial);
  if (current) lines.push('current_variables: ' + current);
  if (initial || current || initialized) lines.push('variables_initialized: ' + String(initialized));
  parsed.frontmatter.raw = lines.join('\n').trim();
  // Adding variable state requires a frontmatter block in the serialized file.
  if (kernel || initial || current || initialized) parsed.frontmatter.present = true;
  if (kernel) parsed.frontmatter.values.kernel = kernel.id;
  else delete parsed.frontmatter.values.kernel;
  if (initial) parsed.frontmatter.values.variables = initial;
  else delete parsed.frontmatter.values.variables;
  if (current) parsed.frontmatter.values.current_variables = current;
  else delete parsed.frontmatter.values.current_variables;
  parsed.frontmatter.values.variables_initialized = String(initialized);
}

function toEditorData(parsed: ParsedNotebook, kernels: KernelDescriptor[], cache: OutputCache): NotebookEditorData {
  const cells = parsed.cells.map((cell, index) => {
    const id = cell.id || genId('nbcell');
    if (cell.kind === 'markdown') return { id, kind: 'markdown' as const, source: cell.source };
    const cached = cache.cells[notebookCellKey(index, cell.source)];
    const kernel = kernels.find(item => item.language === cell.language || item.id === cell.language || (item.defaultFor || []).includes(cell.language));
    return {
      id, kind: 'code' as const, source: cell.source, language: cell.language, executable: cell.exec,
      ...(kernel ? { kernelId: kernel.id } : {}),
      ...(cached ? { outputs: cached.outputs, executionCount: cached.count || 0 } : {}),
    };
  });
  if (!cells.length) cells.push({ id: genId('nbcell'), kind: 'markdown', source: '# Untitled notebook\n\nWrite Markdown here. Add a code cell below, then press **Shift+Enter** to run it.' });
  const variableState = resolveNotebookVariableState(parsed.frontmatter.values);
  return {
    cells,
    defaultKernelId: chooseKernel(kernels, parsed),
    initialVariables: variableState.initialVariables,
    variables: variableState.variables,
    variablesInitialized: variableState.variablesInitialized,
  };
}

function persistOutputCache(cache: OutputCache, data: NotebookEditorData): void {
  data.cells.forEach((cell, index) => {
    if (cell.kind !== 'code') return;
    const key = notebookCellKey(index, cell.source);
    if (cell.outputs?.length) cache.cells[key] = { outputs: cell.outputs, count: cell.executionCount || 0 };
    else delete cache.cells[key];
  });
}

export function createNotebookViewer(deps: NotebookViewerDeps): BuiltinViewer {
  return {
    mount(host: HTMLElement, context: BuiltinViewerContext) {
      const pageContext = context.page as NotebookPageContext | undefined;
      if (pageContext?.pageId) return mountNotebookPage(host, deps, pageContext) || {};
      const file = context.file as NotebookFileContext | undefined;
      if (!file?.rootId || !file.path) {
        host.innerHTML = '<div class="extension-viewer-error"><strong>Notebook needs a file or page</strong><small>Open a .hnb.md file or create a Notebook page.</small></div>';
        return {};
      }
      return mountFileNotebook(host, deps, file);
    },
  };
}

function mountFileNotebook(host: HTMLElement, deps: NotebookViewerDeps, file: NotebookFileContext): { dispose(): void } {
  let disposed = false;
  let editor: NotebookEditorHandle | null = null;
  let outputCacheBudget = DEFAULT_OUTPUT_CACHE_BYTES;
  let fileHash: string | undefined;
  let fileMtime: number | undefined;
  let saveBlocked = false;
  let suppressPersist = false;
  let ignoreVersion = false;
  let lastContent = '';
  let conflictBanner: HTMLElement | null = null;
  host.classList.add('notebook-host');
  host.innerHTML = '<div class="notebook-loading">Loading notebook…</div>';
  const scopeName = file.path.split('/').pop() || file.path;

  const removeConflictBanner = (): void => {
    conflictBanner?.remove();
    conflictBanner = null;
  };

  const showConflict = (error: unknown): void => {
    const shape = error as { status?: number; payload?: { code?: string; error?: string; currentHash?: string; currentMtime?: number } } | null;
    if (shape?.status !== 409 || shape.payload?.code !== 'file_conflict' || disposed) return;
    saveBlocked = true;
    removeConflictBanner();
    const banner = document.createElement('div');
    banner.className = 'notebook-save-conflict';
    banner.innerHTML = '<div><strong>Notebook changed on disk</strong><span>' + esc(shape.payload.error || 'The file was modified outside this notebook.') + '</span></div><div class="file-conflict-actions"><button type="button" class="btn tiny" data-notebook-conflict-reload>Reload disk version</button><button type="button" class="btn tiny" data-notebook-conflict-overwrite>Overwrite</button><button type="button" class="btn tiny" data-notebook-conflict-copy>Save local copy</button></div>';
    banner.querySelector('[data-notebook-conflict-reload]')?.addEventListener('click', () => {
      void (async () => {
        suppressPersist = true;
        saveBlocked = false;
        ignoreVersion = false;
        removeConflictBanner();
        editor?.dispose();
        editor = null;
        host.innerHTML = '<div class="notebook-loading">Reloading notebook…</div>';
        try { await boot(); } finally { suppressPersist = false; }
      })();
    });
    banner.querySelector('[data-notebook-conflict-overwrite]')?.addEventListener('click', () => {
      saveBlocked = false;
      ignoreVersion = true;
      removeConflictBanner();
      void editor?.flush();
    });
    banner.querySelector('[data-notebook-conflict-copy]')?.addEventListener('click', () => {
      void (async () => {
        const suffix = new Date().toISOString().replace(/[:.]/g, '-');
        const copyPath = file.path + '.conflict-copy-' + suffix;
        try {
          await deps.request('/api/files/write', { method: 'POST', body: JSON.stringify({ root: file.rootId, path: copyPath, content: lastContent }) });
          deps.toast('Saved a local copy at ' + copyPath, 'success');
        } catch (copyError) {
          deps.toast(copyError instanceof Error ? copyError.message : String(copyError), 'error');
        }
      })();
    });
    conflictBanner = banner;
    host.prepend(banner);
  };

  const boot = async (): Promise<void> => {
    try {
      const result = await deps.request<{ file: { content: string; hash?: string; mtime?: number } }>('/api/files/read?root=' + encodeURIComponent(file.rootId) + '&path=' + encodeURIComponent(file.path));
      if (disposed) return;
      const settings = await deps.request<{ settings?: { notebook?: { outputCacheBytes?: number; htmlExportIncludeOutputs?: boolean } } }>('/api/settings').catch(() => null);
      const configuredBudget = settings?.settings?.notebook?.outputCacheBytes;
      if (typeof configuredBudget === 'number' && configuredBudget >= 0) outputCacheBudget = configuredBudget;
      fileHash = result.file.hash;
      fileMtime = result.file.mtime;
      saveBlocked = false;
      ignoreVersion = false;
      removeConflictBanner();
      const parsed = parseNotebook(result.file.content);
      const kernels = deps.getKernels();
      const cache = loadCache(file.rootId, file.path);
      const data = toEditorData(parsed, kernels, cache);
      if (!data.defaultKernelId) data.defaultKernelId = kernels[0]?.id || '';
      editor = mountNotebookEditor({
        host,
        title: scopeName,
        subtitle: file.path + ' · Markdown saved in the workspace',
        kernels,
        scope: { kind: 'file', key: file.rootId + ':' + file.path },
        data,
        request: deps.request,
        getKernelManager: deps.getKernelManager,
        exportIncludeOutputs: settings?.settings?.notebook?.htmlExportIncludeOutputs !== false,
        toast: deps.toast,
        onSaveConflict: showConflict,
        persist: async snapshot => {
          if (suppressPersist) return;
          if (saveBlocked) throw new Error('Notebook save is paused because the file changed on disk. Reload or overwrite first.');
          withFrontmatterValues(parsed, snapshot, kernels);
          const cells: NotebookCell[] = snapshot.cells.map(cell => cell.kind === 'markdown'
            ? { kind: 'markdown', source: cell.source }
            : { kind: 'code', id: cell.id, info: '', language: cell.language || 'text', exec: cell.executable !== false, source: cell.source });
          parsed.cells = cells;
          parsed.trailingNewline = true;
          const content = serializeNotebook(parsed);
          lastContent = content;
          let result: { file?: { hash?: string; mtime?: number } };
          try {
            result = await deps.request<{ file?: { hash?: string; mtime?: number } }>('/api/files/write', {
              method: 'POST',
              keepalive: true,
              body: JSON.stringify({
                root: file.rootId,
                path: file.path,
                content,
                ...(!ignoreVersion && fileHash !== undefined ? { expectedHash: fileHash } : {}),
                ...(!ignoreVersion && fileMtime !== undefined ? { expectedMtime: fileMtime } : {}),
              }),
            });
          } catch (error) {
            ignoreVersion = false;
            throw error;
          }
          if (typeof result.file?.hash === 'string') fileHash = result.file.hash;
          if (typeof result.file?.mtime === 'number') fileMtime = result.file.mtime;
          ignoreVersion = false;
          saveBlocked = false;
          removeConflictBanner();
        },
        persistOutputs: snapshot => {
          persistOutputCache(cache, snapshot);
          saveCache(file.rootId, file.path, cache, outputCacheBudget);
        },
      });
    } catch (error) {
      if (!disposed) host.innerHTML = '<div class="extension-viewer-error"><strong>Notebook failed to open</strong><small>' + esc(error instanceof Error ? error.message : String(error)) + '</small></div>';
    }
  };
  void boot();
  return {
    dispose() {
      disposed = true;
      editor?.dispose();
      editor = null;
    },
  };
}
