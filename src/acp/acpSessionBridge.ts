import { isAbsolute } from 'node:path';

import type { AcpEngineSession, AcpRunHandle, AcpRuntimeEngine } from './acpEngine.js';
import { ACP_ERROR_INVALID_PARAMS, AcpProtocolError } from './acpProtocol.js';

export interface AcpSessionHandle {
  readonly id: string;
  readonly session: AcpEngineSession;
  /** In-flight run, set while session/prompt is being served. */
  activeRun?: AcpRunHandle;
}

/**
 * Registry mapping ACP session ids to engine sessions. First-version
 * semantics are one process per client with fresh, non-resumable sessions.
 */
export class AcpSessionBridge {
  private readonly sessions = new Map<string, AcpSessionHandle>();

  constructor(private readonly engine: AcpRuntimeEngine) {}

  async create(cwd: string): Promise<AcpSessionHandle> {
    // ACP requires an absolute cwd; fail closed before touching the engine.
    if (!isAbsolute(cwd)) {
      throw new AcpProtocolError(
        ACP_ERROR_INVALID_PARAMS,
        `session/new.cwd must be an absolute path; got "${cwd}".`,
      );
    }
    const session = await this.engine.createSession(cwd);
    const handle: AcpSessionHandle = { id: session.id, session };
    this.sessions.set(handle.id, handle);
    return handle;
  }

  get(sessionId: string): AcpSessionHandle {
    const handle = this.sessions.get(sessionId);
    if (!handle) {
      throw new AcpProtocolError(ACP_ERROR_INVALID_PARAMS, `Unknown sessionId: ${sessionId}.`);
    }
    return handle;
  }

  /** Cancel the in-flight run of a session. Returns false when idle — cancel is idempotent. */
  cancel(sessionId: string, reason?: string): boolean {
    const handle = this.sessions.get(sessionId);
    if (!handle?.activeRun) return false;
    handle.activeRun.cancel(reason ?? 'ACP session/cancel');
    return true;
  }

  /** Cancel every in-flight run; used on transport teardown before engine close. */
  cancelAll(reason: string): void {
    for (const handle of this.sessions.values()) {
      handle.activeRun?.cancel(reason);
    }
  }
}
