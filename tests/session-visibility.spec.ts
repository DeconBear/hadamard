import { describe, expect, it } from 'vitest';

import {
  isEmptyUserSessionSummary,
  isEmptyUserStoredSession,
} from '../src/storage/sessionVisibility.js';

describe('empty user Session visibility', () => {
  it('treats only zero-message zero-run user chats as empty', () => {
    const base = { kind: 'main' as const, messageCount: 0, runCount: 0 };
    expect(isEmptyUserSessionSummary(base)).toBe(true);
    expect(isEmptyUserSessionSummary({ ...base, messageCount: 1 })).toBe(false);
    expect(isEmptyUserSessionSummary({ ...base, runCount: 1 })).toBe(false);
    expect(isEmptyUserSessionSummary({ ...base, kind: 'manager' })).toBe(false);
    expect(isEmptyUserSessionSummary({ ...base, kind: 'agent' })).toBe(false);
  });

  it('uses the same boundary for hydrated Sessions', () => {
    expect(isEmptyUserStoredSession({ kind: 'main', messages: [], runs: [] })).toBe(true);
    expect(isEmptyUserStoredSession({
      kind: 'main',
      messages: [],
      runs: [{} as never],
    })).toBe(false);
  });
});
