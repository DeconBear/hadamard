import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKernelManager, type KernelManager } from '../src/hcanvas/client/kernelManager.js';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static OPEN = 1;
  static CLOSED = 2;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
    queueMicrotask(() => this.emit('hello', {}));
  }
  addEventListener(name: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }
  close(): void { this.readyState = 2; }
  emit(name: string, data: unknown): void {
    if (this.readyState === 2) return;
    if (name === 'hello') this.readyState = 1;
    for (const listener of this.listeners.get(name) || []) listener(new MessageEvent(name, { data: typeof data === 'string' ? data : JSON.stringify(data) }));
  }
}

const originalEventSource = globalThis.EventSource;
const managers: KernelManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  vi.stubGlobal('EventSource', originalEventSource);
  FakeEventSource.instances = [];
});

describe('kernel client event ordering', () => {
  it('preserves outputs and completion that arrive before execution registration', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    let ensureCount = 0;
    const manager = createKernelManager({
      token: () => 'test',
      request: async <T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T> => {
        if (pathname === '/api/kernels/ensure') {
          ensureCount += 1;
          return { session: { sessionId: 'ks_fast' } } as T;
        }
        if (pathname.endsWith('/execute')) {
          const source = FakeEventSource.instances.at(-1)!;
          source.emit('runtime', { kind: 'kernel', executionId: 'exec_fast', event: 'stream', payload: { stream: 'stdout', text: 'done\n' } });
          source.emit('runtime', { kind: 'kernel', executionId: 'exec_fast', event: 'execution_finished', payload: { status: 'ok', durationMs: 1 } });
          return { executionId: 'exec_fast', sessionId: 'ks_fast' } as T;
        }
        throw new Error('Unexpected request: ' + pathname + ' ' + String(init?.method));
      },
    });
    managers.push(manager);
    const scope = { kind: 'page' as const, key: 'p1' };
    const sessions = await Promise.all([manager.ensure('python', scope), manager.ensure('python', scope)]);
    expect(sessions).toEqual(['ks_fast', 'ks_fast']);
    expect(ensureCount).toBe(1);
    const first = await manager.execute('python', 'print(1)', { scope });
    const result = await first.done;
    expect(result.status).toBe('ok');
    expect(result.outputs).toEqual([{ kind: 'stream', stream: 'stdout', text: 'done\n' }]);
  });

  it('reconciles execution results after reconnect without premature abort', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const manager = createKernelManager({
      token: () => 'test',
      request: async <T = Record<string, unknown>>(pathname: string): Promise<T> => {
        if (pathname === '/api/kernels/ensure') return { session: { sessionId: 'ks_reconnect' } } as T;
        if (pathname.endsWith('/execute')) return { executionId: 'exec_reconnect', sessionId: 'ks_reconnect' } as T;
        if (pathname.startsWith('/api/kernels/executions/')) {
          return { state: 'completed', result: { status: 'ok', durationMs: 5, outputs: { events: [{ type: 'stream', name: 'stdout', text: 'recovered\n' }] } } } as T;
        }
        throw new Error('Unexpected request: ' + pathname);
      },
    });
    managers.push(manager);
    const scope = { kind: 'page' as const, key: 'p2' };
    const handle = await manager.execute('python', 'while True: pass', { scope });
    const statuses: string[] = [];
    handle.onStatus(status => statuses.push(status));
    let settled = false;
    void handle.done.then(() => { settled = true; });
    const source = FakeEventSource.instances.at(-1)!;
    source.emit('runtime', { seq: 41, kind: 'kernel', executionId: 'other', event: 'state', payload: {} });
    source.emit('error', {});
    expect(statuses).toContain('disconnected');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    source.emit('hello', {});
    const result = await handle.done;
    expect(result.status).toBe('ok');
    expect(result.outputs).toEqual([{ kind: 'stream', stream: 'stdout', text: 'recovered\n' }]);
    source.close();
    await manager.execute('python', 'print(1)', { scope });
    expect(FakeEventSource.instances.at(-1)!.url).toContain('after=41');
    expect(FakeEventSource.instances[0]!.url).not.toContain('after=');
  });

  it('deduplicates the same sequenced runtime event replayed after a reconnect', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const manager = createKernelManager({
      token: () => 'test',
      request: async <T = Record<string, unknown>>(pathname: string): Promise<T> => {
        if (pathname === '/api/kernels/ensure') return { session: { sessionId: 'ks_dedupe' } } as T;
        if (pathname.endsWith('/execute')) return { executionId: 'exec_dedupe', sessionId: 'ks_dedupe' } as T;
        throw new Error('Unexpected request: ' + pathname);
      },
    });
    managers.push(manager);
    const scope = { kind: 'page' as const, key: 'p_dedupe' };
    const handle = await manager.execute('python', 'print(1)', { scope });
    const source = FakeEventSource.instances.at(-1)!;
    const replayed = { seq: 7, kind: 'kernel', executionId: 'exec_dedupe', event: 'stream', payload: { stream: 'stdout', text: 'once\n' } };
    source.emit('runtime', replayed);
    source.emit('runtime', replayed);
    source.emit('runtime', { seq: 8, kind: 'kernel', executionId: 'exec_dedupe', event: 'execution_finished', payload: { status: 'ok' } });
    const result = await handle.done;
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toEqual({ kind: 'stream', stream: 'stdout', text: 'once\n' });
  });

  it('settles a lost execution promptly instead of waiting for the five-minute watchdog', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    let lookups = 0;
    const manager = createKernelManager({
      token: () => 'test',
      reconcileDelayMs: 20,
      request: async <T = Record<string, unknown>>(pathname: string): Promise<T> => {
        if (pathname === '/api/kernels/ensure') return { session: { sessionId: 'ks_lost' } } as T;
        if (pathname.endsWith('/execute')) return { executionId: 'exec_lost', sessionId: 'ks_lost' } as T;
        if (pathname.startsWith('/api/kernels/executions/')) {
          lookups += 1;
          return { state: lookups < 3 ? 'running' : 'unknown' } as T;
        }
        throw new Error('Unexpected request: ' + pathname);
      },
    });
    managers.push(manager);
    const scope = { kind: 'page' as const, key: 'p_lost' };
    const handle = await manager.execute('python', 'while True: pass', { scope });
    const statuses: string[] = [];
    handle.onStatus(status => statuses.push(status));
    const source = FakeEventSource.instances.at(-1)!;
    const started = Date.now();
    source.emit('error', {});
    expect(statuses).toContain('disconnected');
    const result = await handle.done;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.status).toBe('aborted');
    expect(result.error?.ename).toBe('KernelExecutionLost');
    expect(result.error?.evalue).toMatch(/lost/i);
    expect(result.error?.evalue).toMatch(/rerun/i);
    expect(lookups).toBe(3);
    expect(statuses).toContain('running');
  }, 10_000);

  it('does not poll execution lookups while the SSE stream is healthy', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    let lookups = 0;
    const manager = createKernelManager({
      token: () => 'test',
      reconcileDelayMs: 20,
      request: async <T = Record<string, unknown>>(pathname: string): Promise<T> => {
        if (pathname === '/api/kernels/ensure') return { session: { sessionId: 'ks_healthy' } } as T;
        if (pathname.endsWith('/execute')) return { executionId: 'exec_healthy', sessionId: 'ks_healthy' } as T;
        if (pathname.startsWith('/api/kernels/executions/')) {
          lookups += 1;
          return { state: 'running' } as T;
        }
        throw new Error('Unexpected request: ' + pathname);
      },
    });
    managers.push(manager);
    const scope = { kind: 'page' as const, key: 'p_healthy' };
    const handle = await manager.execute('python', 'while True: pass', { scope });
    const source = FakeEventSource.instances.at(-1)!;
    source.emit('hello', {});
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(lookups).toBe(1);
    source.emit('runtime', { seq: 1, kind: 'kernel', executionId: 'exec_healthy', event: 'execution_finished', payload: { status: 'ok' } });
    const result = await handle.done;
    expect(result.status).toBe('ok');
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(lookups).toBe(1);
  }, 10_000);
});
