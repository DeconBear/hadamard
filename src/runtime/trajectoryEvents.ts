import type { Usage } from '../provider/types.js';

/**
 * Structured append-only trajectory events: a compact event-sourced view of
 * one agent run (the dsh session-log pattern at reduced scope). Every event
 * carries a monotonic per-run seq; the message-level transcript remains the
 * provider-facing source of truth and stays append-only.
 *
 * @module src/runtime/trajectoryEvents
 */

export type TrajectoryEvent =
  | { type: 'run.started'; seq: number; timestamp: string; runId: string; sessionId?: string; model: string }
  | { type: 'request.started'; seq: number; timestamp: string; runId: string; iteration: number; model: string; requestTokenEstimate: number }
  | { type: 'assistant.message'; seq: number; timestamp: string; runId: string; iteration: number; messageId: string; stopReason: string | null; usage?: Usage }
  | { type: 'tool.call'; seq: number; timestamp: string; runId: string; iteration: number; toolUseId: string; name: string; abortedBeforeDispatch?: boolean }
  | { type: 'tool.result'; seq: number; timestamp: string; runId: string; iteration: number; toolUseId: string; name: string; isError: boolean }
  | { type: 'conversation.compacted'; seq: number; timestamp: string; runId: string; iteration: number; trigger: 'auto' | 'reactive' | 'prune'; messagesSummarized: number; shadowedTokenCount?: number }
  | { type: 'run.completed'; seq: number; timestamp: string; runId: string; stopReason: string | null; incompleteReason?: string };

/** Distributive omit: keeps every variant's own fields (plain Omit collapses a union to its common keys). */
export type TrajectoryEventPayload = TrajectoryEvent extends infer T
  ? T extends TrajectoryEvent
    ? Omit<T, 'seq' | 'timestamp'>
    : never
  : never;
