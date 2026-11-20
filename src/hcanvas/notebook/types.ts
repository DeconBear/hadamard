import type { HcStoredOutput } from '../execOutputs.js';
import type { NotebookVariables } from './variables.js';

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
  hideCode?: boolean;
  hideOutput?: boolean;
  metadata?: Record<string, unknown>;
}

export interface NotebookEditorData {
  cells: NotebookEditorCell[];
  defaultKernelId?: string;
  variables?: NotebookVariables;
  metadata?: Record<string, unknown>;
}
