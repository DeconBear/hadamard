/**
 * External-CLI delegation runner (user-approved feature, 09 Aug 2026).
 *
 * A unified .md agent definition with `runtime:` set to an external CLI
 * runtime id (≠ 'hadamard') runs its Agent/Task delegations on that CLI
 * instead of the in-process Hadamard SDK. The run is a one-shot bridge call:
 * the task prompt becomes the user input, the definition body becomes the
 * system prompt, and the CLI's final text is the delegation result.
 *
 * Semantics and limits:
 * - The CLI runs with `authSource: 'native'` (its own login). A definition
 *   that also needs a specific credential should point at a bridge config via
 *   the SDK path instead.
 * - Unavailable runtime (not installed/discovered) is a hard error naming the
 *   runtime and agent — we deliberately do NOT fall back to the SDK silently.
 * - Headless runs must never block on interactive approval, so the bridge
 *   permissionMode is 'bypassPermissions' unless the definition pins a
 *   bridge-compatible mode (plan/acceptEdits/default/dontAsk).
 * - Worktree isolation works through the normal delegation workspace
 *   preparation (the caller passes the prepared cwd).
 */
import type {
  ExternalAgentRunRequest,
  ExternalAgentRunResult,
  HadamardBridgePermissionMode,
  RuntimeProviderId,
} from '../types.js';
import { createHadamardBridgeSdk } from '../parity/hadamardBridgeSdk.js';
import { discoverAgentRuntimes } from './agentRuntimeDiscovery.js';

export function isExternalAgentRuntime(runtime: string | undefined): boolean {
  return Boolean(runtime?.trim()) && runtime !== 'hadamard';
}

const BRIDGE_PERMISSION_MODES: ReadonlySet<string> = new Set([
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
]);

/** Headless delegation must never block on interactive approval. */
function bridgePermissionMode(definitionMode: string | undefined): HadamardBridgePermissionMode {
  return definitionMode && BRIDGE_PERMISSION_MODES.has(definitionMode)
    ? (definitionMode as HadamardBridgePermissionMode)
    : 'bypassPermissions';
}

export async function runExternalAgentOnce(
  request: ExternalAgentRunRequest,
): Promise<ExternalAgentRunResult> {
  const runtime = request.runtime.trim();
  const discovered = await discoverAgentRuntimes({ homeDir: request.homeDir });
  const entry = discovered.find(candidate => candidate.runtime === runtime);
  if (!entry?.installed) {
    throw new Error(
      `Agent "${request.agentName}" requires the "${runtime}" runtime, which is not installed `
      + 'or discovered on this machine. Install it, or set the agent runtime back to hadamard. '
      + 'No SDK fallback is attempted on purpose.',
    );
  }
  const client = await createHadamardBridgeSdk({
    directCli: true,
    directCliProvider: runtime as RuntimeProviderId,
    authSource: 'native',
    workDir: request.cwd,
    homeDir: request.homeDir,
  });
  try {
    const result = await client.run(request.prompt, {
      ...(request.systemPrompt?.trim() ? { systemPrompt: request.systemPrompt } : {}),
      permissionMode: bridgePermissionMode(request.permissionMode),
      ...(request.model?.trim() ? { model: request.model.trim() } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (result.isError) {
      throw new Error(
        `External runtime "${runtime}" failed for agent "${request.agentName}": `
        + (result.stderr?.trim() || result.text || 'unknown error'),
      );
    }
    return {
      text: result.text,
      sessionId: result.sessionId || undefined,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
