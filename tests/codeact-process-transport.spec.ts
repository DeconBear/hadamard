import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startKernelProcess } from '../src/codeact/processKernelAdapter.js';
import type { CodeActKernel, CodeCellExecutionRequest } from '../src/codeact/types.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const kernels: CodeActKernel[] = [];
afterEach(async () => {
  await Promise.all(kernels.splice(0).map(kernel => kernel.stop()));
  vi.clearAllMocks();
});

function pipeError(): NodeJS.ErrnoException {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -4047, syscall: 'write' });
}

async function fakeKernel(onWrite: (line: string, callback: (error?: Error | null) => void) => void) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({ write(chunk, _encoding, callback) { onWrite(String(chunk), callback); } });
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout, stderr, killed: false, exitCode: null as number | null,
    kill: vi.fn(() => {
      child.killed = true;
      queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0, 'SIGTERM'); });
      return true;
    }),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
  const pending = startKernelProcess({
    sessionId: 'transport-test', generation: 1, workDir: process.cwd(), environment: {},
    maxOutputBytes: 10_000, maxOutputChars: 10_000,
  }, { command: 'fake-python', args: [], cwd: process.cwd(), env: {} });
  stdout.write('{"v":1,"type":"ready","pid":1}\n');
  const kernel = await pending;
  kernels.push(kernel);
  return { kernel, child, stdin, stdout };
}

function request(timeoutMs = 1_000): CodeCellExecutionRequest {
  return { sessionId: 'transport-test', executionId: 'cell', language: 'python', code: '1 + 1', workDir: process.cwd(), timeoutMs };
}

// Let Writable deliver both its write callback and its asynchronous error event.
function flushStreamEvents(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }

describe('CodeAct process stdin transport failures', () => {
  it('settles an active cell as failed when the write callback and stream both report EPIPE', async () => {
    const { kernel, stdin, child } = await fakeKernel((_line, callback) => { queueMicrotask(() => callback(pipeError())); });
    const events: Error[] = [];
    // The kernel itself must own a listener, not rely on test/application listeners.
    expect(stdin.listenerCount('error')).toBeGreaterThan(0);
    stdin.on('error', error => events.push(error));
    const result = await kernel.execute(request());
    await flushStreamEvents();
    expect(events).toHaveLength(1);
    expect(result).toMatchObject({ status: 'failed', failureKind: 'kernel-exit', stateLost: true });
    expect(result.error).toContain('EPIPE');
    expect(child.kill).toHaveBeenCalledTimes(1);
    await expect(kernel.execute(request())).rejects.toMatchObject({ code: 'CODEACT_KERNEL_STOPPED' });
  });

  it('preserves a settled timeout when a pending stdin write fails after termination', async () => {
    let completeWrite!: (error?: Error | null) => void;
    const { kernel, stdin } = await fakeKernel((_line, callback) => { completeWrite = callback; });
    const result = await kernel.execute(request(10));
    expect(result).toMatchObject({ status: 'failed', failureKind: 'timeout', stateLost: true });
    await kernel.stop();
    expect(stdin.listenerCount('error')).toBeGreaterThan(0);
    completeWrite(pipeError());
    await flushStreamEvents();
    expect(result).toMatchObject({ status: 'failed', failureKind: 'timeout', stateLost: true });
    expect(result.error).toContain('timed out');
  });

  it('handles delayed shutdown EPIPE after a successful cell without changing the settled result', async () => {
    let shutdownWrite!: (error?: Error | null) => void;
    const { kernel, stdout } = await fakeKernel((line, callback) => {
      if (JSON.parse(line).type === 'shutdown') shutdownWrite = callback;
      else callback();
    });
    const pending = kernel.execute(request());
    stdout.write('{"v":1,"type":"result","executionId":"cell","ok":true,"durationMs":1,"result":{"type":"int","value":2}}\n');
    const result = await pending;
    await kernel.stop();
    shutdownWrite(pipeError());
    await flushStreamEvents();
    expect(result).toMatchObject({ status: 'completed', result: { value: 2 } });
  });

  it('fails an active cell promptly when stdin is already closed rather than waiting for its timeout', async () => {
    const { kernel, stdin } = await fakeKernel((_line, callback) => callback());
    stdin.destroy();
    const result = await kernel.execute(request());
    expect(result).toMatchObject({ status: 'failed', failureKind: 'kernel-exit', stateLost: true });
    expect(result.error).toContain('input stream is closed');
  });

  it('converts a synchronous write failure into a failed execution record', async () => {
    const { kernel, stdin } = await fakeKernel((_line, callback) => callback());
    vi.spyOn(stdin, 'write').mockImplementation(() => { throw pipeError(); });
    const result = await kernel.execute(request());
    expect(result).toMatchObject({ status: 'failed', failureKind: 'kernel-exit', stateLost: true });
    expect(result.error).toContain('EPIPE');
  });
});
