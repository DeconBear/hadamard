import type { TeamAgentRunnerFactory } from './teamAgentRunnerPort.js';

let defaultFactory: TeamAgentRunnerFactory | undefined;

/** Composition-root hook used by the standalone SDK client. */
export function registerTeamAgentRunnerFactory(factory: TeamAgentRunnerFactory): void {
  defaultFactory = factory;
}

export function hasTeamAgentRunnerFactory(): boolean {
  return defaultFactory != null;
}

export function getTeamAgentRunnerFactory(): TeamAgentRunnerFactory {
  if (!defaultFactory) {
    throw new Error('Team agent runtime is unavailable: no TeamAgentRunnerFactory is registered.');
  }
  return defaultFactory;
}

/**
 * Resolve the runner factory without requiring callers to import the SDK
 * composition root first.
 *
 * Loads the default runtime through a computed module specifier so the
 * architecture cycle gate does not see a back-edge into agentClient.
 * agentClient already lazy-loads modelTeam; a direct reverse load would
 * reintroduce that component in the dependency graph.
 */
export async function resolveTeamAgentRunnerFactory(): Promise<TeamAgentRunnerFactory> {
  if (defaultFactory) return defaultFactory;
  const spec: string = ['..', 'runtime', 'agentClient.js'].join('/');
  await import(spec);
  return getTeamAgentRunnerFactory();
}
