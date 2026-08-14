import type { SessionSummary, StoredSession } from '../types.js';

export function isUserChatSession(session: Pick<SessionSummary, 'kind'>): boolean {
  return session.kind !== 'manager' && session.kind !== 'agent';
}

/** No conversation or run exists that could be meaningfully resumed. */
export function isEmptyUserSessionSummary(
  session: Pick<SessionSummary, 'kind' | 'messageCount' | 'runCount'>,
): boolean {
  return isUserChatSession(session) && session.messageCount === 0 && session.runCount === 0;
}

export function isEmptyUserStoredSession(
  session: Pick<StoredSession, 'kind' | 'messages' | 'runs'>,
): boolean {
  return isUserChatSession(session) && session.messages.length === 0 && session.runs.length === 0;
}
