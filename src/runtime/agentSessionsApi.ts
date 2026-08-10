import type {
  SessionResumeOptions,
  SessionSummary,
} from '../types.js';
import type { SessionStore } from '../storage/sessionStore.js';
import type { AgentSession } from './agentSession.js';

interface AgentSessionsStorePort {
  list(): Promise<SessionSummary[]>;
  delete(sessionId: string): Promise<void>;
}

interface AgentSessionsManagerPort {
  getStats(): Promise<import('../types.js').SessionStats>;
  prune(params?: import('../types.js').SessionPruneParams): Promise<number>;
  closeIdle(): Promise<number>;
}

export class AgentSessionsApi {
  private readonly store: AgentSessionsStorePort;
  private readonly resumeSession: (
    sessionId: string,
    options?: SessionResumeOptions,
  ) => Promise<AgentSession>;
  private readonly manager?: AgentSessionsManagerPort;

  constructor(
    store: SessionStore,
    resumeSession: (
      sessionId: string,
      options?: SessionResumeOptions,
    ) => Promise<AgentSession>,
    manager?: import('./sessionManager.js').SessionManager | undefined,
  );
  constructor(
    store: SessionStore,
    resumeSession: (
      sessionId: string,
      options?: SessionResumeOptions,
    ) => Promise<AgentSession>,
    manager?: import('./sessionManager.js').SessionManager,
  ) {
    this.store = store;
    this.resumeSession = resumeSession;
    this.manager = manager;
  }

  list(): Promise<SessionSummary[]> {
    return this.store.list();
  }

  get(sessionId: string): Promise<AgentSession> {
    return this.resumeSession(sessionId);
  }

  resume(sessionId: string, options: SessionResumeOptions = {}): Promise<AgentSession> {
    return this.resumeSession(sessionId, options);
  }

  async continueMostRecent(options: SessionResumeOptions = {}): Promise<AgentSession> {
    const sessions = await this.store.list();
    const chatSessions = sessions.filter(session => session.kind !== 'manager');
    const mostRecent = chatSessions.find(session => session.status !== 'closed') ?? chatSessions[0];
    if (!mostRecent) throw new Error('No stored sessions are available to resume.');
    return this.resumeSession(mostRecent.id, options);
  }

  delete(sessionId: string): Promise<void> {
    return this.store.delete(sessionId);
  }

  async stats(): Promise<import('../types.js').SessionStats> {
    if (!this.manager) throw new Error('SessionManager is not configured');
    return this.manager.getStats();
  }

  async prune(params?: import('../types.js').SessionPruneParams): Promise<number> {
    if (!this.manager) throw new Error('SessionManager is not configured');
    return this.manager.prune(params);
  }

  async closeIdle(): Promise<number> {
    if (!this.manager) throw new Error('SessionManager is not configured');
    return this.manager.closeIdle();
  }
}
