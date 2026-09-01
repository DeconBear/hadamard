import type { HadamardBridgeSdkClient, HadamardBridgeSession } from '../parity/hadamardBridgeSdk.js';
import { createHadamardBridgeSdk } from '../parity/hadamardBridgeSdk.js';
import type {
  HadamardBridgePermissionMode,
  HadamardBridgeRunResult,
  HadamardPermissionMode,
  RuntimeProviderId,
} from '../types.js';
import {
  isAbortLikeError,
  mapBridgeJsonEventToAcpUpdates,
  mapBridgeRunResultToStopReason,
} from './acpEventMapper.js';
import type {
  AcpEngineRunResult,
  AcpEngineSession,
  AcpRunHandle,
  AcpRunMeta,
  AcpRuntimeEngine,
} from './acpEngine.js';
import type { AcpSessionUpdateBody, AcpTextContentBlock } from './acpProtocol.js';

export const ACP_BRIDGE_RUNTIMES: readonly RuntimeProviderId[] = [
  'claude', 'codex', 'pi', 'codewhale', 'reasonix', 'crush', 'cursor',
];

export interface BridgeAcpEngineOptions {
  runtime: RuntimeProviderId;
  workDir: string;
  model?: string;
  permissionMode?: HadamardPermissionMode;
}

/** Permission modes the external CLI bridge understands. */
const BRIDGE_PERMISSION_MODES: readonly HadamardBridgePermissionMode[] = [
  'default', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'plan',
];

/**
 * Bridge engine: run an external agent CLI (Claude Code, Codex, …) through
 * the Hadamard compatibility bridge. Authentication always reuses the CLI's
 * own native login (`authSource: 'native'`) — credentials are never read,
 * copied, or mapped through the ACP layer.
 *
 * External CLIs run headless and cannot answer ACP session/request_permission
 * prompts, so no approver bridge is installed; permission enforcement stays
 * with the CLI's own mode (forwarded when compatible).
 */
export class BridgeAcpEngine implements AcpRuntimeEngine {
  readonly engineId: string;

  /**
   * Public for dependency injection in tests; production code should prefer
   * {@link BridgeAcpEngine.create}, which validates runtime availability.
   */
  constructor(
    private readonly client: HadamardBridgeSdkClient,
    runtime: RuntimeProviderId,
    private readonly options: { model?: string; permissionMode?: HadamardBridgePermissionMode },
  ) {
    this.engineId = `bridge:${runtime}`;
  }

  static async create(options: BridgeAcpEngineOptions): Promise<BridgeAcpEngine> {
    const permissionMode = options.permissionMode
      && (BRIDGE_PERMISSION_MODES as readonly string[]).includes(options.permissionMode)
      ? options.permissionMode as HadamardBridgePermissionMode
      : undefined;
    let client: HadamardBridgeSdkClient;
    try {
      client = await createHadamardBridgeSdk({
        directCli: true,
        directCliProvider: options.runtime,
        authSource: 'native',
        workDir: options.workDir,
        model: options.model,
        permissionMode,
      });
    } catch (error) {
      throw new Error(
        `Bridge runtime "${options.runtime}" is not available: ${error instanceof Error ? error.message : String(error)}. `
        + 'Install and log in to the corresponding CLI, then retry.',
      );
    }
    return new BridgeAcpEngine(client, options.runtime, {
      model: options.model,
      permissionMode,
    });
  }

  async createSession(cwd: string): Promise<AcpEngineSession> {
    const session = await this.client.createSession({
      workDir: cwd,
      model: this.options.model,
      permissionMode: this.options.permissionMode,
    });
    return new BridgeAcpEngineSession(session);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

class BridgeAcpEngineSession implements AcpEngineSession {
  constructor(private readonly session: HadamardBridgeSession) {}

  get id(): string {
    return this.session.id;
  }

  run(prompt: AcpTextContentBlock[]): AcpRunHandle {
    const text = prompt.map(block => block.text).join('\n\n');
    const abort = new AbortController();
    const stream = this.session.stream(text, { signal: abort.signal });
    const events = mapBridgeEvents(stream);
    const result = (async (): Promise<AcpEngineRunResult> => {
      try {
        const runResult = await stream.result;
        if (abort.signal.aborted) return { stopReason: 'cancelled' };
        if (runResult.isError) {
          throw new Error(
            `Bridge run failed (subtype: ${runResult.subtype ?? 'unknown'}; exit code: ${runResult.exitCode ?? 'none'}).`,
          );
        }
        return { stopReason: mapBridgeRunResultToStopReason(runResult), meta: bridgeRunMeta(runResult) };
      } catch (error) {
        if (abort.signal.aborted || isAbortLikeError(error)) return { stopReason: 'cancelled' };
        throw error;
      }
    })();
    // Mark the rejection as handled; the server still awaits `result` itself.
    void result.catch(() => undefined);
    return {
      events,
      result,
      cancel: () => abort.abort(),
    };
  }
}

async function* mapBridgeEvents(
  stream: AsyncIterable<import('../types.js').HadamardBridgeJsonEvent>,
): AsyncIterable<AcpSessionUpdateBody> {
  for await (const event of stream) {
    yield* mapBridgeJsonEventToAcpUpdates(event);
  }
}

/** Honest per-turn facts from a bridge run; the CLI reports cost, not token counts. */
function bridgeRunMeta(result: HadamardBridgeRunResult): AcpRunMeta {
  const meta: AcpRunMeta = {};
  if (typeof result.totalCostUsd === 'number') meta.costUsd = result.totalCostUsd;
  if (typeof result.durationMs === 'number') meta.durationMs = result.durationMs;
  return meta;
}
