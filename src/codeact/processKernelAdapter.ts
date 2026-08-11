import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { HadamardSdkError } from '../errors.js';
import {
  KernelLineDecoder,
  encodeKernelMessage,
  type KernelInboundMessage,
} from './kernelProtocol.js';
import { PYTHON_KERNEL_PROGRAM } from './pythonKernelProgram.js';
import type {
  CodeActBackendStatus,
  CodeActKernel,
  CodeActKernelAdapter,
  CodeActKernelStartOptions,
  CodeCellExecutionRequest,
  CodeCellExecutionResult,
} from './types.js';

export interface KernelProcessInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

interface ActiveExecution {
  request: CodeCellExecutionRequest;
  stdout: string;
  stderr: string;
  artifacts: CodeCellExecutionResult['artifacts'];
  resolve(result: CodeCellExecutionResult): void;
  timer: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
  settled: boolean;
}

export class ProcessKernelAdapter implements CodeActKernelAdapter {
  readonly backend = 'process' as const;
  readonly isolation = 'trusted-only' as const;

  constructor(private readonly pythonCommand: string) {}

  async selfCheck(): Promise<CodeActBackendStatus> {
    const check = await checkCommand(this.pythonCommand, ['--version']);
    return {
      backend: this.backend,
      available: check.available,
      isolation: this.isolation,
      detail: check.available
        ? `Python process backend available (${check.detail}); this is not a strong security sandbox.`
        : `Python process backend unavailable: ${check.detail}`,
    };
  }

  async start(options: CodeActKernelStartOptions): Promise<CodeActKernel> {
    return startKernelProcess(options, {
      command: this.pythonCommand,
      args: ['-u', '-c', PYTHON_KERNEL_PROGRAM],
      cwd: options.workDir,
      env: options.environment,
    });
  }
}

export async function startKernelProcess(
  options: CodeActKernelStartOptions,
  invocation: KernelProcessInvocation,
): Promise<CodeActKernel> {
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const kernel = new JsonLineProcessKernel(child, options);
  await kernel.ready();
  return kernel;
}

class JsonLineProcessKernel implements CodeActKernel {
  readonly sessionId: string;
  readonly generation: number;
  private readonly decoder = new KernelLineDecoder();
  private readonly readyPromise: Promise<void>;
  private readonly exitPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private active?: ActiveExecution;
  private stopped = false;
  private stderrDiagnostic = '';

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: CodeActKernelStartOptions,
  ) {
    this.sessionId = options.sessionId;
    this.generation = options.generation;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.exitPromise = new Promise<void>(resolve => {
      child.once('exit', () => resolve());
    });
    child.stdout.on('data', chunk => this.onStdout(chunk as Buffer));
    child.stderr.on('data', chunk => {
      this.stderrDiagnostic = appendLimited(this.stderrDiagnostic, String(chunk), 16_000);
    });
    child.once('error', error => this.onProcessFailure(error));
    child.once('exit', (code, signal) => {
      this.onProcessFailure(new HadamardSdkError(
        `CodeAct kernel exited (code=${code ?? 'none'}, signal=${signal ?? 'none'}).${this.stderrDiagnostic ? ` ${this.stderrDiagnostic}` : ''}`,
        'CODEACT_KERNEL_EXITED',
      ));
    });
  }

  async ready(): Promise<void> {
    const timer = setTimeout(() => {
      this.rejectReady(new HadamardSdkError('CodeAct kernel did not become ready.', 'CODEACT_KERNEL_START_TIMEOUT'));
      this.child.kill();
    }, 10_000);
    try {
      await this.readyPromise;
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(request: CodeCellExecutionRequest): Promise<CodeCellExecutionResult> {
    if (this.stopped || this.child.killed) {
      throw new HadamardSdkError('CodeAct kernel is stopped.', 'CODEACT_KERNEL_STOPPED');
    }
    if (this.active) {
      throw new HadamardSdkError('CodeAct kernel already has an active cell.', 'CODEACT_KERNEL_BUSY');
    }
    return new Promise<CodeCellExecutionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.finishActive({
          status: 'failed',
          error: `CodeCell timed out after ${request.timeoutMs}ms. Kernel state was lost.`,
          durationMs: request.timeoutMs,
          stateLost: true,
        });
        this.child.kill();
      }, request.timeoutMs);
      const active: ActiveExecution = {
        request,
        stdout: '',
        stderr: '',
        artifacts: [],
        resolve,
        timer,
        settled: false,
      };
      if (request.signal) {
        active.abortListener = () => { void this.interrupt(request.executionId); };
        request.signal.addEventListener('abort', active.abortListener, { once: true });
      }
      this.active = active;
      this.write({ v: 1, type: 'execute', executionId: request.executionId, code: request.code });
    });
  }

  async interrupt(executionId: string): Promise<boolean> {
    if (!this.active || this.active.request.executionId !== executionId || this.active.settled) return false;
    this.finishActive({
      status: 'interrupted',
      error: 'CodeCell execution was interrupted. Kernel state was lost.',
      durationMs: 0,
      stateLost: true,
    });
    this.child.kill();
    return true;
  }

  async stop(): Promise<void> {
    if (!this.stopped) this.stopped = true;
    if (this.child.exitCode === null && !this.child.killed) {
      this.write({ v: 1, type: 'shutdown' });
      this.child.kill();
    }
    if (this.child.exitCode === null) {
      await Promise.race([
        this.exitPromise,
        new Promise<void>(resolve => setTimeout(resolve, 2_000)),
      ]);
    }
  }

  private onStdout(chunk: Buffer): void {
    let messages: KernelInboundMessage[];
    try {
      messages = this.decoder.push(chunk);
    } catch (error) {
      this.onProcessFailure(error instanceof Error ? error : new Error(String(error)));
      this.child.kill();
      return;
    }
    for (const message of messages) this.onMessage(message);
  }

  private onMessage(message: KernelInboundMessage): void {
    if (message.type === 'ready') {
      this.resolveReady();
      return;
    }
    const active = this.active;
    if (!active || message.executionId !== active.request.executionId || active.settled) return;
    if (message.type === 'stream') {
      if (message.stream === 'stdout') {
        active.stdout = appendLimited(active.stdout, message.delta, this.options.maxOutputChars);
      } else {
        active.stderr = appendLimited(active.stderr, message.delta, this.options.maxOutputChars);
      }
      active.request.onDelta?.(message.stream, message.delta);
      return;
    }
    if (message.type === 'host_rpc') {
      void this.handleHostRpc(active, message);
      return;
    }
    if (message.type === 'result') {
      this.finishActive({
        status: message.ok ? 'completed' : 'failed',
        result: message.result,
        error: message.error,
        durationMs: message.durationMs,
        resourceUsage: message.resourceUsage,
      });
    }
  }

  private async handleHostRpc(
    active: ActiveExecution,
    message: Extract<KernelInboundMessage, { type: 'host_rpc' }>,
  ): Promise<void> {
    const response: import('./types.js').CodeActHostRpcResponse = active.request.hostRpc
      ? await active.request.hostRpc(message.request).catch(error => ({
          id: message.request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      : { id: message.request.id, ok: false, error: `Host RPC method ${message.request.method} is unavailable.` };
    if (response.artifact) active.artifacts.push(response.artifact);
    if (!active.settled) {
      this.write({
        v: 1,
        type: 'host_rpc_result',
        executionId: message.executionId,
        response,
      });
    }
  }

  private finishActive(
    partial: Pick<CodeCellExecutionResult, 'status' | 'durationMs'>
      & Partial<CodeCellExecutionResult>,
  ): void {
    const active = this.active;
    if (!active || active.settled) return;
    active.settled = true;
    clearTimeout(active.timer);
    if (active.abortListener) active.request.signal?.removeEventListener('abort', active.abortListener);
    this.active = undefined;
    active.resolve({
      executionId: active.request.executionId,
      sessionId: this.sessionId,
      generation: this.generation,
      stdout: active.stdout,
      stderr: active.stderr,
      artifacts: active.artifacts,
      ...partial,
    });
  }

  private onProcessFailure(error: Error): void {
    this.stopped = true;
    this.rejectReady(error);
    if (this.active && !this.active.settled) {
      this.finishActive({
        status: 'failed',
        error: `${error.message} Kernel state was lost.`,
        durationMs: 0,
        stateLost: true,
      });
    }
  }

  private write(message: Parameters<typeof encodeKernelMessage>[0]): void {
    if (this.child.stdin.destroyed) return;
    this.child.stdin.write(encodeKernelMessage(message));
  }
}

async function checkCommand(command: string, args: string[]): Promise<{ available: boolean; detail: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ available: false, detail: 'self-check timed out' });
    }, 5_000);
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.once('error', error => {
      clearTimeout(timer);
      resolve({ available: false, detail: error.message });
    });
    child.once('exit', code => {
      clearTimeout(timer);
      resolve({ available: code === 0, detail: output.trim() || `exit code ${code}` });
    });
  });
}

function appendLimited(current: string, delta: string, limit: number): string {
  if (current.length >= limit) return current;
  const room = limit - current.length;
  if (delta.length <= room) return current + delta;
  const marker = '\n[output truncated by Hadamard]';
  if (limit <= marker.length) return (current + delta).slice(0, limit);
  return `${(current + delta).slice(0, limit - marker.length)}${marker}`;
}
