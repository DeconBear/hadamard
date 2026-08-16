/**
 * Durable transcript formatter for CodeAct sub-dispatch audit records
 * (dsh tools/code-dispatch-log shape, Hadamard-owned): the composition
 * root renders each settled/started sub-dispatch into the raw transcript;
 * a contribution may replace the default formatter (e.g. a spill policy
 * that bounds the log copy) without touching the program value or the
 * model-visible history.
 *
 * @module src/runtime/codeDispatchTranscript
 */
import type { ToolCodeDispatchEvent } from '../events/codeActEvents.js';
import { defineContributionServiceKey } from '../contrib/contributionHost.js';
import type { ContributionApplyContext, HadamardRuntimeContribution } from '../contrib/contributionHost.js';

export interface CodeDispatchTranscriptPayload {
  runId: string;
  iteration: number;
  event: ToolCodeDispatchEvent;
}

export type CodeDispatchTranscriptFormatter = (payload: CodeDispatchTranscriptPayload) => string;

export const codeDispatchFormatterKey = defineContributionServiceKey<CodeDispatchTranscriptFormatter>('hadamard.codeDispatchLog');

export function defaultCodeDispatchTranscriptFormatter(payload: CodeDispatchTranscriptPayload): string {
  const event = payload.event;
  return JSON.stringify({
    kind: 'code-dispatch',
    rootCallId: event.rootCallId,
    subCallId: event.subCallId,
    name: event.name,
    phase: event.phase,
    isError: event.isError ?? false,
    ...(event.summary !== undefined ? { summary: event.summary } : {}),
    timestamp: event.timestamp,
  });
}

/** Built-in contribution: registers the default transcript formatter. */
export function createCodeDispatchTranscriptContribution(): HadamardRuntimeContribution {
  return {
    id: 'hadamard.code-dispatch-transcript',
    async apply(ctx: ContributionApplyContext) {
      ctx.services.register(codeDispatchFormatterKey, defaultCodeDispatchTranscriptFormatter);
      return () => { ctx.services.unregister(codeDispatchFormatterKey); };
    },
  };
}
