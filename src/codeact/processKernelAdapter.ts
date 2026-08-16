import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { HadamardSdkError } from '../errors.js';
import {
  DEFAULT_MAX_PROTOCOL_LINE_BYTES,
  KernelLineDecoder,
  encodeKernelMessage,
  type KernelInboundMessage,
  type KernelOutboundMessage,
} from './kernelProtocol.js';
import { PYTHON_KERNEL_PROGRAM } from './pythonKernelProgram.js';
import type {
  CodeActBackendStatus,
  CodeActHostRpcResponse,
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
  startedClock: number;
  stdout: string;
  stderr: string;
  artifacts: CodeCellExecutionResult['artifacts'];
  outputBytes: number;
  outputLimit: boolean;
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
    if (request.signal?.aborted) {
      return {
        executionId: request.executionId,
        sessionId: this.sessionId,
        generation: this.generation,
        status: 'interrupted',
        stdout: '',
        stderr: '',
        artifacts: [],
        durationMs: 0,
        stateLost: false,
        failureKind: 'interrupt',
        error: 'CodeCell execution was aborted before dispatch.',
      };
    }
    return new Promise<CodeCellExecutionResult>((resolve) => {
      const active: ActiveExecution = {
        request,
        startedClock: Date.now(),
        stdout: '',
        stderr: '',
        artifacts: [],
        outputBytes: 0,
        outputLimit: false,
        resolve,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        settled: false,
      };
      active.timer = setTimeout(() => {
        void this.settleActive(active, {
          status: 'failed',
          error: `CodeCell timed out after ${request.timeoutMs}ms. Kernel state was lost.`,
          durationMs: request.timeoutMs,
          stateLost: true,
          failureKind: 'timeout',
        }, { abortFirst: new HadamardSdkError(`CodeCell timed out after ${request.timeoutMs}ms.`) });
        this.child.kill();
      }, request.timeoutMs);
      if (request.signal) {
        active.abortListener = () => { void this.interrupt(request.executionId); };
        request.signal.addEventListener('abort', active.abortListener, { once: true });
      }
      this.active = active;
      this.write({
        v: 1,
        type: 'execute',
        executionId: request.executionId,
        code: request.code,
        ...(request.toolNameMap && Object.keys(request.toolNameMap).length > 0
          ? { toolNameMap: request.toolNameMap }
          : {}),
      });
    });
  }

  async interrupt(executionId: string): Promise<boolean> {
    const active = this.active;
    if (!active || active.request.executionId !== executionId || active.settled) return false;
    await this.settleActive(active, {
      status: 'interrupted',
      error: 'CodeCell execution was interrupted. Kernel state was lost.',
      durationMs: Date.now() - active.startedClock,
      stateLost: true,
      failureKind: 'interrupt',
    }, { abortFirst: new HadamardSdkError('CodeCell execution was interrupted.') });
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
      // Capture the display-bounded text first so a hard budget stop still
      // carries the partial stream it observed.
      if (message.stream === 'stdout') {
        active.stdout = appendLimited(active.stdout, message.delta, this.options.maxOutputChars);
      } else {
        active.stderr = appendLimited(active.stderr, message.delta, this.options.maxOutputChars);
      }
      this.accountOutput(active, Buffer.byteLength(message.delta));
      if (active.settled) return;
      active.request.onDelta?.(message.stream, message.delta);
      return;
    }
    if (message.type === 'host_rpc') {
      this.accountOutput(active, Buffer.byteLength(JSON.stringify(message.request)));
      if (active.settled) return;
      void this.handleHostRpc(active, message);
      return;
    }
    if (message.type === 'result') {
      if (message.failureKind === 'output-limit') {
        // Kernel-side precheck rejected an oversized payload: one unique
        // output-limit failure, never a protocol error or a completed cell.
        void this.settleActive(active, {
          status: 'failed',
          error: message.error ?? 'CodeCell output exceeded the protocol payload limit.',
          durationMs: message.durationMs,
          stateLost: true,
          failureKind: 'output-limit',
          outputLimit: true,
        }, { abortFirst: new HadamardSdkError('CodeCell output exceeded the protocol payload limit.') });
        this.child.kill();
        return;
      }
      this.accountOutput(active, Buffer.byteLength(JSON.stringify(message)));
      if (active.settled) return;
      // dsh settlement semantics: the run-scoped abort fires when the run
      // settles for ANY reason, so a stray in-flight sub-dispatch is aborted
      // instead of being awaited up to toolTimeoutMs or orphaned (its
      // host_rpc response would be dropped once the active settles).
      void this.settleActive(active, {
        status: message.ok ? 'completed' : 'failed',
        result: message.result,
        error: message.error,
        durationMs: message.durationMs,
        resourceUsage: message.resourceUsage,
        ...(message.ok ? {} : { failureKind: 'exception' as const }),
      }, { abortFirst: new HadamardSdkError('CodeCell execution settled.') });
    }
  }

  private async handleHostRpc(
    active: ActiveExecution,
    message: Extract<KernelInboundMessage, { type: 'host_rpc' }>,
  ): Promise<void> {
    const response: CodeActHostRpcResponse = active.request.hostRpc
      ? await active.request.hostRpc.dispatch(message.request).catch(error => ({
          id: message.request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      : { id: message.request.id, ok: false, error: `Host RPC method ${message.request.method} is unavailable.` };
    if (response.artifact) active.artifacts.push(response.artifact);
    if (!active.settled) {
      this.writeHostRpcResult(active, message.executionId, response);
    }
  }

  /** Write a host RPC response, shrinking any payload that would breach the decoder's single-line limit. */
  private writeHostRpcResult(
    active: ActiveExecution,
    executionId: string,
    response: CodeActHostRpcResponse,
  ): void {
    let line = encodeKernelMessage({ v: 1, type: 'host_rpc_result', executionId, response });
    if (Buffer.byteLength(line, 'utf8') > DEFAULT_MAX_PROTOCOL_LINE_BYTES) {
      line = encodeKernelMessage({
        v: 1,
        type: 'host_rpc_result',
        executionId,
        response: {
          id: response.id,
          ok: false,
          error: `Host RPC response exceeded the protocol line limit of ${DEFAULT_MAX_PROTOCOL_LINE_BYTES} bytes.`,
        },
      });
    }
    this.accountOutput(active, Buffer.byteLength(line, 'utf8'));
    if (!active.settled) this.writeLine(line);
  }

  private accountOutput(active: ActiveExecution, bytes: number): void {
    active.outputBytes += bytes;
    if (active.outputBytes > this.options.maxOutputBytes && !active.outputLimit) {
      active.outputLimit = true;
      void this.settleActive(active, {
        status: 'failed',
        error: `CodeCell output exceeded the ${this.options.maxOutputBytes}-byte output budget. Kernel state was lost.`,
        durationMs: Date.now() - active.startedClock,
        stateLost: true,
        failureKind: 'output-limit',
        outputLimit: true,
      }, { abortFirst: new HadamardSdkError('CodeCell output budget exceeded.') });
      this.child.kill();
    }
  }

  /**
   * The single settlement path: stop new dispatches, abort the per-cell
   * controller so started nested calls observe the abort, then await their
   * drain before resolving. The outer tool result is therefore always the
   * cell's last execution event.
   */
  private settleActive(
    active: ActiveExecution,
    partial: Pick<CodeCellExecutionResult, 'status' | 'durationMs'> & Partial<CodeCellExecutionResult>,
    options: { abortFirst?: Error } = {},
  ): Promise<void> {
    if (active.settled) return Promise.resolve();
    active.settled = true;
    clearTimeout(active.timer);
    if (active.abortListener) active.request.signal?.removeEventListener('abort', active.abortListener);
    const drain = active.request.hostRpc?.drain();
    if (options.abortFirst) active.request.abort?.(options.abortFirst);
    return (drain ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        this.active = undefined;
        active.resolve({
          executionId: active.request.executionId,
          sessionId: this.sessionId,
          generation: this.generation,
          stdout: active.stdout,
          stderr: active.stderr,
          artifacts: active.artifacts,
          ...(active.outputLimit ? { outputLimit: true, failureKind: 'output-limit' as const } : {}),
          ...partial,
        });
      });
  }

  private onProcessFailure(error: Error): void {
    this.stopped = true;
    this.rejectReady(error);
    const active = this.active;
    if (active && !active.settled) {
      void this.settleActive(active, {
        status: 'failed',
        error: `${error.message} Kernel state was lost.`,
        durationMs: Date.now() - active.startedClock,
        stateLost: true,
        failureKind: 'kernel-exit',
      }, { abortFirst: error });
    }
  }

  private write(message: KernelOutboundMessage): void {
    this.writeLine(encodeKernelMessage(message));
  }

  private writeLine(line: string): void {
    if (this.child.stdin.destroyed) return;
    this.child.stdin.write(line);
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
