import type { ConversationExtensionPoints } from '../types.js';
import type { MessageParam } from '../provider/types.js';
import {
  compactHadamardConversationIfNeeded,
  isHadamardPromptTooLongError,
} from './hadamardCompact.js';
import { RepeatCallGuard } from './repeatCallGuard.js';
import { buildTodoReminderText } from './conversationToolBatch.js';
import { getHadamardTodoSnapshot, TODO_WRITE_TOOL_NAME } from '../tools/todo/TodoWriteTool.js';
import { estimateHadamardConversationTokens } from '../memory/hadamardSessionMemoryState.js';
import {
  MAX_STREAM_INTERRUPTION_RETRIES,
  isModelFallbackEligibleError,
  isRetryableStreamInterruption,
  streamInterruptionBackoffMs,
} from './modelRequestPolicy.js';
import { defineContributionServiceKey } from '../contrib/contributionHost.js';
import type { ContributionApplyContext, HadamardRuntimeContribution } from '../contrib/contributionHost.js';

export type { ConversationExtensionPoints } from '../types.js';

/**
 * Built-in implementations of the ReAct driver's swappable strategies
 * (compaction, request-error recovery, repeat-call guard, todo reminder).
 * The driver keeps the state machine, request assembly, tool scheduling,
 * pairing, safety, and abort invariants; these seams only decide what the
 * driver should do next. The factory preserves the exact current behavior
 * and doubles as the default contribution registered in the runtime
 * contribution host.
 *
 * @module src/runtime/conversationExtensions
 */

const TODO_REMINDER_INTERVAL = 10;

function splitLatestPairingSafeSegment(messages: readonly MessageParam[]): {
  prefix: MessageParam[];
  latest: MessageParam[];
} | undefined {
  if (messages.length < 3) return undefined;
  let start = messages.length - 1;
  const newest = messages[start];
  if (newest?.role === 'user' && Array.isArray(newest.content)) {
    const pendingToolUseIds = new Set(newest.content.flatMap(block => {
      const candidate = block as { type?: string; tool_use_id?: string };
      return candidate.type === 'tool_result' && typeof candidate.tool_use_id === 'string'
        ? [candidate.tool_use_id]
        : [];
    }));
    for (let index = start - 1; index >= 0 && pendingToolUseIds.size > 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        const candidate = block as { type?: string; id?: string };
        if (candidate.type === 'tool_use' && candidate.id && pendingToolUseIds.delete(candidate.id)) {
          start = index;
        }
      }
    }
    if (pendingToolUseIds.size > 0) return undefined;
  }
  const prefix = messages.slice(0, start);
  if (prefix.length < 2) return undefined;
  return { prefix, latest: messages.slice(start) };
}

/** Factory for the ReAct driver's swappable strategies, resolved per run by the composition root. */
export const conversationExtensionsFactoryKey = defineContributionServiceKey<
  () => Required<ConversationExtensionPoints>
>('hadamard.conversationExtensions');

/** Built-in contribution: registers the behavior-preserving extension factory on the runtime contribution host. */
export function createBuiltInConversationExtensionsContribution(): HadamardRuntimeContribution {
  return {
    id: 'hadamard.conversation-extensions',
    async apply(ctx: ContributionApplyContext) {
      ctx.services.register(conversationExtensionsFactoryKey, createBuiltInConversationExtensions);
      return () => { ctx.services.unregister(conversationExtensionsFactoryKey); };
    },
  };
}

/** Default extensions preserving the current built-in behavior byte-for-byte. */
export function createBuiltInConversationExtensions(): Required<ConversationExtensionPoints> {
  const repeatGuard = new RepeatCallGuard();
  let iterationsSinceTodoWrite = 0;
  return {
    autoCompact: (messages, context) => compactHadamardConversationIfNeeded(messages, context),
    async requestError(context) {
      if (
        isRetryableStreamInterruption(context.error)
        && context.streamInterruptionRetries < MAX_STREAM_INTERRUPTION_RETRIES
      ) {
        const retryCount = context.streamInterruptionRetries + 1;
        return {
          action: 'stream-retry',
          retryCount,
          maxRetries: MAX_STREAM_INTERRUPTION_RETRIES,
          backoffMs: streamInterruptionBackoffMs(retryCount),
        };
      }
      if (isHadamardPromptTooLongError(context.error) && !context.reactiveCompactAttempted) {
        const compactContext = {
          model: context.model,
          modelApi: context.modelApi,
          compactConfig: context.compactConfig,
          systemPrompt: context.systemPrompt,
          tools: context.tools,
          maxTokens: context.maxTokens,
          compactWindowPrefixTokens: context.compactWindowPrefixTokens,
          runKey: context.runKey,
          signal: context.signal,
          force: true,
        } as const;
        let outcome = await compactHadamardConversationIfNeeded(
          context.conversation,
          compactContext,
        );
        if (!outcome.compacted) {
          // A rejected request can leave the newest user/tool-result segment
          // too large for the summarizer's own request. Retry once without
          // that pairing-safe segment, then append it verbatim after the new
          // summary so no user information is lost.
          const split = splitLatestPairingSafeSegment(context.conversation);
          if (split) {
            const prefixOutcome = await compactHadamardConversationIfNeeded(split.prefix, {
              ...compactContext,
              runKey: `${context.runKey}:without-latest`,
            });
            if (prefixOutcome.compacted) {
              const messages = [...prefixOutcome.messages, ...split.latest];
              outcome = {
                ...prefixOutcome,
                messages,
                tokenEstimateBefore: estimateHadamardConversationTokens(context.conversation),
                tokenEstimateAfter: estimateHadamardConversationTokens(messages),
                preservedMessages: prefixOutcome.preservedMessages + split.latest.length,
              };
            }
          }
        }
        if (outcome.compacted) {
          return { action: 'reactive-compact', outcome, compactAttempted: true };
        }
        if (
          context.fallbackModel
          && !context.modelFallbackUsed
          && context.fallbackModel !== context.model
          && isModelFallbackEligibleError(context.error)
        ) {
          return { action: 'fallback-model', toModel: context.fallbackModel, compactAttempted: true };
        }
        return { action: 'rethrow', compactAttempted: true };
      }
      if (
        context.fallbackModel
        && !context.modelFallbackUsed
        && context.fallbackModel !== context.model
        && isModelFallbackEligibleError(context.error)
      ) {
        return { action: 'fallback-model', toModel: context.fallbackModel };
      }
      return { action: 'rethrow' };
    },
    repeatCall: {
      record: (toolName, input, isError) => repeatGuard.record(toolName, input, isError),
    },
    todoReminder: {
      observe({ toolUseNames, todoToolAvailable, sessionKey }) {
        if (toolUseNames.includes(TODO_WRITE_TOOL_NAME)) {
          iterationsSinceTodoWrite = 0;
          return undefined;
        }
        iterationsSinceTodoWrite += 1;
        if (todoToolAvailable && iterationsSinceTodoWrite >= TODO_REMINDER_INTERVAL) {
          const reminder = buildTodoReminderText(getHadamardTodoSnapshot(sessionKey));
          iterationsSinceTodoWrite = 0;
          return reminder;
        }
        return undefined;
      },
    },
  };
}
