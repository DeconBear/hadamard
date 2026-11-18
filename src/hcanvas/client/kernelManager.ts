import type { NotebookVariables } from '../notebook/variables.js';

export interface KernelRequest {
  <T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T>;
}

export interface KernelScope {
  kind: 'document' | 'page' | 'file' | 'custom';
  key: string;
}

export interface KernelDescriptor {
  id: string;
  label?: string;
  language: string;
  features?: string[];
  defaultFor?: string[];
}

export type KernelOutputEvent =
  | { kind: 'stream'; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'display'; data: Record<string, unknown> }
  | { kind: 'result'; data: Record<string, unknown> }
  | { kind: 'error'; ename: string; evalue: string; traceback: string[] };

export interface KernelExecutionResult {
  status: 'ok' | 'error' | 'aborted' | 'cancelled';
  outputs: KernelOutputEvent[];
  durationMs?: number;
  error?: { ename: string; evalue: string; traceback: string[] };
}

export interface KernelExecutionHandle {
  sessionId: string;
  executionId: string;
  onOutput(cb: (event: KernelOutputEvent) => void): () => void;
  onStatus(cb: (status: string) => void): () => void;
  done: Promise<KernelExecutionResult>;
  cancel(): Promise<void>;
}

export interface KernelManagerDeps {
  request: KernelRequest;
  token(): string;
}

interface PendingExecution {
  sessionId: string;
  kernelId: string;
  outputs: KernelOutputEvent[];
  outputListeners: Set<(event: KernelOutputEvent) => void>;
  statusListeners: Set<(status: string) => void>;
  resolve: (result: KernelExecutionResult) => void;
  settled: boolean;
  finalStatus?: string;
  watchdog?: ReturnType<typeof setTimeout>;
}

export interface KernelManager {
  ensure(kernelId: string, scope: KernelScope): Promise<string>;
  execute(kernelId: string, code: string, options: { scope: KernelScope; cellId?: string; variables?: NotebookVariables }): Promise<KernelExecutionHandle>;
  interrupt(handle: KernelExecutionHandle): Promise<void>;
  restart(kernelId: string, scope: KernelScope): Promise<void>;
  stopAll(): Promise<void>;
  dispose(): void;
  sessionOf(kernelId: string, scope: KernelScope): string | null;
}

function scopeKey(scope: KernelScope): string {
  return scope.kind + ':' + scope.key;
}

export function createKernelManager(deps: KernelManagerDeps): KernelManager {
  const sessions = new Map<string, string>();
  const ensuring = new Map<string, Promise<string>>();
  const pending = new Map<string, PendingExecution>();
  const orphanOutputs = new Map<string, KernelOutputEvent[]>();
  const orphanFinishes = new Map<string, Record<string, unknown>>();
  let source: EventSource | null = null;
  let sseOpen = false;
  let disposed = false;
  const openWaiters = new Set<(open: boolean) => void>();

  const notifyOpen = (open: boolean): void => {
    sseOpen = open;
    for (const waiter of [...openWaiters]) waiter(open);
    openWaiters.clear();
  };

  const connect = (): void => {
    if (disposed || typeof EventSource === 'undefined') return;
    try {
      source?.close();
      source = new EventSource('/api/runtime/events?token=' + encodeURIComponent(deps.token()));
    } catch { return; }
    source.addEventListener('hello', () => notifyOpen(true));
    source.addEventListener('runtime', event => {
      let record: Record<string, unknown>;
      try { record = JSON.parse((event as MessageEvent).data) as Record<string, unknown>; } catch { return; }
      if (record.kind !== 'kernel') return;
      const executionId = typeof record.executionId === 'string' ? record.executionId : '';
      const name = typeof record.event === 'string' ? record.event : '';
      const payload = record.payload && typeof record.payload === 'object' ? record.payload as Record<string, unknown> : {};
      if (!executionId) return;
      const output = outputForEvent(name, payload);
      if (output) {
        const entry = pending.get(executionId);
        if (entry) {
          entry.outputs.push(output);
          for (const listener of [...entry.outputListeners]) { try { listener(output); } catch { /* isolate */ } }
        } else if (!orphanFinishes.has(executionId)) {
          const list = orphanOutputs.get(executionId) || [];
          list.push(output);
          orphanOutputs.set(executionId, list);
          if (orphanOutputs.size > 100) orphanOutputs.delete(orphanOutputs.keys().next().value || '');
        }
        return;
      }
      if (name === 'execution_finished') {
        const entry = pending.get(executionId);
        if (entry) settle(entry, payload);
        else {
          orphanFinishes.set(executionId, payload);
          if (orphanFinishes.size > 100) orphanFinishes.delete(orphanFinishes.keys().next().value || '');
        }
      } else if (name === 'execution_cancelled') {
        const entry = pending.get(executionId);
        if (entry) settle(entry, { status: 'cancelled' });
        else orphanFinishes.set(executionId, { status: 'cancelled' });
      }
    });
    source.addEventListener('error', () => notifyOpen(false));
  };

  const waitForSse = (timeoutMs: number): Promise<boolean> => {
    if (sseOpen && source && source.readyState === EventSource.OPEN) return Promise.resolve(true);
    if (!source || source.readyState === EventSource.CLOSED) {
      source?.close();
      source = null;
      connect();
    }
    return new Promise(resolve => {
      const waiter = (open: boolean): void => {
        clearTimeout(timer);
        openWaiters.delete(waiter);
        resolve(open);
      };
      const timer = setTimeout(() => {
        openWaiters.delete(waiter);
        resolve(false);
      }, timeoutMs);
      openWaiters.add(waiter);
    });
  };

  const outputForEvent = (name: string, payload: Record<string, unknown>): KernelOutputEvent | null => {
    if (name === 'stream') return { kind: 'stream', stream: payload.stream === 'stderr' ? 'stderr' : 'stdout', text: String(payload.text || '') };
    if (name === 'display_data') return { kind: 'display', data: payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : {} };
    if (name === 'execute_result') return { kind: 'result', data: payload.data && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : {} };
    if (name === 'error') {
      return { kind: 'error', ename: String(payload.ename || 'Error'), evalue: String(payload.evalue || ''), traceback: Array.isArray(payload.traceback) ? payload.traceback.map(String) : [] };
    }
    return null;
  };

  const settle = (entry: PendingExecution, payload: Record<string, unknown>): void => {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = undefined; }
    const rawStatus = String(payload.status || 'ok');
    const status = rawStatus === 'error' ? 'error' : rawStatus === 'aborted' ? 'aborted' : rawStatus === 'cancelled' ? 'cancelled' : 'ok';
    entry.finalStatus = status;
    const errorPayload = payload.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : undefined;
    entry.resolve({
      status,
      outputs: entry.outputs,
      ...(typeof payload.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
      ...(errorPayload ? { error: { ename: String(errorPayload.ename || 'Error'), evalue: String(errorPayload.evalue || ''), traceback: Array.isArray(errorPayload.traceback) ? errorPayload.traceback.map(String) : [] } } : {}),
    });
    for (const listener of [...entry.statusListeners]) { try { listener(status); } catch { /* isolate */ } }
    for (const [id, item] of pending) if (item === entry) pending.delete(id);
  };

  const outputForStored = (item: Record<string, unknown>): KernelOutputEvent | null => {
    const type = item.type;
    if (type === 'stream') return { kind: 'stream', stream: item.name === 'stderr' ? 'stderr' : 'stdout', text: String(item.text || '') };
    if (type === 'display_data') return { kind: 'display', data: (item.data && typeof item.data === 'object' ? item.data as Record<string, unknown> : {}) };
    if (type === 'execute_result') return { kind: 'result', data: (item.data && typeof item.data === 'object' ? item.data as Record<string, unknown> : {}) };
    if (type === 'error') {
      const error = item.error && typeof item.error === 'object' ? item.error as Record<string, unknown> : {};
      return { kind: 'error', ename: String(error.ename || 'Error'), evalue: String(error.evalue || ''), traceback: Array.isArray(error.traceback) ? error.traceback.map(String) : [] };
    }
    return null;
  };

  const ensure = async (kernelId: string, scope: KernelScope): Promise<string> => {
    const key = kernelId + '|' + scopeKey(scope);
    const existing = sessions.get(key);
    if (existing) return existing;
    const inFlight = ensuring.get(key);
    if (inFlight) return inFlight;
    const request = deps.request<{ ok?: boolean; session?: { sessionId?: string } }>('/api/kernels/ensure', {
      method: 'POST', body: JSON.stringify({ kernelId, scope }),
    }).then(result => {
      const sessionId = result.session?.sessionId;
      if (!sessionId) throw new Error('Kernel session was not created: ' + kernelId);
      sessions.set(key, sessionId);
      return sessionId;
    }).finally(() => ensuring.delete(key));
    ensuring.set(key, request);
    return request;
  };

  const execute = async (kernelId: string, code: string, options: { scope: KernelScope; cellId?: string; variables?: NotebookVariables }): Promise<KernelExecutionHandle> => {
    if (disposed) throw new Error('Kernel manager has been disposed.');
    const sessionId = await ensure(kernelId, options.scope);
    const payload = { code, ...(options.cellId ? { cellId: options.cellId } : {}), ...(options.variables ? { variables: options.variables } : {}) };
    const open = await waitForSse(1500);
    if (!open) {
      const result = await deps.request<{ execution?: { executionId?: string; status?: string; durationMs?: number; outputs?: { events?: Array<Record<string, unknown>> } } }>('/api/kernels/' + encodeURIComponent(sessionId) + '/execute', {
        method: 'POST', body: JSON.stringify({ ...payload, wait: true }),
      });
      const outputs = (result.execution?.outputs?.events || []).map(item => outputForStored(item)).filter((item): item is KernelOutputEvent => Boolean(item));
      const rawStatus = result.execution?.status;
      const status = rawStatus === 'error' ? 'error' : rawStatus === 'aborted' ? 'aborted' : rawStatus === 'cancelled' ? 'cancelled' : 'ok';
      return {
        sessionId,
        executionId: result.execution?.executionId || '',
        onOutput: () => () => undefined,
        onStatus: () => () => undefined,
        done: Promise.resolve({ status, outputs, ...(typeof result.execution?.durationMs === 'number' ? { durationMs: result.execution.durationMs } : {}) }),
        cancel: async () => undefined,
      };
    }
    const started = await deps.request<{ ok?: boolean; sessionId?: string; executionId?: string }>('/api/kernels/' + encodeURIComponent(sessionId) + '/execute', {
      method: 'POST', body: JSON.stringify(payload),
    });
    const executionId = String(started.executionId || '');
    if (!executionId) throw new Error('The kernel did not return an execution id.');
    let resolveDone: (value: KernelExecutionResult) => void = () => undefined;
    const done = new Promise<KernelExecutionResult>(resolve => { resolveDone = resolve; });
    const entry: PendingExecution = {
      sessionId, kernelId, outputs: [], outputListeners: new Set(), statusListeners: new Set(), resolve: resolveDone, settled: false,
    };
    entry.watchdog = setTimeout(() => {
      if (entry.settled) return;
      settle(entry, { status: 'aborted', error: { ename: 'KernelStreamTimeout', evalue: 'No kernel completion event arrived after 5 minutes. Stop or restart the kernel before trying again.', traceback: [] } });
      void deps.request('/api/kernels/' + encodeURIComponent(sessionId) + '/interrupt', { method: 'POST', body: JSON.stringify({ executionId }) }).catch(() => undefined);
    }, 5 * 60 * 1000);
    pending.set(executionId, entry);
    const orphaned = orphanOutputs.get(executionId);
    if (orphaned?.length) entry.outputs.push(...orphaned);
    orphanOutputs.delete(executionId);
    const finished = orphanFinishes.get(executionId);
    orphanFinishes.delete(executionId);
    if (finished) settle(entry, finished);
    return {
      sessionId,
      executionId,
      onOutput: cb => {
        entry.outputListeners.add(cb);
        for (const output of entry.outputs) cb(output);
        return () => entry.outputListeners.delete(cb);
      },
      onStatus: cb => {
        entry.statusListeners.add(cb);
        if (entry.finalStatus) cb(entry.finalStatus);
        return () => entry.statusListeners.delete(cb);
      },
      done,
      cancel: async () => {
        try {
          await deps.request('/api/kernels/' + encodeURIComponent(sessionId) + '/interrupt', { method: 'POST', body: JSON.stringify({ executionId }) });
        } catch {
          await deps.request('/api/runtime/cancel', { method: 'POST', body: JSON.stringify({ executionId }) }).catch(() => undefined);
        } finally {
          if (!entry.settled) settle(entry, { status: 'cancelled', error: { ename: 'ExecutionCancelled', evalue: 'Execution cancelled.', traceback: [] } });
        }
      },
    };
  };

  const restart = async (kernelId: string, scope: KernelScope): Promise<void> => {
    const sessionId = await ensure(kernelId, scope);
    await deps.request('/api/kernels/' + encodeURIComponent(sessionId) + '/restart', { method: 'POST', body: JSON.stringify({}) });
  };

  const stopAll = async (): Promise<void> => {
    for (const sessionId of new Set(sessions.values())) {
      await deps.request('/api/kernels/' + encodeURIComponent(sessionId), { method: 'DELETE' }).catch(() => undefined);
    }
    sessions.clear();
  };

  const dispose = (): void => {
    disposed = true;
    try { source?.close(); } catch { /* ignore */ }
    source = null;
    notifyOpen(false);
    for (const entry of [...pending.values()]) settle(entry, { status: 'aborted', error: { ename: 'KernelManagerDisposed', evalue: 'Kernel manager was closed.', traceback: [] } });
    orphanOutputs.clear();
    orphanFinishes.clear();
  };

  connect();
  return { ensure, execute, interrupt: handle => handle.cancel(), restart, stopAll, dispose, sessionOf: (kernelId, scope) => sessions.get(kernelId + '|' + scopeKey(scope)) || null };
}
