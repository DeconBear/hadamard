import { randomUUID } from 'node:crypto';

import { resolveRuntimeConfig } from '../config/resolveRuntimeConfig.js';
import {
  getBuiltInTeamDefinition,
  instantiateTeamDefinition,
  listTeamDefinitions,
  loadTeamDefinition,
} from '../team/teamDefinitions.js';
import { askTeamDefinition } from '../team/modelTeam.js';
import type { HadamardPermissionMode, ModelTeamResult, TeamDefinition, TeamEvent } from '../types.js';
import { isAbortLikeError, mapTeamEventToAcpUpdates } from './acpEventMapper.js';
import type {
  AcpEngineRunResult,
  AcpEngineSession,
  AcpRunHandle,
  AcpRuntimeEngine,
} from './acpEngine.js';
import type { AcpSessionUpdateBody, AcpTextContentBlock } from './acpProtocol.js';
import { createAcpToolApprover, type AcpClientChannel } from './acpPermissionBridge.js';

export interface TeamAcpEngineOptions {
  team: string;
  workDir: string;
  model?: string;
  permissionMode?: HadamardPermissionMode;
  homeDir?: string;
}

/**
 * Team engine: run a saved or built-in Hadamard team definition (panel,
 * executor-reviewer, workflow, …) as one ACP session. Team orchestration,
 * budgeting, and verification stay with Hadamard; the ACP layer only maps
 * progress events and the final answer.
 */
export class TeamAcpEngine implements AcpRuntimeEngine {
  readonly engineId: string;

  /** Public for dependency injection in tests; prefer {@link TeamAcpEngine.create}. */
  constructor(
    private readonly definition: TeamDefinition,
    private readonly options: TeamAcpEngineOptions,
  ) {
    this.engineId = `team:${definition.name}`;
  }

  static async create(options: TeamAcpEngineOptions): Promise<TeamAcpEngine> {
    const loaded = loadTeamDefinition(options.team, options.workDir, options.homeDir);
    const builtIn = getBuiltInTeamDefinition(options.team);
    const definition = loaded?.definition ?? builtIn;
    if (!definition) {
      const available = [
        ...listTeamDefinitions(options.workDir, options.homeDir).map(entry => entry.name),
        ...['panel-analysis', 'analysis', 'reviewer', 'quick-review', 'security-audit'],
      ];
      throw new Error(
        `Team definition "${options.team}" was not found. Available teams: ${[...new Set(available)].join(', ')}.`,
      );
    }
    // Members with model:'' inherit the effective default model.
    const config = await resolveRuntimeConfig({
      workDir: options.workDir,
      model: options.model,
      homeDir: options.homeDir,
    });
    return new TeamAcpEngine(
      instantiateTeamDefinition(definition, options.model ?? config.model),
      options,
    );
  }

  async createSession(cwd: string): Promise<AcpEngineSession> {
    return new TeamAcpEngineSession(this.definition, { ...this.options, workDir: cwd });
  }

  async close(): Promise<void> {
    // Teams hold no persistent resources; member runners are scoped per run.
  }
}

class TeamAcpEngineSession implements AcpEngineSession {
  readonly id = `acp-team-${randomUUID()}`;

  constructor(
    private readonly definition: TeamDefinition,
    private readonly options: TeamAcpEngineOptions,
  ) {}

  run(prompt: AcpTextContentBlock[], channel: AcpClientChannel): AcpRunHandle {
    const text = prompt.map(block => block.text).join('\n\n');
    const abort = new AbortController();
    const updates = new UpdateQueue();
    const sessionId = this.id;

    const result = (async (): Promise<AcpEngineRunResult> => {
      try {
        const teamResult = await askTeamDefinition(this.definition, text, abort.signal, {
          workDir: this.options.workDir,
          homeDir: this.options.homeDir,
          model: this.options.model,
          permissionMode: this.options.permissionMode,
          approver: createAcpToolApprover({ channel, sessionId }),
          onEvent: (event: TeamEvent) => {
            for (const update of mapTeamEventToAcpUpdates(event)) updates.push(update);
          },
        });
        if (abort.signal.aborted) return { stopReason: 'cancelled' };
        // The final answer streams as one terminal message chunk; per-member
        // progress was already reported as tool_call updates.
        updates.push({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: teamAnswerText(teamResult) },
        });
        return { stopReason: 'end_turn' };
      } catch (error) {
        if (abort.signal.aborted || isAbortLikeError(error)) return { stopReason: 'cancelled' };
        updates.fail(error);
        throw error;
      } finally {
        updates.close();
      }
    })();
    void result.catch(() => undefined);
    return {
      events: updates,
      result,
      cancel: () => abort.abort(),
    };
  }
}

function teamAnswerText(result: ModelTeamResult): string {
  const answer = result.answer?.trim() || '(the team returned no answer)';
  return result.incompleteReason
    ? `${answer}\n\n[incomplete: ${result.incompleteReason}]`
    : answer;
}

/** Minimal push-based async iterable bridging callback-style team events. */
class UpdateQueue implements AsyncIterable<AcpSessionUpdateBody> {
  private readonly buffered: AcpSessionUpdateBody[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<AcpSessionUpdateBody>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private finished = false;
  private failure: unknown;

  push(update: AcpSessionUpdateBody): void {
    if (this.finished) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: update, done: false });
    else this.buffered.push(update);
  }

  fail(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  close(): void {
    if (this.finished) return;
    this.finished = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AcpSessionUpdateBody> {
    while (true) {
      const buffered = this.buffered.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.finished) {
        if (this.failure) throw this.failure;
        return;
      }
      const next = await new Promise<IteratorResult<AcpSessionUpdateBody>>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
