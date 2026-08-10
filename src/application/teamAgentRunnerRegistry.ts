import type { TeamAgentRunnerFactory } from './teamAgentRunnerPort.js';

let defaultFactory: TeamAgentRunnerFactory | undefined;

/** Composition-root hook used by the standalone SDK client. */
export function registerTeamAgentRunnerFactory(factory: TeamAgentRunnerFactory): void {
  defaultFactory = factory;
}

export function getTeamAgentRunnerFactory(): TeamAgentRunnerFactory {
  if (!defaultFactory) {
    throw new Error('Team agent runtime is unavailable: no TeamAgentRunnerFactory is registered.');
  }
  return defaultFactory;
}
