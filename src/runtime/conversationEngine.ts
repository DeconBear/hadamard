import type {
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '../provider/types.js';

import { HadamardSdkError } from '../errors.js';
import {
  reconcileHadamardContextMessages,
  stripHadamardMessageProvenance,
} from '../memory/projectInstructionContext.js';
import { TODO_WRITE_TOOL_NAME } from '../tools/todo/TodoWriteTool.js';
import type {
  AgentLoopCompactionRecord,
  AgentRequestSummary,
  AgentRunResult,
  HadamardPermissionDecision,
  AgentToolCallRecord,
  ModelApi,
  ModelRequest,
} from '../types.js';
import { asError, deepClone, nowIso } from './helpers.js';
import { resolveHadamardPostSamplingHooks, resolveHadamardStopHooks } from '../hooks/hadamardHooks.js';
import { createBuiltInConversationExtensions } from './conversationExtensions.js';
import type { ConversationExtensionPoints } from './conversationExtensions.js';
import { resolveToolPresentation } from '../codeact/toolPresentation.js';
import {
  getHadamardApiContextManagement,
  prepareHadamardProviderRequestMessages,
} from './hadamardApiMicrocompact.js';
import { createDenialTracker } from './denialTracking.js';
import {
  assistantMessageToParam,
  buildUserMessage,
  extractTextFromContent,
} from './messageUtils.js';
import type { ExecuteConversationOptions } from './conversationPorts.js';
export type { ExecuteConversationOptions } from './conversationPorts.js';
import { withDeadline } from './deadline.js';
import {
  requireLifecycleContinue,
  runTypedLifecycleHooks,
} from './conversationLifecycle.js';
import { appendRawTranscript } from './conversationPersistence.js';
import { enforceToolResultsAggregateBudget } from './toolResultArtifactStore.js';
import { executeConversationToolUse } from './conversationToolExecutor.js';
import { resolveHadamardRequestProposal } from './requestProposalPolicy.js';
import { consumeStream } from './modelStreamConsumer.js';
import {
  calibrateRequestTokenMultiplier,
  estimateRequestTokenBreakdown,
} from './requestTokenEstimate.js';
import {
  appendTextToToolResultContent,
  buildAbortedBeforeDispatchResult,
  buildUnpairedToolUseRepair,
  executeToolUsesWithContract,
  isLikelyTruncatedToolUse,
  isToolUseConcurrencySafe,
} from './conversationToolBatch.js';
import type { TrajectoryEvent, TrajectoryEventPayload } from './trajectoryEvents.js';
import { fingerprintRequestHeader } from './surfaceProjection.js';
import {
  aggregateRequestUsage,
  applyAnthropicPromptCacheBreakpoints,
  ensureNotAborted,
  getReportedInputTokens,
  getRequestByteLength,
  isAnthropicAPI,
  sleep,
} from './modelRequestPolicy.js';

const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
const MAX_CONSECUTIVE_PERMISSION_DENIALS = 3;

export async function executeConversation(
  options: ExecuteConversationOptions,
): Promise<AgentRunResult> {
  const startedAt = nowIso();

  // Structured append-only trajectory channel: every event carries a
  // monotonic per-run seq; observers can never break the loop.
  let trajectorySeq = 0;
  const emitTrajectory = (payload: TrajectoryEventPayload): void => {
    trajectorySeq += 1;
    try {
      void Promise.resolve(
        options.onTrajectoryEvent?.({ ...payload, seq: trajectorySeq, timestamp: nowIso() } as TrajectoryEvent),
      ).catch(() => undefined);
    } catch {
      // Trajectory observers can never fail the turn.
    }
  };

  let workDir = options.sessionWorkDir ?? options.config.workDir;
  let model = options.model ?? options.config.model;
  let effort =
    options.effort === 'auto'
      ? undefined
      : options.effort ?? options.config.effort;
  let maxTokensOverride: number | undefined;
  const promptText =
    typeof options.input === 'string' ? options.input : extractTextFromContent(options.input);
  const postSamplingHooks = resolveHadamardPostSamplingHooks(options.hooks);
  const reconciledContext = reconcileHadamardContextMessages(
    deepClone(options.messages ?? []),
    deepClone(options.prefixedMessages ?? []),
  );
  const conversation = reconciledContext.messages;
  const prefixedMessages = reconciledContext.prefixedMessages;

  // Cold-resume repair: close unpaired tool_use blocks in persisted history
  // so the provider never rejects the resumed session (dsh repair.ts shape).
  const repairMessage = buildUnpairedToolUseRepair(conversation);
  if (repairMessage) {
    conversation.push(repairMessage);
    await appendRawTranscript(options, [repairMessage]);
  }

  let initialUserMessage: MessageParam | undefined;
  if (!options.skipInitialInput) {
    conversation.push(...prefixedMessages);
    initialUserMessage = buildUserMessage(options.input);
    conversation.push(initialUserMessage);
  } else if (prefixedMessages.length > 0) {
    // Reactive compact retry: the user turn is already on the snapshot.
    // Reinsert rebuilt prefixes immediately before that user turn so the
    // request still ends with the actual prompt, rather than internal context.
    let retryInputIndex = -1;
    for (let index = conversation.length - 1; index >= 0; index -= 1) {
      const candidate = conversation[index];
      if (
        candidate?.role === 'user' &&
        extractTextFromContent(candidate.content) === promptText
      ) {
        retryInputIndex = index;
        break;
      }
    }
    if (retryInputIndex >= 0) {
      conversation.splice(retryInputIndex, 0, ...prefixedMessages);
    } else {
      conversation.push(...prefixedMessages);
    }
  }

  if (!options.skipRunStartedEvent) {
    options.emit?.({
      type: 'run.started',
      runId: options.runId,
      sessionId: options.sessionId,
      model,
      input: promptText,
      timestamp: startedAt,
    });
    emitTrajectory({
      type: 'run.started',
      runId: options.runId,
      sessionId: options.sessionId,
      model,
    });
    emitTrajectory({
      type: 'turn.started',
      runId: options.runId,
      sessionId: options.sessionId,
      model,
      input: promptText,
    });
  }
  // Durable surface seed: one snapshot covering the pre-seeded session
  // history, the cold-resume repair, prefixes, and the initial user turn. The
  // projection replays this byte-for-byte as the model-visible starting point.
  emitTrajectory({
    type: 'conversation.replaced',
    runId: options.runId,
    iteration: 0,
    reason: 'seed',
    messages: deepClone(conversation),
  });
  await requireLifecycleContinue(options, 'SessionStart', { input: promptText });
  await requireLifecycleContinue(options, 'TurnStart', { input: promptText });
  if (initialUserMessage) {
    await appendRawTranscript(options, [initialUserMessage]);
  }

  // Persist the user turn before the first provider request. Besides crash
  // recovery, this makes a newly spawned child conversation immediately
  // inspectable while its first model request is still running.
  if (options.onConversationCheckpoint) {
    try {
      await options.onConversationCheckpoint(deepClone(conversation));
    } catch {
      // Checkpoint durability must never prevent the agent turn from running.
    }
  }

  // Tool presentation (native / PTC / both) decides the wire-level tools; the
  // execution registry (toolMap) stays complete so host-tool dispatch inside
  // run_code programs keeps the same permission path as direct calls.
  // `let`-bound because the per-iteration fold hook can refresh the whole
  // wire surface (dynamic skills change tool descriptions mid-run).
  let currentToolDefinitions = options.tools ?? [];
  let resolvedTools = await options.mcpManager.resolveToolAdapters(
    currentToolDefinitions,
    options.mcpServers ?? [],
    { signal: options.signal, timeoutMs: options.config.mcpTimeoutMs },
  );
  let presentation = resolveToolPresentation({
    mode: options.toolPresentation,
    resolvedTools,
    sdkTools: currentToolDefinitions,
  });
  let providerTools = presentation.providerTools;
  const baseSystemPrompt = options.systemPrompt ?? options.config.systemPrompt;
  let systemPrompt = typeof baseSystemPrompt === 'string'
    ? `${baseSystemPrompt}\n\n${presentation.instructions}`.replace(/\n+$/u, '')
    : (presentation.instructions || undefined);
  let fixedRequestBreakdown = estimateRequestTokenBreakdown({
    systemPrompt,
    tools: providerTools,
    messageTokens: 0,
  });
  let fixedRequestTokens = fixedRequestBreakdown.uncalibratedTokens;
  let toolMap = buildConversationToolMap(resolvedTools);

  /** Rebuild the wire surface from freshly folded tool definitions. */
  const refreshWireTools = async (definitions: readonly import('../types.js').AgentToolDefinition[]): Promise<void> => {
    currentToolDefinitions = definitions as import('../types.js').AgentToolDefinition[];
    resolvedTools = await options.mcpManager.resolveToolAdapters(
      currentToolDefinitions,
      options.mcpServers ?? [],
      { signal: options.signal, timeoutMs: options.config.mcpTimeoutMs },
    );
    presentation = resolveToolPresentation({
      mode: options.toolPresentation,
      resolvedTools,
      sdkTools: currentToolDefinitions,
    });
    providerTools = presentation.providerTools;
    systemPrompt = typeof baseSystemPrompt === 'string'
      ? `${baseSystemPrompt}\n\n${presentation.instructions}`.replace(/\n+$/u, '')
      : (presentation.instructions || undefined);
    fixedRequestBreakdown = estimateRequestTokenBreakdown({
      systemPrompt,
      tools: providerTools,
      messageTokens: 0,
    });
    fixedRequestTokens = fixedRequestBreakdown.uncalibratedTokens;
    toolMap = buildConversationToolMap(resolvedTools);
  };
  const requestSummaries: AgentRequestSummary[] = [];
  const toolCalls: AgentToolCallRecord[] = [];
  const permissionDecisions: HadamardPermissionDecision[] = [];
  const loopCompactions: AgentLoopCompactionRecord[] = [];

  let iteration = 0;
  let finalMessage: AgentRunResult['message'] | undefined;
  let toolResults: ToolResultBlockParam[] = [];
  const denialTracker = createDenialTracker();
  // Swappable strategies; the built-ins preserve current behavior exactly.
  const builtInExtensions = createBuiltInConversationExtensions();
  const extensions: Required<ConversationExtensionPoints> = {
    autoCompact: options.extensions?.autoCompact ?? builtInExtensions.autoCompact,
    requestError: options.extensions?.requestError ?? builtInExtensions.requestError,
    repeatCall: options.extensions?.repeatCall ?? builtInExtensions.repeatCall,
    todoReminder: options.extensions?.todoReminder ?? builtInExtensions.todoReminder,
  };
  let lastFailedTool = '';
  let maxTokensRecoveryCount = 0;
  let modelFallbackUsed = false;
  let streamInterruptionRetryIteration = 0;
  let streamInterruptionRetries = 0;
  let reactiveCompactAttempted = false;
  let lastRequestInputTokens: number | undefined;
  let tokenEstimateMultiplier = 1;
  let compactWindowPrefixTokens = 0;
  let lastPromptCachePrefixSignature: string | undefined;
  let lastRequestHeaderKey: string | undefined;

  // Turn/step envelope: a step spans one model request plus its tool batch;
  // the previous step closes at the next loop top (or at every return site).
  let lastStep: { iteration: number; toolUseCount: number; aborted?: boolean } | undefined;
  let iterationReused = false;

  const closeStepAndTurn = (stopReason: string | null, incompleteReason?: string): void => {
    if (lastStep && lastStep.iteration === iteration) {
      emitTrajectory({
        type: 'step.ended',
        runId: options.runId,
        iteration,
        toolUseCount: lastStep.toolUseCount,
        ...(lastStep.aborted ? { aborted: true } : {}),
      });
      lastStep = undefined;
    }
    emitTrajectory({
      type: 'turn.ended',
      runId: options.runId,
      stopReason,
      ...(incompleteReason !== undefined ? { incompleteReason } : {}),
    });
  };

  while (true) {
    ensureNotAborted(options.signal);
    iteration += 1;
    if (!iterationReused) {
      if (lastStep) {
        emitTrajectory({
          type: 'step.ended',
          runId: options.runId,
          iteration: lastStep.iteration,
          toolUseCount: lastStep.toolUseCount,
          ...(lastStep.aborted ? { aborted: true } : {}),
        });
      }
      lastStep = { iteration, toolUseCount: 0 };
      emitTrajectory({
        type: 'step.started',
        runId: options.runId,
        iteration,
      });
    }
    iterationReused = false;

    // Dynamic tool surface: skills (and other prompt() sources) change while
    // a run is live, so the composition root may re-fold descriptions each
    // iteration. When it returns updated definitions, the whole wire surface
    // (adapters, presentation, system prompt) rebuilds before the request.
    if (options.foldToolDescriptions) {
      try {
        const foldedTools = await options.foldToolDescriptions();
        if (foldedTools && foldedTools.length > 0) {
          await refreshWireTools(foldedTools);
        }
      } catch {
        // A refresh failure must never break the turn: keep the previous
        // wire surface and let the next iteration try again.
      }
    }

    // In-loop auto-compact: keep a single long run within the context window
    // by summarizing old turns before each provider request. Mirrors Claude
    // Code's per-iteration autocompact and never throws.
    const loopCompact = await extensions.autoCompact(conversation, {
      model,
      modelApi: options.modelApi,
      compactConfig: options.config.compact,
      systemPrompt,
      tools: providerTools,
      maxTokens: maxTokensOverride ?? options.maxTokens ?? options.config.maxTokens,
      lastRequestInputTokens,
      tokenEstimateMultiplier,
      compactWindowPrefixTokens,
      fixedInputTokens: fixedRequestTokens,
      runKey: options.runId,
      signal: options.signal,
    });
    if (
      loopCompact.reason === 'circuit_breaker_open' ||
      (loopCompact.reason === 'failed' && (loopCompact.consecutiveFailures ?? 0) >= 3)
    ) {
      throw new HadamardSdkError(
        `In-loop compaction failed ${loopCompact.consecutiveFailures ?? 3} times; stopping to avoid an endless compact/retry loop.${loopCompact.error ? ` Last error: ${loopCompact.error}` : ''}`,
      );
    }
    if (loopCompact.compacted) {
      lastRequestInputTokens = undefined;
      compactWindowPrefixTokens = loopCompact.tokenEstimateAfter;
      conversation.splice(0, conversation.length, ...loopCompact.messages);
      loopCompactions.push({
        trigger: 'auto',
        iteration,
        tokenEstimateBefore: loopCompact.tokenEstimateBefore,
        tokenEstimateAfter: loopCompact.tokenEstimateAfter,
        messagesSummarized: loopCompact.messagesSummarized,
        preservedMessages: loopCompact.preservedMessages,
        clearedToolResults: loopCompact.clearedToolResults,
        ...(loopCompact.shadowedTokenCount !== undefined
          ? { shadowedTokenCount: loopCompact.shadowedTokenCount }
          : {}),
        summary: loopCompact.summary,
      });
      emitTrajectory({
        type: 'conversation.compacted',
        runId: options.runId,
        iteration,
        trigger: loopCompact.reason === 'prune' ? 'prune' : 'auto',
        messagesSummarized: loopCompact.messagesSummarized,
        ...(loopCompact.shadowedTokenCount !== undefined
          ? { shadowedTokenCount: loopCompact.shadowedTokenCount }
          : {}),
      });
      emitTrajectory({
        type: 'conversation.replaced',
        runId: options.runId,
        iteration,
        reason: 'auto-compact',
        messages: deepClone(loopCompact.messages),
      });
      options.emit?.({
        type: 'conversation.compacted',
        runId: options.runId,
        iteration,
        trigger: 'auto',
        tokenEstimateBefore: loopCompact.tokenEstimateBefore,
        tokenEstimateAfter: loopCompact.tokenEstimateAfter,
        messagesSummarized: loopCompact.messagesSummarized,
        preservedMessages: loopCompact.preservedMessages,
        clearedToolResults: loopCompact.clearedToolResults,
        timestamp: nowIso(),
      });
      await requireLifecycleContinue(options, 'Compact', {
        iteration,
        trigger: 'auto',
        messagesSummarized: loopCompact.messagesSummarized,
      });
    }

    // Hooks may re-route the next request's model/effort/maxTokens mid-run.
    const proposedSettings = await resolveHadamardRequestProposal(options.onRequestProposal, {
      iteration, model, effort,
      maxTokens: maxTokensOverride ?? options.maxTokens ?? options.config.maxTokens,
      input: promptText, workDir,
    });
    model = proposedSettings.model;
    effort = proposedSettings.effort;
    if (proposedSettings.maxTokensProposed) maxTokensOverride = proposedSettings.maxTokens;

    const useAnthropicContextManagement = isAnthropicAPI(options.config.baseURL);
    // Never rewrite historical tool_result content on the wire. Sliding-window
    // local microcompact breaks automatic prefix caches (DeepSeek / MiniMax /
    // other Anthropic-compatible hosts). Align with Claude Code: keep
    // append-only history and rely on full autocompact for context pressure.
    const preparedMessages = prepareHadamardProviderRequestMessages(
      conversation,
      options.config.compact,
      { localToolResultMicrocompact: false },
    );
    const request: ModelRequest = {
      model,
      max_tokens: maxTokensOverride ?? options.maxTokens ?? options.config.maxTokens,
      system: systemPrompt,
      temperature: options.temperature ?? options.config.temperature,
      top_p: options.topP,
      effort,
      tools: resolvedTools.length > 0 ? providerTools : undefined,
      tool_choice: options.toolChoice,
      metadata:
        options.userId ?? options.config.userId
          ? { user_id: options.userId ?? options.config.userId ?? null }
          : undefined,
      // Skip context_management for third-party providers — their APIs
      // may not support server-side message edits, causing undefined behavior.
      context_management: useAnthropicContextManagement
        ? getHadamardApiContextManagement(conversation, options.config.compact)
        : undefined,
      messages: deepClone(preparedMessages.messages.map(stripHadamardMessageProvenance)),
      signal: options.signal,
    };
    // dsh request/header semantics: persist the header only when it changes
    // (first request or a system/tools/config change). Unchanged iterations
    // reuse the last recorded header, keeping the durable log compact.
    const requestHeaderFingerprint = fingerprintRequestHeader(
      request.system,
      request.tools as unknown[] | undefined,
    );
    // The key covers the model too: a mid-run fallback model switch is a
    // header change even when system/tools stay identical.
    const requestHeaderKey = requestHeaderFingerprint.headerKey + ':' + model;
    const requestHeaderChanged = lastRequestHeaderKey === undefined
      || lastRequestHeaderKey !== requestHeaderKey;
    if (requestHeaderChanged) {
      lastRequestHeaderKey = requestHeaderKey;
      emitTrajectory({
        type: 'request.header',
        runId: options.runId,
        iteration,
        model,
        maxTokens: request.max_tokens,
        ...(effort ? { effort } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.top_p !== undefined ? { topP: request.top_p } : {}),
        ...requestHeaderFingerprint,
      });
    }
    const requestByteLength = getRequestByteLength(request);
    const requestTokenBreakdown = estimateRequestTokenBreakdown({
      systemPrompt,
      tools: providerTools,
      messageTokens: preparedMessages.tokenEstimateAfter,
      multiplier: tokenEstimateMultiplier,
    });
    const requestTokenEstimate = requestTokenBreakdown.totalTokens;

    // Prompt caching: cache stable system/tools prefixes and the latest message
    // on Anthropic API hosts. Multiple breakpoints improve cache retention when
    // only the tail changes between tool-loop iterations.
    if (useAnthropicContextManagement && options.config.promptCachingEnabled !== false) {
      const cacheState = applyAnthropicPromptCacheBreakpoints(request);
      const prefixChanged = lastPromptCachePrefixSignature !== undefined &&
        lastPromptCachePrefixSignature !== cacheState.prefixSignature;
      lastPromptCachePrefixSignature = cacheState.prefixSignature;
      options.emit?.({
        type: 'request.prompt_cache',
        runId: options.runId,
        iteration,
        prefixSignature: cacheState.prefixSignature,
        prefixChanged,
        breakpoints: cacheState.breakpoints,
        timestamp: nowIso(),
      });
    }

    options.emit?.({
      type: 'request.started',
      runId: options.runId,
      iteration,
      requestTokenEstimate,
      requestByteLength,
      systemTokenEstimate: requestTokenBreakdown.systemTokens,
      toolTokenEstimate: requestTokenBreakdown.toolTokens,
      messageTokenEstimate: requestTokenBreakdown.messageTokens,
      tokenEstimateMultiplier: requestTokenBreakdown.multiplier,
      localMicrocompact: undefined,
      timestamp: nowIso(),
    });
    emitTrajectory({
      type: 'request.started',
      runId: options.runId,
      iteration,
      model,
      requestTokenEstimate,
    });
    await requireLifecycleContinue(options, 'ModelRequest', {
      iteration,
      model,
      requestTokenEstimate,
      requestByteLength,
    });

    let message: Awaited<ReturnType<ModelApi['createMessage']>>;
    try {
      message = options.streaming
        ? await consumeStream(request, options.modelApi, iteration, options.emit, options.runId)
        : await options.modelApi.createMessage(request);
    } catch (error) {
      // Mid-stream interruptions (socket loss after response headers) never hit
      // the provider-level retry loop; retry the whole iteration here.
      if (streamInterruptionRetryIteration !== iteration) {
        streamInterruptionRetryIteration = iteration;
        streamInterruptionRetries = 0;
      }
      // The request-error strategy (swappable extension) decides the recovery
      // ladder: stream retry → reactive compact → fallback model → rethrow.
      const decision = await extensions.requestError({
        error,
        model,
        fallbackModel: options.config.fallbackModel,
        modelFallbackUsed,
        streamInterruptionRetries,
        reactiveCompactAttempted,
        modelApi: options.modelApi,
        conversation,
        compactConfig: options.config.compact,
        systemPrompt,
        tools: providerTools,
        maxTokens: maxTokensOverride ?? options.maxTokens ?? options.config.maxTokens,
        compactWindowPrefixTokens,
        runKey: options.runId,
        signal: options.signal,
      });
      if ('compactAttempted' in decision && decision.compactAttempted === true) reactiveCompactAttempted = true;
      if (decision.action === 'stream-retry') {
        streamInterruptionRetries = decision.retryCount;
        options.emit?.({
          type: 'request.interrupted',
          runId: options.runId,
          iteration,
          retry: decision.retryCount,
          maxRetries: decision.maxRetries,
          reason: asError(error).message,
          timestamp: nowIso(),
        });
        await sleep(decision.backoffMs, options.signal);
        iteration -= 1;
        iterationReused = true;
        continue;
      }
      if (decision.action === 'reactive-compact') {
        // Reactive compact: the provider rejected the request as too long even
        // though proactive estimates approved it (estimate drift, smaller real
        // context window, or oversized preserved tail). Force-compact the
        // in-flight conversation and retry this iteration, preserving mid-run
        // progress. One attempt per successful-response window, mirroring
        // Claude Code's withheld-prompt-too-long reactive compact.
        const reactiveOutcome = decision.outcome;
        compactWindowPrefixTokens = reactiveOutcome.tokenEstimateAfter;
        conversation.splice(0, conversation.length, ...reactiveOutcome.messages);
        loopCompactions.push({
          trigger: 'reactive',
          iteration,
          tokenEstimateBefore: reactiveOutcome.tokenEstimateBefore,
          tokenEstimateAfter: reactiveOutcome.tokenEstimateAfter,
          messagesSummarized: reactiveOutcome.messagesSummarized,
          preservedMessages: reactiveOutcome.preservedMessages,
          clearedToolResults: reactiveOutcome.clearedToolResults,
          ...(reactiveOutcome.shadowedTokenCount !== undefined
            ? { shadowedTokenCount: reactiveOutcome.shadowedTokenCount }
            : {}),
          summary: reactiveOutcome.summary,
        });
        emitTrajectory({
          type: 'conversation.compacted',
          runId: options.runId,
          iteration,
          trigger: 'reactive',
          messagesSummarized: reactiveOutcome.messagesSummarized,
          ...(reactiveOutcome.shadowedTokenCount !== undefined
            ? { shadowedTokenCount: reactiveOutcome.shadowedTokenCount }
            : {}),
        });
        options.emit?.({
          type: 'conversation.compacted',
          runId: options.runId,
          iteration,
          trigger: 'reactive',
          tokenEstimateBefore: reactiveOutcome.tokenEstimateBefore,
          tokenEstimateAfter: reactiveOutcome.tokenEstimateAfter,
          messagesSummarized: reactiveOutcome.messagesSummarized,
          preservedMessages: reactiveOutcome.preservedMessages,
          clearedToolResults: reactiveOutcome.clearedToolResults,
          timestamp: nowIso(),
        });
        emitTrajectory({
          type: 'conversation.replaced',
          runId: options.runId,
          iteration,
          reason: 'reactive-compact',
          messages: deepClone(reactiveOutcome.messages),
        });
        iteration -= 1;
        iterationReused = true;
        continue;
      }
      if (decision.action === 'fallback-model') {
        // Fallback model: after transport-level retries are exhausted, switch
        // to the configured fallback model once and retry this iteration.
        modelFallbackUsed = true;
        const fromModel = model;
        model = decision.toModel;
        options.emit?.({
          type: 'model.fallback',
          runId: options.runId,
          iteration,
          fromModel,
          toModel: decision.toModel,
          reason: asError(error).message,
          timestamp: nowIso(),
        });
        iteration -= 1;
        iterationReused = true;
        continue;
      }
      throw error;
    }
    streamInterruptionRetryIteration = 0;
    streamInterruptionRetries = 0;
    reactiveCompactAttempted = false;
    await requireLifecycleContinue(options, 'ModelResponse', {
      iteration,
      model,
      messageId: message.id,
      stopReason: message.stop_reason ?? null,
      usage: message.usage,
    });

    if (!options.streaming) {
      const text = extractTextFromContent(message.content);
      if (text) {
        options.emit?.({
          type: 'response.text.delta',
          runId: options.runId,
          iteration,
          delta: text,
          snapshot: text,
          timestamp: nowIso(),
        });
      }
    }

    finalMessage = message;
    const assistantMessage = assistantMessageToParam(message);
    conversation.push(assistantMessage);
    await appendRawTranscript(options, [assistantMessage]);
    emitTrajectory({
      type: 'conversation.append',
      runId: options.runId,
      iteration,
      origin: 'assistant',
      message: assistantMessage,
    });
    emitTrajectory({
      type: 'assistant.message',
      runId: options.runId,
      iteration,
      messageId: message.id,
      stopReason: message.stop_reason ?? null,
      ...(message.usage ? { usage: message.usage } : {}),
    });
    lastRequestInputTokens = getReportedInputTokens(message.usage);
    if (lastRequestInputTokens !== undefined && requestTokenBreakdown.uncalibratedTokens > 0) {
      tokenEstimateMultiplier = calibrateRequestTokenMultiplier({
        currentMultiplier: tokenEstimateMultiplier,
        reportedInputTokens: lastRequestInputTokens,
        uncalibratedRequestTokens: requestTokenBreakdown.uncalibratedTokens,
      });
    }

    for (const hook of postSamplingHooks) {
      await withDeadline(
        'postSampling hook',
        options.config.hookTimeoutMs,
        options.signal,
        ({ signal }) => hook({
        runId: options.runId,
        sessionId: options.sessionId,
        workDir: workDir,
        iteration,
        input: options.input,
        promptText,
        options: {
          systemPrompt: options.systemPrompt,
          tools: options.tools,
          mcpServers: options.mcpServers,
          model: options.model,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          topP: options.topP,
          effort: options.effort,
          toolChoice: options.toolChoice,
          userId: options.userId,
          metadata: options.metadata,
          signal,
        },
        systemPrompt: options.systemPrompt ?? options.config.systemPrompt,
        assistantMessage: deepClone(message),
        messages: deepClone(conversation),
        }),
      );
    }

    // Run stop hooks — allow termination or error injection before tool loop
    const stopHooks = resolveHadamardStopHooks(options.hooks);
    let preventContinuation = false;
    let hookStopReason: string | undefined;
    const hookDurations: Array<{ index: number; durationMs: number }> = [];
    for (let hookIdx = 0; hookIdx < stopHooks.length; hookIdx++) {
      const stopHook = stopHooks[hookIdx]!;
      const hookStarted = Date.now();
      const result = await withDeadline(
        'stop hook',
        options.config.hookTimeoutMs,
        options.signal,
        ({ signal }) => stopHook({
        runId: options.runId,
        sessionId: options.sessionId,
        messages: deepClone(conversation),
        assistantMessage: deepClone(message),
        systemPrompt: options.systemPrompt ?? options.config.systemPrompt,
        stopHookActive: true,
        signal,
      }),
      );
      const durationMs = Date.now() - hookStarted;
      hookDurations.push({ index: hookIdx, durationMs });
      if (result?.preventContinuation) {
        preventContinuation = true;
        hookStopReason = result.stopReason ?? hookStopReason;
      }
      if (result?.blockingErrors && result.blockingErrors.length > 0) {
        for (const err of result.blockingErrors) {
          const msg = typeof err === 'string' ? err : `${err.command ? `[${err.command}] ` : ''}${err.reason}`;
          const hookErrorReminder = {
            role: 'user' as const,
            content: `<system-reminder>\nStop hook reported blocking error: ${msg}\n</system-reminder>`,
          };
          conversation.push(hookErrorReminder);
          await appendRawTranscript(options, [hookErrorReminder]);
          emitTrajectory({
            type: 'conversation.append',
            runId: options.runId,
            iteration,
            origin: 'system-nudge',
            message: hookErrorReminder,
          });
        }
      }
      if (result?.nonBlockingErrors && result.nonBlockingErrors.length > 0) {
        for (const err of result.nonBlockingErrors) {
          const msg = typeof err === 'string' ? err : `${err.command ? `[${err.command}] ` : ''}${err.reason}`;
          options.emit?.({
            type: 'response.text.delta',
            runId: options.runId,
            iteration,
            delta: `\n[stop hook warning] ${msg}`,
            snapshot: '',
            timestamp: nowIso(),
          });
        }
      }
    }

    for (const block of message.content) {
      options.emit?.({
        type: 'response.content',
        runId: options.runId,
        iteration,
        content: block,
        timestamp: nowIso(),
      });
    }

    options.emit?.({
      type: 'response.message',
      runId: options.runId,
      iteration,
      message,
      timestamp: nowIso(),
    });

    requestSummaries.push({
      iteration,
      messageId: message.id,
      model,
      stopReason: message.stop_reason ?? null,
      usage: message.usage,
      text: extractTextFromContent(message.content),
      createdAt: nowIso(),
      requestTokenEstimate,
      requestByteLength,
      localMicrocompact: undefined,
    });

    const toolUses = message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
    if (lastStep && lastStep.iteration === iteration) {
      lastStep.toolUseCount = toolUses.length;
    }

    if (
      !preventContinuation &&
      message.stop_reason === 'max_tokens' &&
      toolUses.length > 0 &&
      toolUses.some(isLikelyTruncatedToolUse)
    ) {
      const truncatedToolUseReminder = {
        role: 'user' as const,
        content: toolUses.map(toolUse => ({
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          is_error: true,
          content:
            'The model response hit max_tokens while constructing this tool call, so its JSON arguments were incomplete. Retry the tool call with complete JSON arguments and smaller output.',
        })),
      };
      conversation.push(truncatedToolUseReminder);
      await appendRawTranscript(options, [truncatedToolUseReminder]);
      emitTrajectory({
        type: 'conversation.append',
        runId: options.runId,
        iteration,
        origin: 'system-nudge',
        message: truncatedToolUseReminder,
      });
      continue;
    }

    // max_tokens recovery: when the response was truncated mid-thought with no
    // tool calls, nudge the model to resume instead of ending the run on a
    // half-finished answer. Mirrors Claude Code's recovery loop (limit 3).
    if (
      !preventContinuation &&
      toolUses.length === 0 &&
      message.stop_reason === 'max_tokens' &&
      maxTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT
    ) {
      maxTokensRecoveryCount += 1;
      const recoveryNudge = {
        role: 'user' as const,
        content:
          'Output token limit hit. Resume directly — no apology, no recap of what you were doing. ' +
          'Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.',
      };
      conversation.push(recoveryNudge);
      await appendRawTranscript(options, [recoveryNudge]);
      emitTrajectory({
        type: 'conversation.append',
        runId: options.runId,
        iteration,
        origin: 'system-nudge',
        message: recoveryNudge,
      });
      continue;
    }

    if (!preventContinuation && toolUses.length === 0) {
      const queuedSteering = (await options.drainQueuedInputs?.()) ?? [];
      const queuedFollowUps = options.drainFollowUpInputs?.() ?? [];
      if (queuedSteering.length > 0 || queuedFollowUps.length > 0) {
        const steeringMessage = {
          role: 'user' as const,
          content: [
            ...queuedSteering.map((text) => ({
              type: 'text' as const,
              text: `[User steering message sent while you were working — factor it into the current task]\n${text}`,
            })),
            ...queuedFollowUps.map((text) => ({
              type: 'text' as const,
              text: `[User follow-up queued for after your previous response]\n${text}`,
            })),
          ],
        };
        conversation.push(steeringMessage);
        await appendRawTranscript(options, [steeringMessage]);
        emitTrajectory({
          type: 'conversation.append',
          runId: options.runId,
          iteration,
          origin: 'system-nudge',
          message: steeringMessage,
        });
        maxTokensRecoveryCount = 0;
        continue;
      }
    }

    if (preventContinuation || toolUses.length === 0) {
      const completedAt = nowIso();
      if (!finalMessage) {
        throw new HadamardSdkError('No final message was produced.');
      }
      const result: AgentRunResult = {
        runId: options.runId,
        sessionId: options.sessionId,
        model,
        text: extractTextFromContent(finalMessage.content),
        message: finalMessage,
        messages: conversation,
        stopReason: finalMessage.stop_reason ?? null,
        hookStopReason,
        usage: aggregateRequestUsage(requestSummaries),
        requests: requestSummaries,
        toolCalls,
        permissionDecisions,
        ...(loopCompactions.length > 0 ? { loopCompactions } : {}),
        startedAt,
        completedAt,
      };
      closeStepAndTurn(result.stopReason);
      emitTrajectory({
        type: 'run.completed',
        runId: options.runId,
        stopReason: result.stopReason,
      });
      await runTypedLifecycleHooks(options, 'Stop', {
        iteration,
        stopReason: result.stopReason,
      });
      await runTypedLifecycleHooks(options, 'TurnEnd', {
        iteration,
        stopReason: result.stopReason,
        toolCalls: result.toolCalls.length,
      });
      return result;
    }

    if (iteration >= options.config.maxToolIterations) {
      if (toolUses.length > 0) {
        const limitMessage = {
          role: 'user' as const,
          content: toolUses.map(toolUse => ({
            type: 'tool_result' as const,
            tool_use_id: toolUse.id,
            is_error: true,
            content: `The run exceeded the max tool iteration limit (${options.config.maxToolIterations}) before this tool could execute.`,
          })),
        };
        conversation.push(limitMessage);
        await appendRawTranscript(options, [limitMessage]);
        emitTrajectory({
          type: 'conversation.append',
          runId: options.runId,
          iteration,
          origin: 'system-nudge',
          message: limitMessage,
        });
      }
      const completedAt = nowIso();
      if (finalMessage) {
        const result: AgentRunResult = {
          runId: options.runId,
          sessionId: options.sessionId,
          model,
          text: extractTextFromContent(finalMessage.content),
          message: finalMessage,
          messages: conversation,
          stopReason: finalMessage.stop_reason ?? null,
          incompleteReason: `max_tool_iterations_exceeded:${options.config.maxToolIterations}`,
          maxToolIterationsExceeded: true,
          hookStopReason,
          usage: aggregateRequestUsage(requestSummaries),
          requests: requestSummaries,
          toolCalls,
          permissionDecisions,
          ...(loopCompactions.length > 0 ? { loopCompactions } : {}),
          startedAt,
          completedAt,
        };
        closeStepAndTurn(result.stopReason, result.incompleteReason);
        emitTrajectory({
          type: 'run.completed',
          runId: options.runId,
          stopReason: result.stopReason,
          incompleteReason: result.incompleteReason,
        });
        await runTypedLifecycleHooks(options, 'Stop', {
          iteration,
          stopReason: result.incompleteReason,
        });
        await runTypedLifecycleHooks(options, 'TurnEnd', {
          iteration,
          stopReason: result.incompleteReason,
          toolCalls: result.toolCalls.length,
        });
        return result;
      }
      throw new HadamardSdkError(
        `The run exceeded the max tool iteration limit (${options.config.maxToolIterations}).`,
      );
    }

    const runSingleToolUse = (toolUse: ToolUseBlock) => {
      emitTrajectory({
        type: 'tool.call',
        runId: options.runId,
        iteration,
        toolUseId: toolUse.id,
        name: toolUse.name,
      });
      return executeConversationToolUse({
        options,
        iteration,
        toolUse,
        adapter: toolMap.get(toolUse.name),
        workDir,
        promptText,
        model,
        effort,
        onPermissionDecision: decision => {
          permissionDecisions.push(decision);
        },
        onWorkDirChange: nextWorkDir => {
          workDir = nextWorkDir;
          options.onSessionWorkDirChange?.(workDir);
        },
      });
    };

    // Execute tool calls under the dsh-style scheduling contract: lazy
    // fail-closed classification, a bounded rolling pool for parallel-safe
    // calls, exclusive barriers that hold through completion, model-ordered
    // results, and abort semantics that drain started calls while leaving
    // skipped calls unexecuted (the caller records synthetic results below).
    const maxParallelToolCalls = Math.max(1, options.config.maxParallelToolCalls ?? 10);
    const classifyToolUse = (toolUse: ToolUseBlock) => isToolUseConcurrencySafe(toolUse, toolMap);
    const additionalContexts: { type: 'text'; text: string }[] = [];
    let concludedTurn = false;
    let abortedAfterToolBatch = false;
    const schedule = await executeToolUsesWithContract(
      toolUses,
      classifyToolUse,
      (toolUse) => runSingleToolUse(toolUse),
      { maxParallel: maxParallelToolCalls, signal: options.signal },
    );
    for (let batchIndex = 0; batchIndex < toolUses.length; batchIndex += 1) {
      const toolUse = toolUses[batchIndex]!;
      const outcome = schedule.results[batchIndex];
      if (outcome === undefined) {
        // Aborted before dispatch: record a synthetic result so persisted
        // sessions never hold dangling tool_use ids (dsh
        // TOOL_ABORTED_BEFORE_DISPATCH semantics).
        const synthetic = buildAbortedBeforeDispatchResult(toolUse);
        toolCalls.push(synthetic.record);
        toolResults.push(synthetic.resultBlock);
        options.emit?.({
          type: 'tool.call',
          runId: options.runId,
          iteration,
          call: synthetic.callPayload,
          timestamp: synthetic.record.completedAt,
        });
        options.emit?.({
          type: 'tool.result',
          runId: options.runId,
          iteration,
          result: synthetic.record,
          timestamp: synthetic.record.completedAt,
        });
        emitTrajectory({
          type: 'tool.call',
          runId: options.runId,
          iteration,
          toolUseId: toolUse.id,
          name: toolUse.name,
          abortedBeforeDispatch: true,
        });
        emitTrajectory({
          type: 'tool.result',
          runId: options.runId,
          iteration,
          toolUseId: toolUse.id,
          name: toolUse.name,
          isError: true,
        });
        continue;
      }
      if (outcome.permissionBehavior === 'deny') denialTracker.recordDenial();
      else if (outcome.permissionBehavior === 'allow') denialTracker.recordAllow();
      toolCalls.push(outcome.record);
      toolResults.push(outcome.resultBlock);
      options.emit?.({
        type: 'tool.result',
        runId: options.runId,
        iteration,
        result: outcome.record,
        timestamp: outcome.record.completedAt,
      });
      emitTrajectory({
        type: 'tool.result',
        runId: options.runId,
        iteration,
        toolUseId: toolUse.id,
        name: toolUse.name,
        isError: outcome.record.isError,
      });
      if (outcome.additionalContexts && outcome.additionalContexts.length > 0) {
        additionalContexts.push(...outcome.additionalContexts);
      }
      if (outcome.concludesTurn) {
        concludedTurn = true;
      }
    }
    if (schedule.aborted) {
      abortedAfterToolBatch = true;
      if (lastStep && lastStep.iteration === iteration) {
        lastStep.aborted = true;
      }
    }

    // Aggregate per-message budget: N parallel tools can each pass the
    // per-tool cap yet collectively flood one user message. Artifact the
    // largest results until the batch fits (mirrors Claude Code's 200k cap).
    await enforceToolResultsAggregateBudget(toolResults, {
      runId: options.runId,
      iteration,
      workDir: workDir,
      maxTotalChars: options.config.compact.toolResultsPerMessageMaxChars ?? 200_000,
      nameByToolUseId: new Map(
        toolCalls.slice(-toolUses.length).map((record) => [record.id, record.publicName]),
      ),
    });

    // Todo continuity reminder: when TodoWrite is available but unused for a
    // stretch of iterations, re-inject the current todo state so long runs
    // stay anchored to the plan (mirrors Claude Code's 10-turn reminder).
    // The interval/state lives in the swappable todo-reminder extension.
    const todoReminder = extensions.todoReminder.observe({
      toolUseNames: toolUses.map((toolUse) => toolUse.name),
      todoToolAvailable: toolMap.has(TODO_WRITE_TOOL_NAME),
      sessionKey: options.sessionId ?? options.runId,
    });
    if (todoReminder) {
      const lastResult = toolResults.at(-1);
      if (lastResult) appendTextToToolResultContent(lastResult, todoReminder);
    }

    // Repeat-call guard: consecutive identical ERROR calls by canonical
    // arguments get gentle-then-detailed reminders at thresholds [3, 5], and
    // escalate to a hard stop at the ceiling (dsh repeat-tool-reminder shape).
    // Only newly added results (from this iteration) are inspected.
    let repeatReminder: string | undefined;
    let repeatHardStop = false;
    for (const tr of toolResults.slice(-toolUses.length)) {
      const record = toolCalls.find((tc) => tc.id === tr.tool_use_id);
      if (record) {
        const outcome = extensions.repeatCall.record(record.name, record.input, tr.is_error === true);
        if (outcome.reminder) repeatReminder = outcome.reminder;
        if (outcome.hardStop) {
          repeatHardStop = true;
          lastFailedTool = record.name;
        }
      }
    }
    if (repeatReminder && toolResults.length > 0) {
      const lastResult = toolResults.at(-1)!;
      appendTextToToolResultContent(lastResult, `<system-reminder>\n${repeatReminder}\n</system-reminder>`);
    }

    // Mid-run steering: user messages queued while tools were running ride in
    // the same user message as the tool results, so the model sees them on
    // the very next request (mirrors Claude Code's queued-command attachments).
    const queuedInputs = (await options.drainQueuedInputs?.()) ?? [];
    // dsh inject target: step-boundary context that never wakes the turn.
    const injectedInputs = (await options.drainInjectInputs?.()) ?? [];

    // RestoreCheckpoint may have rewritten the durable transcript during this
    // tool batch. Adopt that snapshot and stop the turn so mid-run persistence
    // cannot overwrite the restore with the pre-restore in-memory conversation.
    const restoredConversation = options.takePendingConversationRestore?.();
    if (restoredConversation) {
      conversation.splice(0, conversation.length, ...deepClone(restoredConversation));
      emitTrajectory({
        type: 'conversation.replaced',
        runId: options.runId,
        iteration,
        reason: 'restore',
        messages: deepClone(restoredConversation),
      });
      toolResults = [];
      if (options.onConversationCheckpoint) {
        try {
          await options.onConversationCheckpoint(deepClone(conversation));
        } catch {
          // Never fail the turn over a checkpoint write.
        }
      }
      const completedAt = nowIso();
      const restoreText =
        'Conversation restored from checkpoint. The in-flight turn was discarded.';
      const result: AgentRunResult = {
        runId: options.runId,
        sessionId: options.sessionId,
        model,
        text: restoreText,
        message: {
          id: `restore-${options.runId}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: restoreText }],
          model,
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        messages: conversation,
        stopReason: 'end_turn',
        incompleteReason: 'conversation_restored',
        hookStopReason,
        usage: aggregateRequestUsage(requestSummaries),
        requests: requestSummaries,
        toolCalls,
        permissionDecisions,
        ...(loopCompactions.length > 0 ? { loopCompactions } : {}),
        startedAt,
        completedAt,
      };
      closeStepAndTurn(result.stopReason, result.incompleteReason);
      emitTrajectory({
        type: 'run.completed',
        runId: options.runId,
        stopReason: result.stopReason,
        incompleteReason: result.incompleteReason,
      });
      await runTypedLifecycleHooks(options, 'Stop', {
        iteration,
        stopReason: result.incompleteReason,
      });
      await runTypedLifecycleHooks(options, 'TurnEnd', {
        iteration,
        stopReason: result.incompleteReason,
        toolCalls: result.toolCalls.length,
      });
      return result;
    }

    // Always push tool results before any early return so the conversation
    // never ends with dangling tool_use blocks (which would make a persisted
    // session unusable: providers reject unpaired tool_use ids on resume).
    const toolResultMessage = {
      role: 'user' as const,
      content: [
        ...toolResults,
        // Tool-deferred model-facing context rides the same user message as
        // the tool results so the model sees it on the very next request
        // (dsh additionalContexts → next-step inbox semantics).
        ...additionalContexts,
        ...queuedInputs.map((text) => ({
          type: 'text' as const,
          text: `[User message sent while you were working — factor it into your current task]\n${text}`,
        })),
        ...injectedInputs.map((text) => ({
          type: 'text' as const,
          text: `[Injected context for the next step]\n${text}`,
        })),
      ],
    };
    conversation.push(toolResultMessage);
    await appendRawTranscript(options, [toolResultMessage]);
    emitTrajectory({
      type: 'conversation.append',
      runId: options.runId,
      iteration,
      origin: 'tool-results',
      message: toolResultMessage,
    });
    toolResults = [];

    // Persist mid-run so a host kill (e.g. accidental taskkill of node.exe)
    // still leaves a resumable transcript instead of an empty sessions/.
    if (options.onConversationCheckpoint) {
      try {
        await options.onConversationCheckpoint(deepClone(conversation));
      } catch {
        // Never fail the turn over a checkpoint write.
      }
    }

    if (abortedAfterToolBatch) {
      ensureNotAborted(options.signal);
    }

    // A tool declared the turn complete (concludesTurn): results and contexts
    // are already committed above, so end the turn as a normal completion.
    if (concludedTurn) {
      if (!finalMessage) {
        throw new HadamardSdkError('No final message was produced.');
      }
      const completedAt = nowIso();
      const result: AgentRunResult = {
        runId: options.runId,
        sessionId: options.sessionId,
        model,
        text: extractTextFromContent(finalMessage.content),
        message: finalMessage,
        messages: conversation,
        stopReason: 'end_turn',
        hookStopReason,
        usage: aggregateRequestUsage(requestSummaries),
        requests: requestSummaries,
        toolCalls,
        permissionDecisions,
        ...(loopCompactions.length > 0 ? { loopCompactions } : {}),
        startedAt,
        completedAt,
      };
      closeStepAndTurn(result.stopReason);
      emitTrajectory({
        type: 'run.completed',
        runId: options.runId,
        stopReason: result.stopReason,
      });
      await runTypedLifecycleHooks(options, 'Stop', {
        iteration,
        stopReason: result.stopReason,
      });
      await runTypedLifecycleHooks(options, 'TurnEnd', {
        iteration,
        stopReason: result.stopReason,
        toolCalls: result.toolCalls.length,
      });
      return result;
    }

    if (
      denialTracker.isExceeded(MAX_CONSECUTIVE_PERMISSION_DENIALS) ||
      (repeatHardStop && lastFailedTool)
    ) {
      const completedAt = nowIso();
      const deniedRepeatedly = denialTracker.isExceeded(MAX_CONSECUTIVE_PERMISSION_DENIALS);
      const incompleteReason = deniedRepeatedly
        ? 'consecutive_permission_denials'
        : `consecutive_tool_failures:${lastFailedTool}`;
      if (finalMessage) {
        const result: AgentRunResult = {
          runId: options.runId,
          sessionId: options.sessionId,
          model,
          text: extractTextFromContent(finalMessage.content),
          message: finalMessage,
          messages: conversation,
          stopReason: finalMessage.stop_reason ?? null,
          incompleteReason,
          hookStopReason,
          usage: aggregateRequestUsage(requestSummaries),
          requests: requestSummaries,
          toolCalls,
          permissionDecisions,
          ...(loopCompactions.length > 0 ? { loopCompactions } : {}),
          startedAt,
          completedAt,
        };
        closeStepAndTurn(result.stopReason, result.incompleteReason);
        emitTrajectory({
          type: 'run.completed',
          runId: options.runId,
          stopReason: result.stopReason,
          incompleteReason: result.incompleteReason,
        });
        await runTypedLifecycleHooks(options, 'Stop', {
          iteration,
          stopReason: result.incompleteReason,
        });
        await runTypedLifecycleHooks(options, 'TurnEnd', {
          iteration,
          stopReason: result.incompleteReason,
          toolCalls: result.toolCalls.length,
        });
        return result;
      }
      throw new HadamardSdkError(
        deniedRepeatedly
          ? `Tool calls were denied ${denialTracker.consecutiveDenials} times consecutively. Stopping to prevent a refusal loop.`
          : `Tool "${lastFailedTool}" repeated the identical failing call past the guard ceiling. Stopping to prevent a retry loop.`,
      );
    }
  }
}

/** Complete name→adapter registry (aliases included) for one resolved tool set. */
function buildConversationToolMap(
  resolvedTools: readonly import('../types.js').ResolvedToolAdapter[],
): Map<string, import('../types.js').ResolvedToolAdapter> {
  const toolMap = new Map<string, import('../types.js').ResolvedToolAdapter>();
  for (const tool of resolvedTools) {
    toolMap.set(tool.publicName, tool);
    for (const alias of tool.aliases ?? []) toolMap.set(alias, tool);
  }
  return toolMap;
}

