import { createHash } from 'node:crypto';

import type { MessageParam } from '../provider/types.js';
import { deepClone } from './helpers.js';
import type { TrajectoryEvent } from './trajectoryEvents.js';

/**
 * Durable surface projection: rebuilds the model-visible message sequence
 * from the append-only trajectory log (dsh deriveMessages-from-session-log
 * pattern). The message transcript stays the provider-facing source of truth;
 * the trajectory's conversation.append/replaced events carry the same bytes
 * so any persisted run can be replayed and verified byte-for-byte.
 *
 * @module src/runtime/surfaceProjection
 */

export interface RequestHeaderFingerprint {
  systemHash: string;
  toolsHash: string;
  headerKey: string;
}

function shortHash(serialized: string, length: number): string {
  return createHash('sha256').update(serialized).digest('hex').slice(0, length);
}

/** Wire annotations (cache_control) are transport noise, not header content: drop them before hashing. */
function serializeToolsForFingerprint(tools: unknown[] | undefined): string {
  if (!tools) return JSON.stringify(null);
  return JSON.stringify(tools.map((tool) => {
    if (typeof tool !== 'object' || tool === null) return tool;
    const normalized = { ...(tool as Record<string, unknown>) };
    delete normalized.cache_control;
    return normalized;
  }));
}

/** Fingerprint the fixed (non-message) part of a request so a rebuilt request can be verified. */
export function fingerprintRequestHeader(system: unknown, tools: unknown[] | undefined): RequestHeaderFingerprint {
  const systemSerialized = JSON.stringify(system ?? null);
  const toolsSerialized = serializeToolsForFingerprint(tools);
  return {
    systemHash: shortHash(systemSerialized, 16),
    toolsHash: shortHash(toolsSerialized, 16),
    headerKey: shortHash(JSON.stringify({ system: systemSerialized, tools: toolsSerialized }), 24),
  };
}

export function headerFingerprintMatches(
  fingerprint: RequestHeaderFingerprint,
  system: unknown,
  tools: unknown[] | undefined,
): boolean {
  const rebuilt = fingerprintRequestHeader(system, tools);
  return rebuilt.headerKey === fingerprint.headerKey
    && rebuilt.systemHash === fingerprint.systemHash
    && rebuilt.toolsHash === fingerprint.toolsHash;
}

/**
 * Replay the durable surface: append events push messages, replaced events
 * atomically substitute the whole history (compaction/restore). The result is
 * byte-equivalent to what the engine sent at the same point in the run.
 */
export function projectModelSurfaceFromTrajectory(events: readonly TrajectoryEvent[]): MessageParam[] {
  const messages: MessageParam[] = [];
  for (const event of events) {
    if (event.type === 'conversation.append') {
      messages.push(deepClone(event.message));
    } else if (event.type === 'conversation.replaced') {
      messages.splice(0, messages.length, ...deepClone(event.messages));
    }
  }
  return messages;
}

/** Project the surface as of a given event seq (inclusive), for step-level verification. */
export function projectModelSurfaceThrough(events: readonly TrajectoryEvent[], throughSeq: number): MessageParam[] {
  return projectModelSurfaceFromTrajectory(events.filter((event) => event.seq <= throughSeq));
}

/** One persisted trajectory line: the envelope appendTrajectoryEvents writes. */
export interface PersistedTrajectoryEnvelope {
  type: 'event';
  uuid: string;
  timestamp: string;
  sessionId: string;
  cwd: string;
  event: TrajectoryEvent;
}

/**
 * Parse persisted trajectory lines into the raw event list. Torn tail writes
 * are skipped so the readable prefix stays replayable; sessions recorded
 * before the surface envelope produce an empty (transcript-fallback) replay.
 */
export function parseTrajectoryEnvelopes(lines: readonly string[]): TrajectoryEvent[] {
  const events: TrajectoryEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<PersistedTrajectoryEnvelope>;
      if (parsed.type === 'event' && parsed.event && typeof parsed.event.type === 'string') {
        events.push(parsed.event as TrajectoryEvent);
      }
    } catch {
      // Ignore a torn tail line; the prefix remains authoritative.
    }
  }
  return events;
}

