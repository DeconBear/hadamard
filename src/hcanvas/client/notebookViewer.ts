import { notebookCellKey, parseNotebook, serializeNotebook, type NotebookCell, type ParsedNotebook } from '../notebook/format.js';
import type { HcStoredOutput } from '../execOutputs.js';
import type { KernelDescriptor, KernelManager } from './kernelManager.js';
import { esc, genId } from './utils.js';
import type { BuiltinViewer, BuiltinViewerContext } from './builtinViewers.js';
import { mountNotebookPage, type NotebookPageContext } from './notebookPage.js';
import { mountNotebookEditor, type NotebookEditorData, type NotebookEditorHandle } from './notebookEditor.js';
import type { NotebookVariables } from '../notebook/variables.js';
import { parseIpynb, serializeIpynb } from '../notebook/ipynb.js';

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

function saveCache(rootId: string, path: string, cache: OutputCache): void {
  try {
    const entries = Object.entries(cache.cells).slice(-80);
    localStorage.setItem(cacheKeyFor(rootId, path), JSON.stringify({ v: CACHE_VERSION, cells: Object.fromEntries(entries) }));
  } catch { /* Outputs remain in memory if storage is full. */ }
}

function chooseKernel(kernels: KernelDescriptor[], parsed: ParsedNotebook): string {
  const hint = (parsed.frontmatter.values.kernel || '').trim().toLowerCase();
  const match = kernels.find(kernel => kernel.id.toLowerCase() === hint || kernel.language.toLowerCase() === hint);
  return match?.id || kernels.find(kernel => kernel.language === 'python')?.id || kernels[0]?.id || '';
}

function variablesFromFrontmatter(parsed: ParsedNotebook): NotebookVariables {
  try {
    const value = JSON.parse(parsed.frontmatter.values.variables || '{}') as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as NotebookVariables : {};
  } catch { return {}; }
}

function withFrontmatterValues(parsed: ParsedNotebook, data: NotebookEditorData, kernels: KernelDescriptor[]): void {
  const kernel = kernels.find(item => item.id === data.defaultKernelId);
  const variables = Object.keys(data.variables || {}).length ? JSON.stringify(data.variables) : '';
  const lines = parsed.frontmatter.raw.split(/\r?\n/u).filter(line => !/^\s*(?:kernel|variables)\s*:/iu.test(line));
  if (kernel) lines.push('kernel: ' + kernel.id);
  if (variables) lines.push('variables: ' + variables);
  parsed.frontmatter.raw = lines.join('\n').trim();
  // A .hnb.md file may start without frontmatter. Adding kernel/variables means
  // serializeNotebook() must emit a frontmatter block, so mark it present.
  if (kernel || variables) parsed.frontmatter.present = true;
  if (kernel) parsed.frontmatter.values.kernel = kernel.id;
  else delete parsed.frontmatter.values.kernel;
  if (variables) parsed.frontmatter.values.variables = variables;
  else delete parsed.frontmatter.values.variables;
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
  return { cells, defaultKernelId: chooseKernel(kernels, parsed), variables: variablesFromFrontmatter(parsed) };
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
  host.classList.add('notebook-host');
  host.innerHTML = '<div class="notebook-loading">Loading notebook…</div>';
  const scopeName = file.path.split('/').pop() || file.path;

  const boot = async (): Promise<void> => {
    try {
      const result = await deps.request<{ file: { content: string } }>('/api/files/read?root=' + encodeURIComponent(file.rootId) + '&path=' + encodeURIComponent(file.path));
      if (disposed) return;
      const isIpynb = file.path.toLowerCase().endsWith('.ipynb');
      const parsed = isIpynb ? null : parseNotebook(result.file.content);
      const kernels = deps.getKernels();
      const cache = loadCache(file.rootId, file.path);
      const data = isIpynb ? parseIpynb(result.file.content).data : toEditorData(parsed!, kernels, cache);
      if (!data.defaultKernelId) data.defaultKernelId = kernels[0]?.id || '';
      editor = mountNotebookEditor({
        host,
        title: scopeName,
        subtitle: file.path + (isIpynb ? ' · Jupyter notebook saved in the workspace' : ' · Markdown saved in the workspace'),
        kernels,
        scope: { kind: 'file', key: file.rootId + ':' + file.path },
        data,
        request: deps.request,
        getKernelManager: deps.getKernelManager,
        toast: deps.toast,
        persist: async snapshot => {
          let content: string;
          if (isIpynb) content = serializeIpynb(snapshot);
          else {
            withFrontmatterValues(parsed!, snapshot, kernels);
            const cells: NotebookCell[] = snapshot.cells.map(cell => cell.kind === 'markdown'
              ? { kind: 'markdown', source: cell.source }
              : { kind: 'code', id: cell.id, info: '', language: cell.language || 'text', exec: cell.executable !== false, source: cell.source });
            parsed!.cells = cells;
            parsed!.trailingNewline = true;
            content = serializeNotebook(parsed!);
          }
          await deps.request('/api/files/write', {
            method: 'POST',
            keepalive: true,
            body: JSON.stringify({ root: file.rootId, path: file.path, content }),
          });
        },
        persistOutputs: snapshot => {
          if (isIpynb) return;
          persistOutputCache(cache, snapshot);
          saveCache(file.rootId, file.path, cache);
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
