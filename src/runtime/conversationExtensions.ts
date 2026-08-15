import type { ConversationExtensionPoints } from '../types.js';
import {
  compactHadamardConversationIfNeeded,
  isHadamardPromptTooLongError,
} from './hadamardCompact.js';
import { RepeatCallGuard } from './repeatCallGuard.js';
import { buildTodoReminderText } from './conversationToolBatch.js';
import { getHadamardTodoSnapshot, TODO_WRITE_TOOL_NAME } from '../tools/todo/TodoWriteTool.js';
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
        const outcome = await compactHadamardConversationIfNeeded(context.conversation, {
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
        });
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

