import type { NotebookEditorCell } from './types.js';
import type { NotebookVariables } from './variables.js';

export interface NotebookUndoSnapshot {
  cells: NotebookEditorCell[];
  variables: NotebookVariables;
  initialVariables: NotebookVariables;
  variablesInitialized: boolean;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class NotebookUndoHistory {
  private readonly snapshots: NotebookUndoSnapshot[] = [];

  constructor(private readonly limit = 20) {}

  capture(cells: NotebookEditorCell[], variables: NotebookVariables, initialVariables: NotebookVariables = variables, variablesInitialized = true): NotebookUndoSnapshot {
    const snapshot = clone({ cells, variables, initialVariables, variablesInitialized });
    this.snapshots.push(snapshot);
    if (this.snapshots.length > this.limit) this.snapshots.shift();
    return snapshot;
  }

  restore(): NotebookUndoSnapshot | null {
    return this.snapshots.pop() || null;
  }

  clear(): void {
    this.snapshots.length = 0;
  }

  get size(): number {
    return this.snapshots.length;
  }
}
