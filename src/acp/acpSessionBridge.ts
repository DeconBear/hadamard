import { isAbsolute } from 'node:path';

import type { AgentSession } from '../runtime/agentSession.js';
import type { AgentRunStream } from '../runtime/asyncQueue.js';
import type { HadamardAgentClient } from '../runtime/agentClient.js';
import type { HadamardPermissionMode } from '../types.js';
import { ACP_ERROR_INVALID_PARAMS, AcpProtocolError } from './acpProtocol.js';

export interface AcpSessionHandle {
  readonly id: string;
  readonly session: AgentSession;
  /** In-flight run, set while session/prompt is being served. */
  activeStream?: AgentRunStream;
}

export interface AcpSessionBridgeOptions {
  model?: string;
  permissionMode?: HadamardPermissionMode;
}

/**
 * Registry mapping ACP session ids to Hadamard AgentSessions. First-version
 * semantics are one process per client with fresh, non-resumable sessions.
 */
export class AcpSessionBridge {
  private readonly sessions = new Map<string, AcpSessionHandle>();

  constructor(
    private readonly sdk: HadamardAgentClient,
    private readonly options: AcpSessionBridgeOptions = {},
  ) {}

  async create(cwd: string): Promise<AcpSessionHandle> {
    // ACP requires an absolute cwd; fail closed before touching the SDK.
    if (!isAbsolute(cwd)) {
      throw new AcpProtocolError(
        ACP_ERROR_INVALID_PARAMS,
        `session/new.cwd must be an absolute path; got "${cwd}".`,
      );
    }
    const session = await this.sdk.createSession({
      model: this.options.model,
      permissionMode: this.options.permissionMode,
      originalWorkDir: cwd,
    });
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
    if (!handle?.activeStream || handle.activeStream.isCancelled) return false;
    handle.activeStream.cancel(reason ?? 'ACP session/cancel');
    return true;
  }

  /** Cancel every in-flight run; used on transport teardown before sdk.close(). */
  cancelAll(reason: string): void {
    for (const handle of this.sessions.values()) {
      if (handle.activeStream && !handle.activeStream.isCancelled) {
        handle.activeStream.cancel(reason);
      }
    }
  }
}
