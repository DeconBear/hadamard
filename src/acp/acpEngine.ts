import type { HadamardAgentClient } from '../runtime/agentClient.js';
import type { AgentSession } from '../runtime/agentSession.js';
import type { AgentEvent, HadamardPermissionMode } from '../types.js';
import {
  isAbortLikeError,
  mapAgentEventToAcpUpdates,
  mapRunResultToStopReason,
} from './acpEventMapper.js';
import { createAcpToolApprover, type AcpClientChannel } from './acpPermissionBridge.js';
import type { AcpSessionUpdateBody, AcpStopReason, AcpTextContentBlock } from './acpProtocol.js';

/** Terminal outcome of one ACP prompt turn, regardless of engine. */
export interface AcpEngineRunResult {
  stopReason: AcpStopReason;
}

/** One in-flight prompt execution behind an engine-neutral handle. */
export interface AcpRunHandle {
  /** Mapped session/update bodies in emission order. */
  readonly events: AsyncIterable<AcpSessionUpdateBody>;
  /** Terminal turn state; rejects only for run failures (never for cancel). */
  readonly result: Promise<AcpEngineRunResult>;
  cancel(reason?: string): void;
}

export interface AcpEngineSession {
  readonly id: string;
  run(prompt: AcpTextContentBlock[], channel: AcpClientChannel): AcpRunHandle;
}

/**
 * Execution backend behind the ACP server. `clean` runs the in-process
 * Hadamard SDK; `bridge:<runtime>` drives an external CLI runtime through the
 * Hadamard compatibility bridge (see src/acp/acpBridgeEngine.ts).
 */
export interface AcpRuntimeEngine {
  readonly engineId: string;
  createSession(cwd: string): Promise<AcpEngineSession>;
  close(): Promise<void>;
}

export interface CleanAcpEngineOptions {
  model?: string;
  permissionMode?: HadamardPermissionMode;
}

/** Clean engine: in-process Hadamard SDK sessions with ACP permission bridging. */
export class CleanAcpEngine implements AcpRuntimeEngine {
  readonly engineId = 'clean';

  constructor(
    private readonly sdk: HadamardAgentClient,
    private readonly options: CleanAcpEngineOptions = {},
  ) {}

  async createSession(cwd: string): Promise<AcpEngineSession> {
    const session = await this.sdk.createSession({
      model: this.options.model,
      permissionMode: this.options.permissionMode,
      originalWorkDir: cwd,
    });
    return new CleanAcpEngineSession(session);
  }

  async close(): Promise<void> {
    await this.sdk.close();
  }
}

class CleanAcpEngineSession implements AcpEngineSession {
  constructor(private readonly session: AgentSession) {}

  get id(): string {
    return this.session.id;
  }

  run(prompt: AcpTextContentBlock[], channel: AcpClientChannel): AcpRunHandle {
    const content = prompt.map(block => ({ type: 'text' as const, text: block.text }));
    const stream = this.session.stream(content, {
      approver: createAcpToolApprover({ channel, sessionId: this.session.id }),
    });
    const events = mapCleanEvents(stream);
    const result = (async (): Promise<AcpEngineRunResult> => {
      try {
        return { stopReason: mapRunResultToStopReason(await stream.result) };
      } catch (error) {
        // A cancelled turn resolves as stopReason cancelled, never an error.
        if (stream.isCancelled || isAbortLikeError(error)) return { stopReason: 'cancelled' };
        throw error;
      }
    })();
    // Mark the rejection as handled; the server still awaits `result` itself.
    void result.catch(() => undefined);
    return {
      events,
      result,
      cancel: reason => stream.cancel(reason),
    };
  }
}

async function* mapCleanEvents(stream: AsyncIterable<AgentEvent>): AsyncIterable<AcpSessionUpdateBody> {
  for await (const event of stream) {
    yield* mapAgentEventToAcpUpdates(event);
  }
}
