import type { MessageParam } from '../provider/types.js';
import type { ModelApi } from '../types.js';
import {
  compactHadamardConversationIfNeeded,
  isHadamardPromptTooLongError,
} from './hadamardCompact.js';
import type { HadamardLoopCompactContext, HadamardLoopCompactOutcome } from './hadamardCompact.js';
import { RepeatCallGuard } from './repeatCallGuard.js';
import type { RepeatCallRecord } from './repeatCallGuard.js';
import { buildTodoReminderText } from './conversationToolBatch.js';
import { getHadamardTodoSnapshot, TODO_WRITE_TOOL_NAME } from '../tools/todo/TodoWriteTool.js';
import {
  MAX_STREAM_INTERRUPTION_RETRIES,
  isModelFallbackEligibleError,
  isRetryableStreamInterruption,
  streamInterruptionBackoffMs,
} from './modelRequestPolicy.js';
import type { ExecuteConversationOptions } from './conversationPorts.js';
import { defineContributionServiceKey } from '../contrib/contributionHost.js';
import type { ContributionApplyContext, HadamardRuntimeContribution } from '../contrib/contributionHost.js';

/**
 * Typed extension points that thin the ReAct driver: compaction, request-
 * error strategy, repeat-call guard, and the todo reminder are swappable
 * strategies consumed by executeConversation. The driver keeps the state
 * machine, request assembly, tool scheduling, pairing, safety, and abort
 * invariants; these seams only decide what the driver should do next. The
 * built-in factory preserves the exact current behavior and doubles as the
 * default contribution registered in the runtime contribution host.
 *
 * @module src/runtime/conversationExtensions
 */

export type AutoCompactExtension = (
  messages: MessageParam[],
  context: HadamardLoopCompactContext,
) => Promise<HadamardLoopCompactOutcome>;

export interface RequestErrorContext {
  error: unknown;
  model: string;
  fallbackModel?: string;
  modelFallbackUsed: boolean;
  streamInterruptionRetries: number;
  reactiveCompactAttempted: boolean;
  modelApi: ModelApi;
  conversation: MessageParam[];
  compactConfig: ExecuteConversationOptions['config']['compact'];
  systemPrompt: string | undefined;
  tools: unknown[];
  maxTokens: number;
  compactWindowPrefixTokens: number;
  runKey: string;
  signal?: AbortSignal;
}

export type RequestErrorDecision =
  | { action: 'stream-retry'; retryCount: number; maxRetries: number; backoffMs: number }
  | { action: 'reactive-compact'; outcome: HadamardLoopCompactOutcome; compactAttempted: true }
  | { action: 'fallback-model'; toModel: string; compactAttempted?: boolean }
  | { action: 'rethrow'; compactAttempted?: boolean };

export type RequestErrorExtension = (context: RequestErrorContext) => Promise<RequestErrorDecision>;

export interface ConversationRepeatExtension {
  record(toolName: string, input: unknown, isError: boolean): RepeatCallRecord;
}

export interface ConversationTodoObservation {
  toolUseNames: readonly string[];
  todoToolAvailable: boolean;
  sessionKey: string;
}

export interface ConversationTodoReminderExtension {
  /** Returns the reminder to append to the last tool result, or undefined. */
  observe(observation: ConversationTodoObservation): string | undefined;
}

export interface ConversationExtensionPoints {
  autoCompact?: AutoCompactExtension;
  requestError?: RequestErrorExtension;
  repeatCall?: ConversationRepeatExtension;
  todoReminder?: ConversationTodoReminderExtension;
}

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

