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
  constructor(_url: string) {
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
});
