import {
  ACP_ERROR_METHOD_NOT_FOUND,
  ACP_PROTOCOL_VERSION,
  AcpProtocolError,
  acpErrorFromException,
  acpResult,
  parseCancelParams,
  parseInitializeParams,
  parseNewSessionParams,
  parsePromptParams,
  type AcpInitializeResult,
  type AcpNotificationMessage,
  type AcpPromptResult,
  type AcpRequestMessage,
  type AcpServerResponse,
} from './acpProtocol.js';
import type { AcpRuntimeEngine } from './acpEngine.js';
import type { AcpClientChannel } from './acpPermissionBridge.js';
import { AcpSessionBridge } from './acpSessionBridge.js';

export interface AcpServerOptions {
  engine: AcpRuntimeEngine;
  agentName?: string;
  agentVersion?: string;
}

/**
 * ACP v1 method dispatch and lifecycle. One server instance serves one
 * client connection; sessions live in the bridge and prompts serialize per
 * session inside the engine runtime, so the transport may dispatch messages
 * concurrently.
 */
export class AcpServer {
  private readonly sessions: AcpSessionBridge;

  constructor(private readonly options: AcpServerOptions) {
    this.sessions = new AcpSessionBridge(options.engine);
  }

  /** Handle a client request; always resolves to a JSON-RPC response. */
  async handleRequest(request: AcpRequestMessage, channel: AcpClientChannel): Promise<AcpServerResponse> {
    try {
      const result = await this.dispatch(request.method, request.params, channel);
      return acpResult(request.id, result ?? {});
    } catch (error) {
      return acpErrorFromException(request.id, error);
    }
  }

  /** Handle a client notification (session/cancel). Never throws. */
  async handleNotification(notification: AcpNotificationMessage): Promise<void> {
    if (notification.method === 'session/cancel') {
      const params = parseCancelParams(notification.params);
      this.sessions.cancel(params.sessionId);
    }
    // Unknown notifications are ignored per JSON-RPC convention.
  }

  /** Cancel all in-flight runs; called by the transport on teardown. */
  shutdown(reason: string): void {
    this.sessions.cancelAll(reason);
  }

  private async dispatch(method: string, params: unknown, channel: AcpClientChannel): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params);
      case 'session/new':
        return this.newSession(params);
      case 'session/prompt':
        return this.prompt(params, channel);
      case 'authenticate':
        // authMethods is empty; there is nothing to authenticate.
        return {};
      default:
        throw new AcpProtocolError(ACP_ERROR_METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  private initialize(params: unknown): AcpInitializeResult {
    const parsed = parseInitializeParams(params);
    return {
      protocolVersion: Math.min(parsed.protocolVersion, ACP_PROTOCOL_VERSION),
      agentCapabilities: {
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        loadSession: false,
      },
      agentInfo: {
        name: this.options.agentName ?? 'hadamard-acp',
        version: this.options.agentVersion ?? '0.0.0',
        title: 'Hadamard Agent Runtime',
      },
      authMethods: [],
      // Identity marking: report the actual execution engine so clients can
      // never mistake a bridge run for a Clean SDK run.
      _meta: { hadamardEngine: this.options.engine.engineId },
    };
  }

  private async newSession(params: unknown): Promise<{ sessionId: string }> {
    const parsed = parseNewSessionParams(params);
    const handle = await this.sessions.create(parsed.cwd);
    return { sessionId: handle.id };
  }

  private async prompt(params: unknown, channel: AcpClientChannel): Promise<AcpPromptResult> {
    const parsed = parsePromptParams(params);
    const handle = this.sessions.get(parsed.sessionId);
    const run = handle.session.run(parsed.prompt, channel);
    handle.activeRun = run;
    try {
      try {
        for await (const update of run.events) {
          channel.notify('session/update', { sessionId: handle.id, update });
        }
      } catch {
        // The terminal state (including cancel and failure) is carried by
        // run.result below; a failed event stream must not mask it.
      }
      return await run.result;
    } finally {
      handle.activeRun = undefined;
    }
  }
}
