import { randomUUID } from 'node:crypto';

import type { AgentEvent, AgentToolDefinition, ToolExecutionContext } from '../types.js';
import { CodeActArtifactRecorder, hashCodeCellSource, spillOversizedCellOutput } from './codeActArtifacts.js';
import { buildCodeActToolNameMap } from './codeActSdk.js';
import { buildCodeActEnvironment, assertCodeActBackend, resolveCodeActSettings } from './codeActPolicy.js';
import { ContainerKernelAdapter } from './containerKernelAdapter.js';
import { CodeActHostRpcDispatcher } from './hostRpcDispatcher.js';
import { CodeActKernelPool } from './kernelPool.js';
import { ProcessKernelAdapter } from './processKernelAdapter.js';
import type {
  CodeActBackendStatus,
  CodeActKernelAdapter,
  CodeActLanguage,
  CodeActSettings,
  CodeCellExecutionRecord,
} from './types.js';

export interface CodeActServiceOptions {
  processAdapter?: CodeActKernelAdapter;
  containerAdapter?: CodeActKernelAdapter;
  artifacts?: CodeActArtifactRecorder;
  onEvent?: (event: AgentEvent) => void;
}

export class CodeActService {
  readonly settings;
  private readonly adapter: CodeActKernelAdapter;
  private readonly artifacts: CodeActArtifactRecorder;
  private readonly pool: CodeActKernelPool;
  private readonly activeContexts = new Map<string, ToolExecutionContext>();
  private readonly onEvent?: (event: AgentEvent) => void;

  constructor(input: CodeActSettings, options: CodeActServiceOptions = {}) {
    this.settings = resolveCodeActSettings(input);
    this.artifacts = options.artifacts ?? new CodeActArtifactRecorder();
    this.onEvent = options.onEvent;
    this.adapter = this.settings.backend === 'container'
      ? options.containerAdapter ?? new ContainerKernelAdapter({
          image: this.settings.containerImage,
          memoryMb: this.settings.containerMemoryMb,
          cpuLimit: this.settings.containerCpuLimit,
        })
      : options.processAdapter ?? new ProcessKernelAdapter(this.settings.pythonCommand);
    this.pool = new CodeActKernelPool(
      this.adapter,
      this.settings.idleTimeoutMs,
      buildCodeActEnvironment(this.settings.environmentAllowlist),
      this.settings.maxOutputChars,
      this.settings.maxOutputBytes,
      (sessionId, generation, reason) => this.emitKernelEvent(
        sessionId, generation, 'kernel.stopped', reason,
      ),
    );
  }

  async selfCheck(): Promise<CodeActBackendStatus> {
    return this.adapter.selfCheck();
  }

  async execute(input: {
    language: CodeActLanguage;
    code: string;
    timeoutMs?: number;
    context: ToolExecutionContext;
    hostTools?: readonly AgentToolDefinition[];
  }): Promise<CodeCellExecutionRecord> {
    await assertCodeActBackend(this.settings, this.adapter);
    if (input.language !== 'python') throw new Error(`Unsupported CodeAct language: ${input.language}.`);
    const sessionId = input.context.sessionId ?? input.context.runId;
    const executionId = input.context.toolUseId ?? randomUUID();
    const sourceHash = hashCodeCellSource(input.code);
    const startedAt = new Date().toISOString();
    const cellController = new AbortController();
    const abortCell = () => cellController.abort(input.context.signal?.reason);
    if (input.context.signal?.aborted) abortCell();
    else input.context.signal?.addEventListener('abort', abortCell, { once: true });
    const executionContext: ToolExecutionContext = {
      ...input.context,
      signal: cellController.signal,
    };
    this.activeContexts.set(sessionId, executionContext);
    try {
      const lease = await this.pool.acquire(sessionId, input.context.cwd);
      if (lease.lifecycle !== 'reused') {
        this.emitKernelEvent(
          sessionId,
          lease.kernel.generation,
          lease.lifecycle === 'started' ? 'kernel.started' : 'kernel.restarted',
        );
      }
      this.emit({
      type: 'code_cell.started',
      runId: input.context.runId,
      sessionId,
      executionId,
      generation: lease.kernel.generation,
      language: input.language,
      sourceHash,
      timestamp: startedAt,
      }, executionContext);
      const dispatcher = new CodeActHostRpcDispatcher(
        input.hostTools ?? [], executionContext, this.artifacts, sessionId,
        this.settings.maxParallelSubCalls,
      );
      const toolNameMap = buildCodeActToolNameMap(input.hostTools ?? []);
      const result = await lease.kernel.execute({
      executionId,
      sessionId,
      language: input.language,
      code: input.code,
      workDir: input.context.cwd,
      timeoutMs: input.timeoutMs ?? this.settings.executionTimeoutMs,
      // The per-cell controller (not the raw run signal) is the kernel's
      // settlement authority: aborting the controller interrupts the kernel
      // AND the nested host tools started from this cell.
      signal: executionContext.signal,
      abort: reason => cellController.abort(reason),
      hostRpc: dispatcher.handler(),
      toolNameMap,
      onDelta: (stream, delta) => this.emit({
        type: 'code_cell.delta',
        runId: input.context.runId,
        sessionId,
        executionId,
        generation: lease.kernel.generation,
        stream,
        delta,
        timestamp: new Date().toISOString(),
      }, executionContext),
      });
      const completedAt = new Date().toISOString();
      const record: CodeCellExecutionRecord = {
      ...result,
      sourceHash,
      code: input.code,
      language: input.language,
      startedAt,
      completedAt,
      };
      // Spill oversized completed output instead of silently truncating:
      // full text lands in a session artifact with a bounded preview.
      await spillOversizedCellOutput({
        artifacts: this.artifacts,
        workDir: input.context.cwd,
        sessionId,
        executionId,
        maxChars: this.settings.maxOutputChars,
        result: record,
      });
      // Forward successful nested tools' turn-control surface (dsh
      // exec.deferContext / exec.concludeTurn): only a completed cell may
      // carry them, mirroring the engine's transactional rule.
      if (result.status === 'completed') {
        const nestedContexts = dispatcher.takeDeferredContexts();
        for (const nestedContext of nestedContexts) {
          input.context.deferAdditionalContext?.(nestedContext);
        }
        if (dispatcher.turnConcluded) input.context.concludeTurn?.();
      }
      record.recordPath = await this.artifacts.record(input.context.cwd, record);
      const eventType = result.status === 'completed'
        ? 'code_cell.completed'
        : result.status === 'interrupted'
          ? 'code_cell.interrupted'
          : 'code_cell.failed';
      this.emit({
      type: eventType,
      runId: input.context.runId,
      sessionId,
      executionId,
      generation: result.generation,
      result,
      timestamp: completedAt,
      }, executionContext);
      if (result.stateLost) await this.pool.invalidate(sessionId, result.status);
      else this.pool.touch(sessionId);
      return record;
    } finally {
      input.context.signal?.removeEventListener('abort', abortCell);
      if (!cellController.signal.aborted) {
        cellController.abort(new Error('CodeCell execution settled.'));
      }
      this.activeContexts.delete(sessionId);
    }
  }

  status(sessionId: string): ReturnType<CodeActKernelPool['status']> {
    return this.pool.status(sessionId);
  }

  async interrupt(sessionId: string, executionId: string): Promise<boolean> {
    return this.pool.interrupt(sessionId, executionId);
  }

  async restart(sessionId: string): Promise<void> {
    await this.pool.invalidate(sessionId, 'manual restart');
  }

  async stop(sessionId: string): Promise<void> {
    await this.pool.invalidate(sessionId, 'manual stop');
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  private emitKernelEvent(
    sessionId: string,
    generation: number,
    type: 'kernel.started' | 'kernel.restarted' | 'kernel.stopped',
    reason?: string,
  ): void {
    const context = this.activeContexts.get(sessionId);
    this.emit({
      type,
      runId: context?.runId ?? `codeact:${sessionId}`,
      sessionId,
      generation,
      reason,
      timestamp: new Date().toISOString(),
    }, context);
  }

  private emit(event: AgentEvent, context?: ToolExecutionContext): void {
    const runtimeEmit = context?.runtime?.emit;
    try { runtimeEmit?.(event); } catch { /* A completed stream may already be closed. */ }
    if (this.onEvent !== runtimeEmit) {
      try { this.onEvent?.(event); } catch { /* Observers cannot break kernel cleanup. */ }
    }
  }
}
