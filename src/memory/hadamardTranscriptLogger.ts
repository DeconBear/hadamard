import { randomUUID } from 'node:crypto';
import { mkdir, appendFile } from 'node:fs/promises';
import type { MessageParam } from '../provider/types.js';
import type { TrajectoryEvent } from '../runtime/trajectoryEvents.js';
import { joinUnderStorageRoot, safeStorageFileName } from '../storage/pathSafety.js';

export interface TranscriptEntry {
  type: 'user' | 'assistant';
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  sessionId: string;
  cwd: string;
  message: { role: string; content: unknown };
}

export async function appendMessagesToTranscript(
  transcriptDir: string,
  sessionId: string,
  cwd: string,
  messages: MessageParam[],
  parentUuid: string | null = null,
): Promise<void> {
  await mkdir(transcriptDir, { recursive: true });
  const transcriptPath = joinUnderStorageRoot(
    transcriptDir,
    safeStorageFileName('sessionId', sessionId, 'jsonl'),
  );

  const lines: string[] = [];
  let lastUuid = parentUuid;

  for (const message of messages) {
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') {
      continue;
    }

    const uuid = randomUUID();
    lines.push(
      JSON.stringify({
        type: role,
        uuid,
        parentUuid: lastUuid,
        timestamp: new Date().toISOString(),
        sessionId,
        cwd,
        message: { role, content: message.content },
      }) + '\n',
    );
    lastUuid = uuid;
  }

  if (lines.length > 0) {
    await appendFile(transcriptPath, lines.join(''));
  }
}

/**
 * Append structured trajectory events to a session-scoped events JSONL next
 * to the raw transcript. Append-only: each line is one event with a stable
 * uuid chain mirroring the transcript's provenance pattern.
 */
export async function appendTrajectoryEvents(
  transcriptDir: string,
  sessionId: string,
  cwd: string,
  events: TrajectoryEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await mkdir(transcriptDir, { recursive: true });
  const eventsPath = joinUnderStorageRoot(
    transcriptDir,
    safeStorageFileName('sessionId', sessionId, 'events.jsonl'),
  );
  const lines = events.map(event =>
    JSON.stringify({
      type: 'event',
      uuid: randomUUID(),
      timestamp: event.timestamp,
      sessionId,
      cwd,
      event,
    }) + '\n',
  );
  await appendFile(eventsPath, lines.join(''));
}
