import { randomUUID } from 'node:crypto';

import { HadamardSdkError } from '../errors.js';
import type { AgentToolDefinition, ToolExecutionContext } from '../types.js';
import { CodeActArtifactRecorder } from './codeActArtifacts.js';
import { buildCodeActToolNameMap } from './codeActSdk.js';
import { assertCodeActBackend, buildCodeActEnvironment, resolveCodeActSettings } from './codeActPolicy.js';
import { createRunCodeTool } from './runCodeTool.js';
import { ContainerKernelAdapter } from './containerKernelAdapter.js';
import { CodeActHostRpcDispatcher } from './hostRpcDispatcher.js';
import { ProcessKernelAdapter } from './processKernelAdapter.js';
import type {
  CodeActKernelAdapter,
  CodeActSettings,
  CodeCellExecutionResult,
} from './types.js';

/**
 * Stateless Programmatic Tool runtime (PTC presentation backend): one fresh
 * kernel process per run_code call, stopped immediately after settle. It
 * reuses the hardened CodeAct machinery (protocol prechecks, hard output
 * budget, host-RPC dispatcher with the unified ToolExecutorPort, per-cell
 * sub-dispatch scheduler, abort-drain-before-settle) but deliberately has
 * no pool and no reusable namespace, so runs are replayable from the
 * transcript and never carry state between calls.
 *
 * @module src/codeact/programmaticToolRuntime
 */

export class ProgrammaticToolRuntime {
  private readonly settings;
  private readonly adapter: CodeActKernelAdapter;

  constructor(input: CodeActSettings = { enabled: true }) {
    this.settings = resolveCodeActSettings(input);
    this.adapter = this.settings.backend === 'container'
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
    // The PTC surface shares the CodeAct security policy: a project with
    // CodeAct disabled, a missing backend, or enforce-mode without strong
    // isolation must fail here exactly like the persistent CodeCell does.
    await assertCodeActBackend(this.settings, this.adapter);
    const sessionId = `ptc:${randomUUID()}`;
    const executionId = input.context.toolUseId ?? randomUUID();
    const artifacts = new CodeActArtifactRecorder();
    // Per-run abort controller: the outer run signal and the kernel's
    // settlement aborts both propagate to the nested host dispatches.
    const runController = new AbortController();
    const abortCell = () => runController.abort(input.context.signal?.reason);
    if (input.context.signal?.aborted) abortCell();
    let abortRegistered = false;
    const kernel = await this.adapter.start({
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
      return await kernel.execute({
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
    } finally {
      if (abortRegistered) input.context.signal?.removeEventListener('abort', abortCell);
      // Fresh environment per run: stop the kernel even on failure so no
      // state, child process, or host dispatch survives the run_code call.
      await kernel.stop().catch(() => undefined);
    }
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
  const tool = createRunCodeTool({ service: runtime, hostTools: options.hostTools });
  const names = [tool.name, ...(tool.aliases ?? [])];
  if (options.disallowedTools.some((name) => names.includes(name))) return undefined;
  if (options.allowedTools && options.allowedTools.length > 0
    && !names.some((name) => options.allowedTools!.includes(name))) return undefined;
  return tool;
}

