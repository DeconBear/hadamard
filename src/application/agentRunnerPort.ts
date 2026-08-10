import type { MessageParam } from '../provider/types.js';
import type {
  AgentRunOptions,
  AgentRunResult,
  AgentToolDefinition,
  SessionCreateOptions,
} from '../types.js';

/** Minimal session surface required by application-level workflow runners. */
export interface AgentSessionRunner {
  readonly id: string;
  send(
    input: string | MessageParam['content'],
    options?: AgentRunOptions,
  ): Promise<AgentRunResult>;
}

/**
 * Application port for launching agent sessions.
 *
 * Runtime clients implement this structurally; workflow code does not need to
 * depend on the concrete HadamardAgentClient composition root.
 */
export interface AgentRunner {
  readonly config: {
    readonly workDir: string;
  };
  createSession(options?: SessionCreateOptions): Promise<AgentSessionRunner>;
  getTool(name: string): AgentToolDefinition | undefined;
}
