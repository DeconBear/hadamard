import type {
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '../provider/types.js';

import { HadamardSdkError } from '../errors.js';
import {
  getHadamardTodoSnapshot,
  TODO_WRITE_TOOL_NAME,
} from '../tools/todo/TodoWriteTool.js';
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
import {
  compactHadamardConversationIfNeeded,
  isHadamardPromptTooLongError,
} from './hadamardCompact.js';
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
import { consumeStream } from './modelStreamConsumer.js';
import {
  appendTextToToolResultContent,
  buildTodoReminderText,
  isLikelyTruncatedToolUse,
  partitionToolUsesForConcurrency,
  runSequentially,
  runWithConcurrencyLimit,
} from './conversationToolBatch.js';
import {
  MAX_STREAM_INTERRUPTION_RETRIES,
  aggregateRequestUsage,
  applyAnthropicPromptCacheBreakpoints,
  clamp,
  ensureNotAborted,
  getReportedInputTokens,
  getRequestByteLength,
  isModelFallbackEligibleError,
  isAnthropicAPI,
  isRetryableStreamInterruption,
  sleep,
  streamInterruptionBackoffMs,
} from './modelRequestPolicy.js';

const MAX_CONCURRENT_TOOL_USES = 10;
const TODO_REMINDER_INTERVAL = 10;
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
const MAX_CONSECUTIVE_PERMISSION_DENIALS = 3;

export async function executeConversation(
  options: ExecuteConversationOptions,
): Promise<AgentRunResult> {
  const startedAt = nowIso();
  let workDir = options.sessionWorkDir ?? options.config.workDir;
  let model = options.model ?? options.config.model;
  const effort =
    options.effort === 'auto'
      ? undefined
      : options.effort ?? options.config.effort;
  const promptText =
    typeof options.input === 'string' ? options.input : extractTextFromContent(options.input);
  const postSamplingHooks = resolveHadamardPostSamplingHooks(options.hooks);
  const conversation = deepClone(options.messages ?? []);
  let initialUserMessage: MessageParam | undefined;
  if (!options.skipInitialInput) {
    conversation.push(...deepClone(options.prefixedMessages ?? []));
    initialUserMessage = buildUserMessage(options.input);
    conversation.push(initialUserMessage);
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
  }
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

  const resolvedTools = await options.mcpManager.resolveToolAdapters(
    options.tools ?? [],
    options.mcpServers ?? [],
    { signal: options.signal, timeoutMs: options.config.mcpTimeoutMs },
  );
  const fixedRequestTokens = estimateFixedRequestTokens(
    options.systemPrompt ?? options.config.systemPrompt,
    resolvedTools,
  );
  const toolMap = new Map(resolvedTools.map((tool) => [tool.publicName, tool]));
  const requestSummaries: AgentRequestSummary[] = [];
  const toolCalls: AgentToolCallRecord[] = [];
  const permissionDecisions: HadamardPermissionDecision[] = [];
  const loopCompactions: AgentLoopCompactionRecord[] = [];

  let iteration = 0;
  let finalMessage: AgentRunResult['message'] | undefined;
  let toolResults: ToolResultBlockParam[] = [];
  let consecutiveFailures = 0;
  const denialTracker = createDenialTracker();
  let lastFailedTool = '';
  let maxTokensRecoveryCount = 0;
  let modelFallbackUsed = false;
  let iterationsSinceTodoWrite = 0;
  let streamInterruptionRetryIteration = 0;
  let streamInterruptionRetries = 0;
  let reactiveCompactAttempted = false;
  let lastRequestInputTokens: number | undefined;
  let tokenEstimateMultiplier = 1;
  let compactWindowPrefixTokens = 0;
  let lastPromptCachePrefixSignature: string | undefined;

  while (true) {
    ensureNotAborted(options.signal);
    iteration += 1;

    // In-loop auto-compact: keep a single long run within the context window
    // by summarizing old turns before each provider request. Mirrors Claude
    // Code's per-iteration autocompact and never throws.
    const loopCompact = await compactHadamardConversationIfNeeded(conversation, {
      model,
      modelApi: options.modelApi,
      compactConfig: options.config.compact,
      maxTokens: options.maxTokens ?? options.config.maxTokens,
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
        summary: loopCompact.summary,
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
      max_tokens: options.maxTokens ?? options.config.maxTokens,
      system: options.systemPrompt ?? options.config.systemPrompt,
      temperature: options.temperature ?? options.config.temperature,
      top_p: options.topP,
      effort,
      tools: resolvedTools.length > 0 ? resolvedTools.map((tool) => tool.providerTool) : undefined,
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
      messages: deepClone(preparedMessages.messages),
      signal: options.signal,
    };
    const requestByteLength = getRequestByteLength(request);
    const requestTokenEstimate = Math.ceil(
      (preparedMessages.tokenEstimateAfter + fixedRequestTokens) * tokenEstimateMultiplier,
    );

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
      localMicrocompact: undefined,
      timestamp: nowIso(),
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
      if (
        isRetryableStreamInterruption(error) &&
        streamInterruptionRetries < MAX_STREAM_INTERRUPTION_RETRIES
      ) {
        streamInterruptionRetries += 1;
        options.emit?.({
          type: 'request.interrupted',
          runId: options.runId,
          iteration,
          retry: streamInterruptionRetries,
          maxRetries: MAX_STREAM_INTERRUPTION_RETRIES,
          reason: asError(error).message,
          timestamp: nowIso(),
        });
        await sleep(
          streamInterruptionBackoffMs(streamInterruptionRetries),
          options.signal,
        );
        iteration -= 1;
        continue;
      }
      // Reactive compact: the provider rejected the request as too long even
      // though proactive estimates approved it (estimate drift, smaller real
      // context window, or oversized preserved tail). Force-compact the
      // in-flight conversation and retry this iteration, preserving mid-run
      // progress. One attempt per successful-response window, mirroring
      // Claude Code's withheld-prompt-too-long reactive compact.
      if (isHadamardPromptTooLongError(error) && !reactiveCompactAttempted) {
        reactiveCompactAttempted = true;
        const reactiveOutcome = await compactHadamardConversationIfNeeded(conversation, {
          model,
          modelApi: options.modelApi,
          compactConfig: options.config.compact,
          maxTokens: options.maxTokens ?? options.config.maxTokens,
          compactWindowPrefixTokens,
          runKey: options.runId,
          signal: options.signal,
          force: true,
        });
        if (reactiveOutcome.compacted) {
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
            summary: reactiveOutcome.summary,
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
          iteration -= 1;
          continue;
        }
      }
      // Fallback model: after transport-level retries are exhausted, switch to
      // the configured fallback model once and retry this iteration.
      const fallbackModel = options.config.fallbackModel;
      if (
        fallbackModel &&
        !modelFallbackUsed &&
        fallbackModel !== model &&
        isModelFallbackEligibleError(error)
      ) {
        modelFallbackUsed = true;
        const fromModel = model;
        model = fallbackModel;
        options.emit?.({
          type: 'model.fallback',
          runId: options.runId,
          iteration,
          fromModel,
          toModel: fallbackModel,
          reason: asError(error).message,
          timestamp: nowIso(),
        });
        iteration -= 1;
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
    lastRequestInputTokens = getReportedInputTokens(message.usage);
    if (lastRequestInputTokens !== undefined && requestTokenEstimate > 0) {
      const observedMultiplier = clamp(
        lastRequestInputTokens / Math.max(
          preparedMessages.tokenEstimateAfter,
          1,
        ),
        0.5,
        8,
      );
      tokenEstimateMultiplier = clamp(
        (tokenEstimateMultiplier * 0.65) + (observedMultiplier * 0.35),
        0.5,
        8,
      );
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
          conversation.push({
            role: 'user',
            content: `<system-reminder>\nStop hook reported blocking error: ${msg}\n</system-reminder>`,
          });
          await appendRawTranscript(options, [conversation.at(-1)!]);
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

    if (
      !preventContinuation &&
      message.stop_reason === 'max_tokens' &&
      toolUses.length > 0 &&
      toolUses.some(isLikelyTruncatedToolUse)
    ) {
      conversation.push({
        role: 'user',
        content: toolUses.map(toolUse => ({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          is_error: true,
          content:
            'The model response hit max_tokens while constructing this tool call, so its JSON arguments were incomplete. Retry the tool call with complete JSON arguments and smaller output.',
        })),
      });
      await appendRawTranscript(options, [conversation.at(-1)!]);
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
      conversation.push({
        role: 'user',
        content:
          'Output token limit hit. Resume directly — no apology, no recap of what you were doing. ' +
          'Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.',
      });
      await appendRawTranscript(options, [conversation.at(-1)!]);
      continue;
    }

    if (!preventContinuation && toolUses.length === 0) {
      const queuedSteering = (await options.drainQueuedInputs?.()) ?? [];
      const queuedFollowUps = options.drainFollowUpInputs?.() ?? [];
      if (queuedSteering.length > 0 || queuedFollowUps.length > 0) {
        conversation.push({
          role: 'user',
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
        });
        await appendRawTranscript(options, [conversation.at(-1)!]);
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
        conversation.push({
          role: 'user',
          content: toolUses.map(toolUse => ({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            is_error: true,
            content: `The run exceeded the max tool iteration limit (${options.config.maxToolIterations}) before this tool could execute.`,
          })),
        });
        await appendRawTranscript(options, [conversation.at(-1)!]);
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

    const runSingleToolUse = (toolUse: ToolUseBlock) =>
      executeConversationToolUse({
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

    // Execute tool batches: consecutive concurrency-safe (read-only) tools run
    // in parallel (limit 10), everything else serially. Results are recorded
    // in the original tool_use order regardless of completion order.
    let abortedAfterToolBatch = false;
    for (const batch of partitionToolUsesForConcurrency(toolUses, toolMap)) {
      const outcomes =
        batch.concurrent && batch.toolUses.length > 1
          ? await runWithConcurrencyLimit(
              batch.toolUses,
              MAX_CONCURRENT_TOOL_USES,
              runSingleToolUse,
            )
          : await runSequentially(batch.toolUses, runSingleToolUse);
      for (const outcome of outcomes) {
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
      }
      if (options.signal?.aborted) {
        abortedAfterToolBatch = true;
        break;
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
    if (toolUses.some((toolUse) => toolUse.name === TODO_WRITE_TOOL_NAME)) {
      iterationsSinceTodoWrite = 0;
    } else {
      iterationsSinceTodoWrite += 1;
      if (toolMap.has(TODO_WRITE_TOOL_NAME) && iterationsSinceTodoWrite >= TODO_REMINDER_INTERVAL) {
        const reminder = buildTodoReminderText(
          getHadamardTodoSnapshot(options.sessionId ?? options.runId),
        );
        const lastResult = toolResults.at(-1);
        if (lastResult) {
          appendTextToToolResultContent(lastResult, reminder);
          iterationsSinceTodoWrite = 0;
        }
      }
    }

    // Detect repeated tool failures to prevent retry loops
    // Only check newly added results (from this iteration)
    for (const tr of toolResults.slice(-toolUses.length)) {
      if (tr.is_error) {
        const toolName = toolCalls.find((tc) => tc.id === tr.tool_use_id)?.name;
        if (toolName && toolName === lastFailedTool) {
          consecutiveFailures += 1;
        } else {
          lastFailedTool = toolName ?? '';
          consecutiveFailures = 1;
        }
      } else {
        consecutiveFailures = 0;
        lastFailedTool = '';
      }
    }

    // Mid-run steering: user messages queued while tools were running ride in
    // the same user message as the tool results, so the model sees them on
    // the very next request (mirrors Claude Code's queued-command attachments).
    const queuedInputs = (await options.drainQueuedInputs?.()) ?? [];

    // RestoreCheckpoint may have rewritten the durable transcript during this
    // tool batch. Adopt that snapshot and stop the turn so mid-run persistence
    // cannot overwrite the restore with the pre-restore in-memory conversation.
    const restoredConversation = options.takePendingConversationRestore?.();
    if (restoredConversation) {
      conversation.splice(0, conversation.length, ...deepClone(restoredConversation));
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
    conversation.push({
      role: 'user',
      content: [
        ...toolResults,
        ...queuedInputs.map((text) => ({
          type: 'text' as const,
          text: `[User message sent while you were working — factor it into your current task]\n${text}`,
        })),
      ],
    });
    await appendRawTranscript(options, [conversation.at(-1)!]);
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

    if (
      denialTracker.isExceeded(MAX_CONSECUTIVE_PERMISSION_DENIALS) ||
      (consecutiveFailures >= 3 && lastFailedTool)
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
          : `Tool "${lastFailedTool}" failed ${consecutiveFailures} times consecutively. Stopping to prevent retry loop.`,
      );
    }
  }
}

function estimateFixedRequestTokens(
  systemPrompt: string | undefined,
  tools: readonly { providerTool: unknown }[],
): number {
  const systemChars = systemPrompt?.length ?? 0;
  let toolChars = 0;
  try {
    toolChars = JSON.stringify(tools.map(tool => tool.providerTool)).length;
  } catch {
    toolChars = 0;
  }
  return Math.ceil((systemChars + toolChars) / 4);
}

