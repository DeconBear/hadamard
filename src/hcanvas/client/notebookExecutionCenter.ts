import type { HcStoredOutput } from '../execOutputs.js';
import { eventsToStoredOutputs } from './execCell.js';
import { persistKernelOutputAssets } from './kernelOutputAssets.js';
import type { KernelDescriptor, KernelExecutionHandle, KernelManager, KernelOutputEvent, KernelScope } from './kernelManager.js';
import type { NotebookVariables } from '../notebook/variables.js';
import { variablesFromEvents } from '../notebook/variables.js';

export type NotebookTaskStatus = 'queued' | 'running' | 'disconnected' | 'ok' | 'error' | 'aborted' | 'cancelled' | 'failed';

export interface NotebookExecutionTask {
  id: string;
  key: string;
  cellId: string;
  notebookTitle: string;
  scope: KernelScope;
  kernelId: string;
  kernelLabel: string;
  source: string;
  status: NotebookTaskStatus;
  events: KernelOutputEvent[];
  outputs?: HcStoredOutput[];
  variables?: NotebookVariables;
  startedAt: number;
  durationMs?: number;
  error?: string;
  cancelRequested?: boolean;
  handle?: KernelExecutionHandle;
}

export interface NotebookExecutionStart {
  cellId: string;
  notebookTitle: string;
  scope: KernelScope;
  kernel: KernelDescriptor;
  source: string;
  variables: NotebookVariables;
  manager: KernelManager;
  request: <T = Record<string, unknown>>(pathname: string, init?: RequestInit) => Promise<T>;
}

export type NotebookExecutionListener = (task: NotebookExecutionTask, event?: KernelOutputEvent) => void;

function scopeKey(scope: KernelScope): string {
  return scope.kind + ':' + scope.key;
}

export class NotebookExecutionCenter {
  private readonly tasks = new Map<string, NotebookExecutionTask>();
  private readonly activeByCell = new Map<string, string>();
  private readonly listeners = new Map<string, Set<NotebookExecutionListener>>();
  private sequence = 0;

  start(input: NotebookExecutionStart): NotebookExecutionTask {
    const key = scopeKey(input.scope) + '|' + input.cellId;
    const existingId = this.activeByCell.get(key);
    const existing = existingId ? this.tasks.get(existingId) : undefined;
    if (existing && ['queued', 'running', 'disconnected'].includes(existing.status)) return existing;
    const task: NotebookExecutionTask = {
      id: 'nbexec_' + (++this.sequence).toString(36),
      key,
      cellId: input.cellId,
      notebookTitle: input.notebookTitle,
      scope: input.scope,
      kernelId: input.kernel.id,
      kernelLabel: input.kernel.label || input.kernel.language || input.kernel.id,
      source: input.source,
      status: 'queued',
      events: [],
      startedAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    this.activeByCell.set(key, task.id);
    this.trimCompleted();
    void this.execute(task, input);
    return task;
  }

  subscribe(taskId: string, listener: NotebookExecutionListener): () => void {
    const listeners = this.listeners.get(taskId) || new Set<NotebookExecutionListener>();
    listeners.add(listener);
    this.listeners.set(taskId, listeners);
    const task = this.tasks.get(taskId);
    if (task) listener(task);
    return () => { listeners.delete(listener); };
  }

  get(taskId: string): NotebookExecutionTask | null {
    return this.tasks.get(taskId) || null;
  }

  getForCell(scope: KernelScope, cellId: string): NotebookExecutionTask | null {
    const key = scopeKey(scope) + '|' + cellId;
    const activeId = this.activeByCell.get(key);
    if (activeId) return this.tasks.get(activeId) || null;
    return [...this.tasks.values()].reverse().find(task => task.key === key) || null;
  }

  list(): NotebookExecutionTask[] {
    return [...this.tasks.values()].sort((left, right) => right.startedAt - left.startedAt);
  }

  async cancel(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || ['ok', 'error', 'aborted', 'cancelled', 'failed'].includes(task.status)) return;
    task.cancelRequested = true;
    task.status = 'queued';
    this.emit(task);
    if (task.handle) await task.handle.cancel().catch(() => undefined);
  }

  clearCompleted(): void {
    for (const [id, task] of this.tasks) {
      if (['ok', 'error', 'aborted', 'cancelled', 'failed'].includes(task.status)) {
        this.tasks.delete(id);
        this.listeners.delete(id);
      }
    }
  }

  private emit(task: NotebookExecutionTask, event?: KernelOutputEvent): void {
    for (const listener of [...(this.listeners.get(task.id) || [])]) {
      try { listener(task, event); } catch { /* isolate notebook views */ }
    }
  }

  private trimCompleted(): void {
    if (this.tasks.size <= 100) return;
    for (const [id, task] of this.tasks) {
      if (this.tasks.size <= 100) break;
      if (['ok', 'error', 'aborted', 'cancelled', 'failed'].includes(task.status)) {
        this.tasks.delete(id);
        this.listeners.delete(id);
      }
    }
  }

  private async execute(task: NotebookExecutionTask, input: NotebookExecutionStart): Promise<void> {
    try {
      if (task.cancelRequested) {
        task.status = 'cancelled';
        this.emit(task);
        return;
      }
      const handle = await input.manager.execute(input.kernel.id, input.source, { scope: input.scope, cellId: input.cellId, variables: input.variables });
      task.handle = handle;
      if (task.cancelRequested) void handle.cancel();
      handle.onStatus(status => {
        if (task.cancelRequested) return;
        task.status = status === 'disconnected' ? 'disconnected' : status === 'queued' ? 'queued' : 'running';
        this.emit(task);
      });
      handle.onOutput(event => {
        task.events.push(event);
        const variables = variablesFromEvents([event]);
        if (Object.keys(variables).length) task.variables = { ...(task.variables || input.variables), ...variables };
        this.emit(task, event);
      });
      const result = await handle.done;
      task.events = result.outputs;
      task.durationMs = result.durationMs;
      task.status = result.status;
      task.variables = { ...input.variables, ...(task.variables || {}), ...variablesFromEvents(result.outputs) };
      task.outputs = await persistKernelOutputAssets(eventsToStoredOutputs(result.outputs), { sessionId: handle.sessionId, executionId: handle.executionId }, { request: input.request });
      this.emit(task);
    } catch (error) {
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      this.emit(task);
    } finally {
      task.handle = undefined;
    }
  }
}

export const notebookExecutionCenter = new NotebookExecutionCenter();
