import { describe, expect, it, vi } from 'vitest';

import { AgentSessionsApi } from '../src/runtime/agentSessionsApi.js';
import type { AgentSession } from '../src/runtime/agentSession.js';
import type { SessionManager } from '../src/runtime/sessionManager.js';
import type { SessionStore } from '../src/storage/sessionStore.js';
import type { SessionSummary } from '../src/types.js';

function summary(id: string, kind: SessionSummary['kind'], status: SessionSummary['status']): SessionSummary {
  return { id, kind, status } as SessionSummary;
}

describe('AgentSessionsApi', () => {
  it('depends only on list/delete and resume session ports', async () => {
    const store = {
      list: vi.fn(async () => [
        summary('manager-latest', 'manager', 'active'),
        summary('chat-open', 'main', 'idle'),
        summary('chat-closed', 'main', 'closed'),
      ]),
      delete: vi.fn(async () => undefined),
    };
    const resumed = { id: 'chat-open' } as AgentSession;
    const resume = vi.fn(async () => resumed);
    const api = new AgentSessionsApi(store as unknown as SessionStore, resume);

    await expect(api.continueMostRecent()).resolves.toBe(resumed);
    expect(resume).toHaveBeenCalledWith('chat-open', {});
    await api.delete('chat-closed');
    expect(store.delete).toHaveBeenCalledWith('chat-closed');
  });

  it('delegates lifecycle statistics to an optional manager port', async () => {
    const manager = {
      getStats: vi.fn(async () => ({ total: 2, active: 1, idle: 1, closed: 0 })),
      prune: vi.fn(async () => 1),
      closeIdle: vi.fn(async () => 1),
    };
    const api = new AgentSessionsApi(
      { list: async () => [], delete: async () => undefined } as unknown as SessionStore,
      async () => ({}) as AgentSession,
      manager as unknown as SessionManager,
    );

    await expect(api.stats()).resolves.toEqual({ total: 2, active: 1, idle: 1, closed: 0 });
    await expect(api.prune({ status: 'closed' })).resolves.toBe(1);
    await expect(api.closeIdle()).resolves.toBe(1);
    expect(manager.prune).toHaveBeenCalledWith({ status: 'closed' });
  });

  it('fails manager-only operations when no manager is configured', async () => {
    const api = new AgentSessionsApi(
      { list: async () => [], delete: async () => undefined } as unknown as SessionStore,
      async () => ({}) as AgentSession,
    );
    await expect(api.stats()).rejects.toThrow('SessionManager is not configured');
  });
});
