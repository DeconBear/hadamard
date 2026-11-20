import { describe, expect, it, vi } from 'vitest';
import { NotebookExecutionCenter } from '../src/hcanvas/client/notebookExecutionCenter.js';
import type { KernelExecutionHandle, KernelManager } from '../src/hcanvas/client/kernelManager.js';
import { NOTEBOOK_VARIABLES_MIME } from '../src/hcanvas/notebook/variables.js';

function handleMock() {
  let output: ((event: any) => void) | undefined;
  let status: ((status: string) => void) | undefined;
  let resolveDone: (result: any) => void = () => undefined;
  const done = new Promise<any>(resolve => { resolveDone = resolve; });
  const handle: KernelExecutionHandle = {
    sessionId: 'ks_1', executionId: 'exec_1',
    onOutput: cb => { output = cb; return () => undefined; },
    onStatus: cb => { status = cb; return () => undefined; },
    done,
    cancel: vi.fn(async () => undefined),
  };
  return { handle, emit: (event: any) => output?.(event), setStatus: (next: string) => status?.(next), finish: (result: any) => resolveDone(result) };
}

function manager(handle: KernelExecutionHandle): KernelManager {
  return {
    ensure: vi.fn(async () => 'ks_1'),
    execute: vi.fn(async () => handle),
    complete: vi.fn(async () => ({ matches: [], cursorStart: 0, cursorEnd: 0 })),
    inspect: vi.fn(async () => ({})),
    interrupt: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    dispose: vi.fn(),
    sessionOf: vi.fn(() => 'ks_1'),
  };
}

const scope = { kind: 'page' as const, key: 'p1' };
const kernel = { id: 'python', language: 'python' };

describe('notebook execution center', () => {
  it('replays events and final results for new subscribers', async () => {
    const center = new NotebookExecutionCenter();
    const runtime = handleMock();
    const task = center.start({ cellId: 'cell1', notebookTitle: 'Demo', scope, kernel, source: 'print(1)', variables: {}, manager: manager(runtime.handle), request: async <T = Record<string, unknown>>(): Promise<T> => ({}) as T });
    await vi.waitFor(() => expect(runtime.handle.onOutput).toBeDefined());
    runtime.emit({ kind: 'stream', stream: 'stdout', text: 'one\n' });
    runtime.emit({ kind: 'display', data: { [NOTEBOOK_VARIABLES_MIME]: { answer: 42 } } });
    const seen: string[] = [];
    const unsubscribe = center.subscribe(task.id, current => { seen.push(current.status); });
    expect(seen).toContain('queued');
    runtime.finish({ status: 'ok', outputs: [{ kind: 'stream', stream: 'stdout', text: 'one\n' }], durationMs: 3 });
    await vi.waitFor(() => expect(center.get(task.id)?.outputs?.length).toBe(1));
    expect(center.get(task.id)?.status).toBe('ok');
    expect(center.get(task.id)?.variables).toEqual({ answer: 42 });
    expect(center.getForCell(scope, 'cell1')?.id).toBe(task.id);
    unsubscribe();
  });

  it('reuses active cells and supports cancellation', async () => {
    const center = new NotebookExecutionCenter();
    const runtime = handleMock();
    const first = center.start({ cellId: 'cell1', notebookTitle: 'Demo', scope, kernel, source: 'while True: pass', variables: {}, manager: manager(runtime.handle), request: async <T = Record<string, unknown>>(): Promise<T> => ({}) as T });
    const second = center.start({ cellId: 'cell1', notebookTitle: 'Demo', scope, kernel, source: 'while True: pass', variables: {}, manager: manager(runtime.handle), request: async <T = Record<string, unknown>>(): Promise<T> => ({}) as T });
    expect(second.id).toBe(first.id);
    await center.cancel(first.id);
    expect(runtime.handle.cancel).toHaveBeenCalled();
    runtime.finish({ status: 'cancelled', outputs: [], durationMs: 1 });
    await vi.waitFor(() => expect(center.get(first.id)?.status).toBe('cancelled'));
  });
});
