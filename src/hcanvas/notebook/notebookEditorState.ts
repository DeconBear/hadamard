import type { ComputationLanguage } from './latexCompute.js';
import type { KernelDescriptor } from '../client/kernelManager.js';
import type { NotebookEditorCell, NotebookEditorData } from './types.js';

export function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const OPTIONAL_CELL_KEYS = ['kernelId', 'language', 'executable', 'outputs', 'executionCount', 'stale', 'hideCode', 'hideOutput', 'metadata'] as const;

/** Keep existing cell objects alive so CodeMirror and Markdown closures stay valid. */
export function restoreNotebookCells(current: NotebookEditorCell[], saved: NotebookEditorCell[]): NotebookEditorCell[] {
  const byId = new Map(current.map(cell => [cell.id, cell]));
  return saved.map(savedCell => {
    const existing = byId.get(savedCell.id);
    if (!existing || existing.kind !== savedCell.kind) return savedCell;
    existing.source = savedCell.source;
    for (const key of OPTIONAL_CELL_KEYS) {
      const value = (savedCell as unknown as Record<string, unknown>)[key];
      if (value === undefined) delete (existing as unknown as Record<string, unknown>)[key];
      else (existing as unknown as Record<string, unknown>)[key] = value;
    }
    return existing;
  });
}

export function kernelForLanguage(kernels: KernelDescriptor[], language: string | undefined): KernelDescriptor | null {
  const normalized = (language || '').toLowerCase();
  return kernels.find(kernel => kernel.id.toLowerCase() === normalized || kernel.language.toLowerCase() === normalized || (kernel.defaultFor || []).some(item => item.toLowerCase() === normalized)) || null;
}

export function defaultKernel(kernels: KernelDescriptor[], requested?: string): KernelDescriptor | null {
  return kernels.find(kernel => kernel.id === requested) || kernelForLanguage(kernels, 'python') || kernelForLanguage(kernels, 'octave') || kernelForLanguage(kernels, 'cpp') || kernels[0] || null;
}

export function cellKernel(data: NotebookEditorData, kernels: KernelDescriptor[], cell: NotebookEditorCell): KernelDescriptor | null {
  return kernels.find(kernel => kernel.id === cell.kernelId) || kernelForLanguage(kernels, cell.language) || defaultKernel(kernels, data.defaultKernelId);
}

export function computationLanguage(kernel: KernelDescriptor | null): ComputationLanguage {
  const language = kernel?.language.toLowerCase();
  return language === 'octave' || language === 'matlab' ? 'octave' : language === 'cpp' || language === 'c++' ? 'cpp' : 'python';
}
