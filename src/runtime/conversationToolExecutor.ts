import path from 'node:path';

import { ToolExecutionError } from '../errors.js';
import type { ToolResultBlockParam, ToolUseBlock } from '../provider/types.js';
import type {
  AgentToolCallEventPayload,
  AgentToolCallRecord,
  HadamardEffort,
  HadamardPermissionDecision,
  ResolvedToolAdapter,
  ToolExecutionContext,
  ToolCallProgress,
} from '../types.js';
import { withDeadline } from './deadline.js';
import { decideHadamardToolPermission } from './hadamardPermissions.js';
import { asError, deepClone, nowIso } from './helpers.js';
import { ensureNotAborted } from './modelRequestPolicy.js';
import { markExplicitSafetyApproval } from './safetyChecks.js';
import type { ExecuteConversationOptions } from './conversationPorts.js';
import { createBuiltInToolPolicyPipeline, type ToolPolicyCall } from './toolPolicyPipeline.js';
import { createLocalToolAdapter, textFromToolResultContent } from './tools.js';

export interface ConversationToolExecutionResult {
  record: AgentToolCallRecord;
  resultBlock: ToolResultBlockParam;
  permissionBehavior?: HadamardPermissionDecision['behavior'];
  /** Model-facing context deferred by the tool for the next step's user message. */
  additionalContexts?: { type: 'text'; text: string }[];
  /** The tool requested the agent turn to conclude after this batch. */
  concludesTurn?: boolean;
}

export interface ConversationToolExecutionContext {
  options: ExecuteConversationOptions;
  iteration: number;
  toolUse: ToolUseBlock;
  adapter?: ResolvedToolAdapter;
  workDir: string;
  promptText: string;
  model: string;
  effort?: HadamardEffort;
  onPermissionDecision(decision: HadamardPermissionDecision): void;
  onWorkDirChange(workDir: string): void;
}

export async function executeConversationToolUse(
  context: ConversationToolExecutionContext,
): Promise<ConversationToolExecutionResult> {
  const { options, iteration, toolUse, adapter, promptText, model, effort } = context;
  let workDir = context.workDir;
  ensureNotAborted(options.signal);
  const started = nowIso();
  const startedClock = Date.now();
  const callPayload: AgentToolCallEventPayload = {
    id: toolUse.id,
    name: adapter?.sourceName ?? toolUse.name,
    publicName: toolUse.name,
    provider: adapter?.provider ?? 'local',
    mcpServerName: adapter?.mcpServerName,
    input: deepClone(toolUse.input),
    startedAt: started,
  };
  options.emit?.({
    type: 'tool.call',
    runId: options.runId,
    iteration,
    call: callPayload,
    timestamp: started,
  });

  let outputText = '';
  let output: unknown;
  let isError = false;
  let content: ToolResultBlockParam['content'] | undefined;
  let permissionBehavior: HadamardPermissionDecision['behavior'] | undefined;
  let concludedTurn = false;
  const deferredContexts: { type: 'text'; text: string }[] = [];
  try {
    if (!adapter) {
      const unknownToolMessage = options.toolPresentation === 'ptc'
        ? `No tool named "${toolUse.name}" is directly callable: the ptc presentation exposes only run_code. Call this tool from inside a run_code program via the typed SDK instead.`
        : `No tool named "${toolUse.name}" is currently registered.`;
      throw new ToolExecutionError(toolUse.name, unknownToolMessage);
    }
    // Composable per-tool policy pipeline: ordered pre listeners with
    // monotonic deny (permission is the LAST built-in listener, so no
    // policy can widen what an earlier one refused).
    const pipeline = options.toolPolicy
      ?? options.toolPolicyFactory?.(options)
      ?? createBuiltInToolPolicyPipeline(options);
    const policyCall: ToolPolicyCall = {
      iteration,
      toolUseId: toolUse.id,
      toolName: adapter.sourceName,
      publicName: toolUse.name,
      input: toolUse.input,
      adapter,
      workDir,
      prompt: promptText,
      onPermissionDecision: context.onPermissionDecision,
    };
    const preState = await pipeline.runPre(policyCall);
    permissionBehavior = preState.decision?.behavior;
    if (preState.behavior === 'deny') {
      throw new ToolExecutionError(toolUse.name, preState.reason ?? 'Denied by tool policy.');
    }
    const onProgress: ToolCallProgress | undefined = options.emit
      ? progress => options.emit?.({
          type: 'tool.progress',
          runId: options.runId,
          iteration,
          toolUseId: progress.toolUseID || toolUse.id,
          data: progress.data,
          timestamp: nowIso(),
        })
      : undefined;
    const executionInput = preState.updatedInput !== undefined
      ? preState.updatedInput
      : toolUse.input;
    const executionContext: ToolExecutionContext = {
      signal: undefined as AbortSignal | undefined,
      runId: options.runId,
      toolUseId: toolUse.id,
      sessionId: options.sessionId,
      cwd: workDir,
      metadata: { ...(options.metadata ?? {}) },
      projectInstructions: options.projectInstructions
        ? structuredClone(options.projectInstructions)
        : undefined,
      prompt: promptText,
      iteration,
      permissionMode: options.permissionMode,
      permissions: options.permissions,
      classifier: options.classifier,
      approver: options.approver,
      runtime: {
        canUseTool: options.canUseTool,
        emit: options.emit,
        executeTool: async (definition, input, nested) => {
          const nestedResult = await executeConversationToolUse({
            options: {
              ...options,
              signal: nested.signal ?? options.signal,
            },
            iteration,
            toolUse: {
              type: 'tool_use',
              id: nested.toolUseId,
              name: definition.name,
              input,
            },
            adapter: createLocalToolAdapter(definition, definition.name, definition.name),
            workDir,
            promptText,
            model,
            effort,
            onPermissionDecision: context.onPermissionDecision,
            onWorkDirChange: nextWorkDir => {
              workDir = nextWorkDir;
              context.onWorkDirChange(nextWorkDir);
            },
          });
          // Forward the full nested outcome: the CodeAct host dispatcher
          // aggregates deferred contexts and turn-conclude markers up to
          // the outer cell (dsh exec.deferContext/concludeTurn semantics).
          return {
            record: nestedResult.record,
            ...(nestedResult.additionalContexts && nestedResult.additionalContexts.length > 0
              ? { additionalContexts: nestedResult.additionalContexts }
              : {}),
            ...(nestedResult.concludesTurn === true ? { concludesTurn: true } : {}),
          };
        },
      },
      hooks: options.hooks,
      modelApi: options.modelApi,
      model,
      provider: options.config.provider,
      effort,
      fileChangeJournal: options.fileChangeJournal,
      sandboxExecutor: options.sandboxExecutor,
      concludeTurn: () => { concludedTurn = true; },
      deferAdditionalContext: (context) => {
        if (context && typeof context.text === 'string') {
          deferredContexts.push({ type: 'text', text: context.text });
        }
      },
    };
    const execution = await withDeadline(
      `Tool ${toolUse.name}`,
      options.config.toolTimeoutMs,
      adapter.interruptBehavior === 'cancel' ? options.signal : undefined,
      ({ signal }) => adapter.execute(
        executionInput,
        markExplicitSafetyApproval(
          { ...executionContext, signal },
          preState.explicitApproval === true || preState.decision?.source === 'approver',
        ),
        onProgress,
      ),
    );
    const nextWorkDir = executionContext.metadata.__hadamardWorkDir;
    if (typeof nextWorkDir === 'string' && nextWorkDir.trim()) {
      const resolved = path.resolve(nextWorkDir.trim());
      if (resolved !== workDir) {
        workDir = resolved;
        context.onWorkDirChange(workDir);
      }
    }
    // Post stage: waterfall over the settled execution (spill shaping +
    // PostToolUse hooks as the built-in listeners).
    policyCall.executionInput = executionInput;
    const postDecision = await pipeline.runPost(policyCall, execution);
    if (postDecision.kind === 'block') {
      throw new ToolExecutionError(toolUse.name, postDecision.reason);
    }
    outputText = textFromToolResultContent(postDecision.content as ToolResultBlockParam['content']);
    output = execution.rawOutput;
    isError = execution.isError ?? false;
    content = postDecision.content as ToolResultBlockParam['content'];
    if (postDecision.additionalContexts) {
      for (const policyContext of postDecision.additionalContexts) {
        if (policyContext && typeof policyContext.text === 'string') {
          deferredContexts.push({ type: 'text', text: policyContext.text });
        }
      }
    }
    concludedTurn = concludedTurn || execution.concludesTurn === true;
    if (execution.additionalContexts) {
      for (const context of execution.additionalContexts) {
        if (context && typeof context.text === 'string') {
          deferredContexts.push({ type: 'text', text: context.text });
        }
      }
    }
  } catch (error) {
    const normalized = error instanceof ToolExecutionError
      ? error
      : new ToolExecutionError(toolUse.name, asError(error).message, { cause: error });
    outputText = normalized.message;
    output = { error: normalized.message };
    isError = true;
    content = normalized.message;
  }

  // Turn-control signals are transactional: a failed tool cannot conclude the
  // turn or leak context it staged before failing.
  if (isError) {
    concludedTurn = false;
    deferredContexts.length = 0;
  }

  const record: AgentToolCallRecord = {
    ...callPayload,
    outputText,
    output,
    isError,
    completedAt: nowIso(),
    durationMs: Date.now() - startedClock,
    ...(concludedTurn ? { concludesTurn: true } : {}),
  };
  return {
    record,
    resultBlock: {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content,
      is_error: isError,
    },
    permissionBehavior,
    ...(deferredContexts.length > 0 ? { additionalContexts: deferredContexts } : {}),
    ...(concludedTurn ? { concludesTurn: true } : {}),
  };
}
