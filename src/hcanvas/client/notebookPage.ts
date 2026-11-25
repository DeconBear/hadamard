import type { HcPage } from '../types.js';
import type { HcStoredOutput } from '../execOutputs.js';
import type { KernelDescriptor } from './kernelManager.js';
import { genId } from './utils.js';
import { mountNotebookEditor, type NotebookEditorCell, type NotebookEditorData, type NotebookEditorHandle } from './notebookEditor.js';

export interface NotebookPageDeps {
  request<T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T>;
  getKernelManager(): import('./kernelManager.js').KernelManager | null;
  getKernels(): KernelDescriptor[];
  savePageData(pageId: string, data: unknown): Promise<boolean>;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
}

export interface NotebookPageContext {
  pageId?: string;
  name?: string;
  data?: unknown;
}

export type NotebookPageCell = NotebookEditorCell;

export interface NotebookPageData extends NotebookEditorData {
  version: 1;
}

const NOTEBOOK_FORMAT = 'hadamard-notebook';

function pickDefaultKernel(kernels: KernelDescriptor[], preferredKernel?: string): string {
  if (preferredKernel) {
    const match = kernels.find(kernel => kernel.language === preferredKernel || kernel.id === preferredKernel);
    if (match) return match.id;
  }
  for (const preferred of ['python', 'octave', 'cpp']) {
    const match = kernels.find(kernel => kernel.language === preferred || kernel.id === preferred);
    if (match) return match.id;
  }
  return kernels[0]?.id || '';
}

function starterCode(kernelId: string): string {
  if (kernelId === 'octave') return 'greeting = "Hello from Octave";\ndisp(greeting);';
  if (kernelId === 'cpp') return 'const std::string greeting = "Hello from C++";\nstd::cout << greeting << std::endl;';
  return 'greeting = "Hello from Python"\nprint(greeting)';
}

export function normalizeNotebookPageData(raw: unknown, kernels: KernelDescriptor[]): NotebookPageData {
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
        ...(typeof cell.language === 'string' ? { language: cell.language } : {}),
        ...(Array.isArray(cell.outputs) ? { outputs: cell.outputs as HcStoredOutput[] } : {}),
        ...(typeof cell.executionCount === 'number' && Number.isFinite(cell.executionCount) ? { executionCount: Math.max(0, Math.floor(cell.executionCount)) } : {}),
        ...(cell.stale === true ? { stale: true } : {}),
        ...(cell.hideCode === true ? { hideCode: true } : {}),
        ...(cell.hideOutput === true ? { hideOutput: true } : {}),
        ...(cell.metadata && typeof cell.metadata === 'object' && !Array.isArray(cell.metadata) ? { metadata: cell.metadata as Record<string, unknown> } : {}),
      });
    }
  }
  const defaultKernelId = typeof source.defaultKernelId === 'string' && source.defaultKernelId ? source.defaultKernelId : pickDefaultKernel(kernels);
  if (!cells.length) {
    cells.push({ id: genId('nbcell'), kind: 'markdown', source: '# Untitled notebook\n\nWrite Markdown alongside executable cells. Press **Shift+Enter** to run, and use **Variables** to share JSON values between languages.' });
    cells.push({ id: genId('nbcell'), kind: 'code', source: starterCode(defaultKernelId), ...(defaultKernelId ? { kernelId: defaultKernelId } : {}) });
  }
  return {
    version: 1,
    cells,
    ...(defaultKernelId ? { defaultKernelId } : {}),
    ...(source.variables && typeof source.variables === 'object' ? { variables: source.variables as NotebookPageData['variables'] } : {}),
    ...(source.initialVariables && typeof source.initialVariables === 'object' ? { initialVariables: source.initialVariables as NotebookPageData['initialVariables'] } : {}),
    ...(typeof source.variablesInitialized === 'boolean' ? { variablesInitialized: source.variablesInitialized } : {}),
    ...(source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata) ? { metadata: source.metadata as Record<string, unknown> } : {}),
  };
}

export function notebookPageMarkup(): string {
  return '<div class="masters-head"><strong>Notebook pages</strong><small>Native Markdown and executable cells with shared variables</small></div>' +
    '<div class="preset-grid"><button type="button" class="preset-btn" data-notebook-page><strong>Notebook</strong><small>Markdown + Python / Octave / C++ · inline formulas and images</small></button></div>';
}

/** Read the user default kernel preference for new Notebook pages. */
export async function loadPreferredKernel(request: <T = Record<string, unknown>>(pathname: string, init?: RequestInit) => Promise<T>): Promise<string> {
  try {
    const payload = await request<{ settings?: { notebook?: { defaultKernel?: string } } }>('/api/settings');
    return payload.settings?.notebook?.defaultKernel || '';
  } catch { return ''; }
}
export function createNotebookPageDefinition(kernels: KernelDescriptor[], name = 'Notebook', preferredKernel = ''): HcPage {
  const defaultKernelId = pickDefaultKernel(kernels, preferredKernel);
  const data: NotebookPageData = {
    version: 1,
    variables: {},
    initialVariables: {},
    variablesInitialized: false,
    ...(defaultKernelId ? { defaultKernelId } : {}),
    cells: [
      { id: genId('nbcell'), kind: 'markdown', source: '# ' + name + '\n\n在 Markdown 中点击公式或图片即可编辑。代码按 **Shift+Enter** 运行；通过 **Variables** 在 Python、Octave 和 C++ 之间共享变量。' },
      { id: genId('nbcell'), kind: 'code', source: starterCode(defaultKernelId), ...(defaultKernelId ? { kernelId: defaultKernelId } : {}) },
    ],
  };
  return { id: genId('page'), name, mode: 'extension', width: 1280, height: 820, background: '#ffffff', extension: { format: NOTEBOOK_FORMAT, data } };
}

export function mountNotebookPage(host: HTMLElement, deps: NotebookPageDeps, context: NotebookPageContext): NotebookEditorHandle | null {
  if (!context.pageId) return null;
  const pageId = context.pageId;
  const kernels = deps.getKernels();
  const data = normalizeNotebookPageData(context.data, kernels);
  host.classList.add('notebook-page-host');
  return mountNotebookEditor({
    host,
    title: context.name || 'Notebook',
    subtitle: 'Notebook · ' + (kernels.length ? kernels.length + ' kernel' + (kernels.length === 1 ? '' : 's') : 'install a kernel extension to run code'),
    kernels,
    scope: { kind: 'page', key: pageId },
    data,
    request: deps.request,
    getKernelManager: deps.getKernelManager,
    toast: deps.toast,
    persist: async snapshot => {
      const payload: NotebookPageData = { version: 1, ...snapshot };
      if (!await deps.savePageData(pageId, payload)) throw new Error('Notebook changes could not be saved.');
    },
  });
}
