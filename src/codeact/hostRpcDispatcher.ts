import { randomUUID } from 'node:crypto';

import { createLocalToolAdapter } from '../runtime/tools.js';
import { decideHadamardToolPermission } from '../runtime/hadamardPermissions.js';
import { markExplicitSafetyApproval } from '../runtime/safetyChecks.js';
import type { AgentToolDefinition, ToolExecutionContext } from '../types.js';
import { CodeActArtifactRecorder } from './codeActArtifacts.js';
import { CodeActSubdispatchScheduler } from './subdispatchScheduler.js';
import type {
  CodeActHostRpcHandler,
  CodeActHostRpcRequest,
  CodeActHostRpcResponse,
} from './types.js';

export class CodeActHostRpcDispatcher {
  private readonly tools = new Map<string, AgentToolDefinition>();
  private readonly deferredContexts: { type: 'text'; text: string }[] = [];
  private concludedTurn = false;

  constructor(
    tools: readonly AgentToolDefinition[],
    private readonly context: ToolExecutionContext,
    private readonly artifacts: CodeActArtifactRecorder,
    private readonly sessionId: string,
    private readonly maxParallelSubCalls = 8,
  ) {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
      for (const alias of tool.aliases ?? []) this.tools.set(alias, tool);
    }
  }

  /**
   * Successful nested calls' deferred contexts and turn-conclude markers,
   * surfaced to the cell owner after the kernel settles (dsh forwarding).
   * Only completed cell runs may consume them — a failed cell forwards none.
   */
  takeDeferredContexts(): { type: 'text'; text: string }[] {
    return this.deferredContexts.splice(0);
  }

  get turnConcluded(): boolean {
    return this.concludedTurn;
  }

  /**
   * One handler per cell execution: wraps a fresh sub-dispatch scheduler so
   * nested host calls obey the same concurrency contract as the native loop
   * (ordered commit, bounded parallel pool, exclusive barriers, drain on
   * settle).
   */
  handler(): CodeActHostRpcHandler {
    const scheduler = new CodeActSubdispatchScheduler({
      maxParallel: this.maxParallelSubCalls,
      classify: request => this.classifyRequest(request),
      dispatch: request => this.dispatch(request),
      rootCallId: this.context.toolUseId ?? this.sessionId,
      onEvent: payload => {
        this.context.runtime?.emit?.({
          ...payload,
          runId: this.context.runId,
          iteration: this.context.iteration,
        });
      },
    });
    return {
      dispatch: request => scheduler.schedule(request).catch(error => ({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })),
      drain: () => scheduler.drain(),
    };
  }

  /** Fail-closed classification: only exact-true parallel, everything else exclusive. */
  private classifyRequest(request: CodeActHostRpcRequest): boolean {
    if (request.method !== 'tool.call') return false;
    const envelope = asRecord(request.input);
    const name = typeof envelope?.name === 'string' ? envelope.name : '';
    const definition = name ? this.tools.get(name) : undefined;
    if (!definition || definition.requiresUserInteraction?.() === true) return false;
    try {
      const concurrencySafe = definition.isConcurrencySafe?.();
      if (concurrencySafe !== undefined) return concurrencySafe === true;
      return definition.isReadOnly?.(envelope?.input) === true;
    } catch {
      return false;
    }
  }

  async dispatch(request: CodeActHostRpcRequest): Promise<CodeActHostRpcResponse> {
    try {
      if (request.method === 'artifact.put') return await this.putArtifact(request);
      if (request.method === 'tool.schema') return this.toolSchema(request);
      if (request.method === 'tool.call') return await this.callTool(request);
      return { id: request.id, ok: false, error: `Host RPC method ${request.method} is not allowed.` };
    } catch (error) {
      return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** On-demand schema lookup so a truncated typed SDK can still recover full discovery. */
  private toolSchema(request: CodeActHostRpcRequest): CodeActHostRpcResponse {
    const input = asRecord(request.input);
    const name = requiredString(input.name, 'tool name');
    const definition = this.tools.get(name);
    if (!definition) return { id: request.id, ok: false, error: `Host tool ${name} is not available.` };
    return { id: request.id, ok: true, result: { name: definition.name, inputJsonSchema: definition.inputJsonSchema } };
  }

  private async putArtifact(request: CodeActHostRpcRequest): Promise<CodeActHostRpcResponse> {
    const input = asRecord(request.input);
    const name = requiredString(input.name, 'artifact name');
    const content = requiredString(input.content, 'artifact content', true);
    const mediaType = typeof input.mediaType === 'string' && input.mediaType.trim()
      ? input.mediaType.trim()
      : 'text/plain';
    const permission = await decideHadamardToolPermission({
      mode: this.context.permissionMode ?? 'default',
      rules: this.context.permissions ?? [],
      classifier: this.context.classifier,
      approver: this.context.approver,
      canUseTool: this.context.runtime?.canUseTool,
      adapter: { isDestructive: () => true },
      runId: this.context.runId,
      sessionId: this.context.sessionId,
      workDir: this.context.cwd,
      toolName: 'CodeActArtifact',
      publicName: 'CodeActArtifact',
      prompt: this.context.prompt,
      toolInput: { name, mediaType, sizeChars: content.length },
      iteration: this.context.iteration,
    });
    this.context.runtime?.emit?.({
      type: 'tool.permission',
      runId: this.context.runId,
      iteration: this.context.iteration,
      decision: permission,
      timestamp: permission.timestamp,
    });
    if (permission.behavior === 'deny') {
      return { id: request.id, ok: false, error: permission.reason };
    }
    const artifact = await this.artifacts.putHostArtifact(
      this.context.cwd,
      this.sessionId,
      { name, content, mediaType },
    );
    return { id: request.id, ok: true, result: artifact, artifact };
  }

  private async callTool(request: CodeActHostRpcRequest): Promise<CodeActHostRpcResponse> {
    const envelope = asRecord(request.input);
    const requestedName = requiredString(envelope.name, 'tool name');
    const input = asRecord(envelope.input ?? {});
    const definition = this.tools.get(requestedName);
    if (!definition) return { id: request.id, ok: false, error: `Host tool ${requestedName} is not available.` };
    if (definition.name === 'CodeCell') {
      return { id: request.id, ok: false, error: 'CodeCell cannot recursively invoke itself through Host RPC.' };
    }
    const toolUseId = `codeact-host-${randomUUID()}`;
    const nestedExecutor = this.context.runtime?.executeTool;
    if (nestedExecutor) {
      const nested = await nestedExecutor(definition, input, {
        toolUseId,
        signal: this.context.signal,
      });
      if (nested.record.isError) {
        return { id: request.id, ok: false, error: nested.record.outputText || `Host tool ${definition.name} failed.` };
      }
      // Forward the successful nested outcome's turn-control surface: the
      // cell owner aggregates these after settle (dsh exec.deferContext /
      // exec.concludeTurn). Failed nested calls carry neither (transactional).
      if (nested.additionalContexts && nested.additionalContexts.length > 0) {
        this.deferredContexts.push(...nested.additionalContexts);
      }
      if (nested.concludesTurn === true) this.concludedTurn = true;
      return { id: request.id, ok: true, result: nested.record.output ?? nested.record.outputText };
    }

    // Standalone CodeActService consumers do not have a conversation runtime.
    // Preserve a small direct fallback for that public embedding path.
    const adapter = createLocalToolAdapter(definition, definition.name, definition.name);
    const startedAt = new Date().toISOString();
    this.context.runtime?.emit?.({
      type: 'tool.call',
      runId: this.context.runId,
      iteration: this.context.iteration,
      call: {
        id: toolUseId,
        name: definition.name,
        publicName: definition.name,
        provider: 'local',
        input,
        startedAt,
      },
      timestamp: startedAt,
    });
    const permission = await decideHadamardToolPermission({
      mode: this.context.permissionMode ?? 'default',
      rules: this.context.permissions ?? [],
      classifier: this.context.classifier,
      approver: this.context.approver,
      canUseTool: this.context.runtime?.canUseTool,
      adapter,
      runId: this.context.runId,
      sessionId: this.context.sessionId,
      workDir: this.context.cwd,
      toolName: definition.name,
      publicName: definition.name,
      prompt: this.context.prompt,
      toolInput: input,
      iteration: this.context.iteration,
    });
    this.context.runtime?.emit?.({
      type: 'tool.permission',
      runId: this.context.runId,
      iteration: this.context.iteration,
      decision: permission,
      timestamp: permission.timestamp,
    });
    if (permission.behavior === 'deny') {
      return { id: request.id, ok: false, error: permission.reason };
    }
    const executionInput = permission.updatedInput ?? input;
    const nestedContext = markExplicitSafetyApproval(
      { ...this.context, toolUseId },
      permission.source === 'approver',
    );
    const execution = await adapter.execute(executionInput, nestedContext);
    const completedAt = new Date().toISOString();
    this.context.runtime?.emit?.({
      type: 'tool.result',
      runId: this.context.runId,
      iteration: this.context.iteration,
      result: {
        id: toolUseId,
        name: definition.name,
        publicName: definition.name,
        provider: 'local',
        input: executionInput,
        startedAt,
        outputText: execution.text,
        output: execution.rawOutput,
        isError: execution.isError ?? false,
        completedAt,
        durationMs: Math.max(Date.parse(completedAt) - Date.parse(startedAt), 0),
      },
      timestamp: completedAt,
    });
    return { id: request.id, ok: true, result: execution.rawOutput ?? execution.text };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Host RPC input must be an object.');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} must be a ${allowEmpty ? '' : 'non-empty '}string.`);
  }
  return value;
}
