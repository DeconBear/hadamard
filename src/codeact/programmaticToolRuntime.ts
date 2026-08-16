import { randomUUID } from 'node:crypto';

import { HadamardSdkError } from '../errors.js';
import type { AgentToolDefinition, ToolExecutionContext } from '../types.js';
import { CodeActArtifactRecorder } from './codeActArtifacts.js';
import { buildCodeActToolNameMap } from './codeActSdk.js';
import { assertCodeActBackend, assertWorkerThreadPtcBackend, buildCodeActEnvironment, resolveCodeActSettings } from './codeActPolicy.js';
import { snapshotCodeJsonValue, type CodeJsonValue, type CodeRunFailure } from './codeRuntime.js';
import { WorkerThreadCodeRuntime } from './workerThreadCodeRuntime.js';
import { createRunCodeTool, type RunCodeLanguage } from './runCodeTool.js';
import { sanitizeTsName, TS_SDK_CALL_MEMBER } from './tsSdkRenderer.js';
import { ContainerKernelAdapter } from './containerKernelAdapter.js';
import { ProcessKernelAdapter } from './processKernelAdapter.js';
import { CodeActHostRpcDispatcher } from './hostRpcDispatcher.js';
import type {
  CodeActKernelAdapter,
  CodeActSettings,
  CodeCellExecutionResult,
  CodeRunFailureKind,
} from './types.js';

/**
 * Stateless Programmatic Tool runtime (PTC presentation backend): one fresh
 * execution environment per run_code call, settled immediately after. The
 * python arm reuses the hardened kernel machinery (one process per run,
 * stopped in finally); the typescript arm runs each program in a fresh
 * worker thread with no Python dependency. Both arms share the host-RPC
 * dispatcher, sub-dispatch scheduler, and permission path, so runs are
 * replayable from the transcript and never carry state between calls.
 *
 * @module src/codeact/programmaticToolRuntime
 */

export class ProgrammaticToolRuntime {
  private readonly settings;
  private readonly adapter: CodeActKernelAdapter | undefined;
  private readonly workerRuntime: WorkerThreadCodeRuntime | undefined;
  readonly language: RunCodeLanguage;

  constructor(input: CodeActSettings = { enabled: true }) {
    this.settings = resolveCodeActSettings(input);
    this.language = this.settings.ptcBackend === 'worker-thread' ? 'typescript' : 'python';
    if (this.settings.ptcBackend === 'worker-thread') {
      this.workerRuntime = new WorkerThreadCodeRuntime();
      this.adapter = undefined;
      return;
    }
    this.adapter = this.settings.ptcBackend === 'container'
      ? new ContainerKernelAdapter({
          image: this.settings.containerImage,
          memoryMb: this.settings.containerMemoryMb,
          cpuLimit: this.settings.containerCpuLimit,
        })
      : new ProcessKernelAdapter(this.settings.pythonCommand);
  }

  async run(input: {
    code: string;
    context: ToolExecutionContext;
    hostTools: readonly AgentToolDefinition[];
    timeoutMs?: number;
  }): Promise<CodeCellExecutionResult> {
    if (this.language === 'typescript') {
      return this.runTypeScript(input);
    }
    // The PTC surface shares the CodeAct security policy: a project with
    // CodeAct disabled, a missing backend, or enforce-mode without strong
    // isolation must fail here exactly like the persistent CodeCell does.
    await assertCodeActBackend(this.settings, this.adapter!);
    const sessionId = 'ptc:' + randomUUID();
    const executionId = input.context.toolUseId ?? randomUUID();
    const artifacts = new CodeActArtifactRecorder();
    // Per-run abort controller: the outer run signal and the kernel's
    // settlement aborts both propagate to the nested host dispatches.
    const runController = new AbortController();
    const abortCell = () => runController.abort(input.context.signal?.reason);
    if (input.context.signal?.aborted) abortCell();
    let abortRegistered = false;
    const kernel = await this.adapter!.start({
      sessionId,
      generation: 1,
      workDir: input.context.cwd,
      environment: buildCodeActEnvironment(this.settings.environmentAllowlist),
      maxOutputChars: this.settings.maxOutputChars,
      maxOutputBytes: this.settings.maxOutputBytes,
    });
    // Register only after the kernel exists: a start failure must not leak
    // the listener (and its runController closure) onto the long-lived run
    // signal, accumulating one entry per retry.
    if (input.context.signal?.aborted) {
      abortCell();
    } else {
      input.context.signal?.addEventListener('abort', abortCell, { once: true });
      abortRegistered = true;
    }
    try {
      const dispatcher = new CodeActHostRpcDispatcher(
        input.hostTools ?? [],
        { ...input.context, signal: runController.signal },
        artifacts,
        sessionId,
        this.settings.maxParallelSubCalls,
      );
      const toolNameMap = buildCodeActToolNameMap(input.hostTools ?? []);
      const result = await kernel.execute({
        executionId,
        sessionId,
        language: 'python',
        code: input.code,
        workDir: input.context.cwd,
        timeoutMs: input.timeoutMs ?? this.settings.executionTimeoutMs,
        signal: runController.signal,
        abort: (reason) => runController.abort(reason ?? new HadamardSdkError('PTC run settled.')),
        hostRpc: dispatcher.handler(),
        toolNameMap,
      });
      this.forwardTurnControl(dispatcher, input, result);
      return result;
    } finally {
      if (abortRegistered) input.context.signal?.removeEventListener('abort', abortCell);
      // Fresh environment per run: stop the kernel even on failure so no
      // state, child process, or host dispatch survives the run_code call.
      await kernel.stop().catch(() => undefined);
    }
  }

  /**
   * TypeScript arm: one fresh worker per run, host tools bridged through the
   * same dispatcher/scheduler contract as the python kernel's host RPC.
   */
  private async runTypeScript(input: {
    code: string;
    context: ToolExecutionContext;
    hostTools: readonly AgentToolDefinition[];
  }): Promise<CodeCellExecutionResult> {
    assertWorkerThreadPtcBackend(this.settings);
    const sessionId = 'ptc:' + randomUUID();
    const executionId = input.context.toolUseId ?? randomUUID();
    const artifacts = new CodeActArtifactRecorder();
    const runController = new AbortController();
    const abortCell = () => runController.abort(input.context.signal?.reason);
    if (input.context.signal?.aborted) abortCell();
    let abortRegistered = false;
    input.context.signal?.addEventListener('abort', abortCell, { once: true });
    abortRegistered = true;
    const startedClock = Date.now();
    try {
      const dispatcher = new CodeActHostRpcDispatcher(
        input.hostTools ?? [],
        { ...input.context, signal: runController.signal },
        artifacts,
        sessionId,
        this.settings.maxParallelSubCalls,
      );
      const handler = dispatcher.handler();
      const bindings = this.buildTypeScriptBindings(input.hostTools ?? [], handler.dispatch);
      const codeResult = await this.workerRuntime!.run({
        program: input.code,
        bindings: [{ global: 'tools', functions: bindings, errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }],
        signal: runController.signal,
      });
      await handler.drain().catch(() => undefined);
      const result = this.convertTypeScriptResult(executionId, sessionId, codeResult, Date.now() - startedClock);
      this.forwardTurnControl(dispatcher, input, result);
      return result;
    } finally {
      if (abortRegistered) input.context.signal?.removeEventListener('abort', abortCell);
    }
  }

  /** Exact-name bindings plus unique sanitized aliases, mirroring the TS SDK names. */
  private buildTypeScriptBindings(
    hostTools: readonly AgentToolDefinition[],
    dispatch: import('./types.js').CodeActHostRpcHandler['dispatch'],
  ): Record<string, (args: unknown) => Promise<CodeJsonValue>> {
    const functions: Record<string, (args: unknown) => Promise<CodeJsonValue>> = {};
    const visible = hostTools.filter((tool) => tool.name !== 'CodeCell' && tool.name !== 'run_code');
    const counts = new Map<string, number>();
    for (const tool of visible) {
      const member = sanitizeTsName(tool.name);
      counts.set(member, (counts.get(member) ?? 0) + 1);
    }
    const callTool = (name: string) => async (args: unknown): Promise<CodeJsonValue> => {
      const response = await dispatch({ id: randomUUID(), method: 'tool.call', input: { name, input: args ?? {} } });
      if (!response.ok) throw new Error(response.error ?? 'Host tool failed.');
      const value = snapshotCodeJsonValue(response.result);
      if (value === undefined) throw new Error('Host tool result must be lossless JSON.');
      return value;
    };
    for (const tool of visible) {
      functions[tool.name] = callTool(tool.name);
      const member = sanitizeTsName(tool.name);
      if (member !== tool.name && (counts.get(member) ?? 0) === 1) {
        functions[member] = callTool(tool.name);
      }
    }
    if (!functions[TS_SDK_CALL_MEMBER]) {
      functions[TS_SDK_CALL_MEMBER] = async (args: unknown): Promise<CodeJsonValue> => {
        const record = args && typeof args === 'object' ? args as Record<string, unknown> : {};
        const name = typeof record.name === 'string' ? record.name : '';
        const toolInput = record.input ?? {};
        if (!name || !visible.some((tool) => tool.name === name)) {
          throw new Error('tools.call requires an exact registered host tool name.');
        }
        return callTool(name)(toolInput);
      };
    }
    return functions;
  }

  /** Map the CodeRuntime outcome onto the shared cell-result contract. */
  private convertTypeScriptResult(
    executionId: string,
    sessionId: string,
    codeResult: import('./codeRuntime.js').CodeRunResult,
    durationMs: number,
  ): CodeCellExecutionResult {
    const stdout = codeResult.logs.join('\n');
    if (codeResult.error) {
      const kindMap: Record<CodeRunFailure['kind'], CodeRunFailureKind> = {
        exception: 'exception',
        timeout: 'timeout',
        abort: 'interrupt',
        'worker-exit': 'kernel-exit',
        'invalid-output': 'invalid-output',
        'output-limit': 'output-limit',
      };
      return {
        executionId,
        sessionId,
        generation: 1,
        status: 'failed',
        stdout,
        stderr: '',
        error: codeResult.error.message,
        durationMs,
        artifacts: [],
        ...(codeResult.error.kind === 'output-limit' ? { outputLimit: true } : {}),
        failureKind: kindMap[codeResult.error.kind],
      };
    }
    return {
      executionId,
      sessionId,
      generation: 1,
      status: 'completed',
      stdout,
      stderr: '',
      ...(codeResult.value !== undefined
        ? { result: { type: typeof codeResult.value, value: codeResult.value, repr: JSON.stringify(codeResult.value) } }
        : {}),
      durationMs,
      artifacts: [],
    };
  }

  /** Forward successful nested turn-control to the cell owner (dsh semantics). */
  private forwardTurnControl(
    dispatcher: CodeActHostRpcDispatcher,
    input: { context: ToolExecutionContext },
    result: CodeCellExecutionResult,
  ): void {
    if (result.status !== 'completed') return;
    for (const nestedContext of dispatcher.takeDeferredContexts()) {
      input.context.deferAdditionalContext?.(nestedContext);
    }
    if (dispatcher.turnConcluded) input.context.concludeTurn?.();
  }
}

/**
 * Composition-root helper: build the stateless run_code wire tool under the
 * project CodeAct security policy, then apply the same allow/deny filtering
 * every other tool receives. Returns undefined when the allow list filters
 * run_code out (the engine then reports PTC_TOOL_MISSING at request time).
 */
export function createFilteredRunCodeTool(options: {
  settings: CodeActSettings;
  hostTools: readonly AgentToolDefinition[];
  allowedTools?: string[];
  disallowedTools: string[];
}): AgentToolDefinition | undefined {
  if (options.settings.enabled !== true) {
    throw new HadamardSdkError(
      'Tool presentation "ptc"/"both" requires CodeAct to be enabled for this project (codeAct.enabled).',
      'PTC_CODEACT_DISABLED',
    );
  }
  const runtime = new ProgrammaticToolRuntime(options.settings);
  const tool = createRunCodeTool({ service: runtime, hostTools: options.hostTools, language: runtime.language });
  const names = [tool.name, ...(tool.aliases ?? [])];
  if (options.disallowedTools.some((name) => names.includes(name))) return undefined;
  if (options.allowedTools && options.allowedTools.length > 0
    && !names.some((name) => options.allowedTools!.includes(name))) return undefined;
  return tool;
}
