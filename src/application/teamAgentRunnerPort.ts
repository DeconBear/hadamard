import type {
  AgentEvent,
  AgentRunOptions,
  AgentRunResult,
  CreateAgentSdkOptions,
} from '../types.js';

export interface TeamAgentRunStream extends AsyncIterable<AgentEvent> {
  readonly result: Promise<AgentRunResult>;
}

/** Minimal runtime surface required by one team member execution. */
export interface TeamAgentRunner {
  stream(input: string, options?: AgentRunOptions): TeamAgentRunStream;
  close(): Promise<void>;
}

export type TeamAgentRunnerFactory = (
  options?: CreateAgentSdkOptions,
) => Promise<TeamAgentRunner>;
