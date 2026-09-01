import { describe, expect, it, vi } from 'vitest';

const askTeamDefinition = vi.fn();

vi.mock('../src/team/modelTeam.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/team/modelTeam.js')>();
  return { ...original, askTeamDefinition: (...args: unknown[]) => askTeamDefinition(...args) };
});

vi.mock('../src/config/resolveRuntimeConfig.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/config/resolveRuntimeConfig.js')>();
  return {
    ...original,
    resolveRuntimeConfig: vi.fn(async (options: { model?: string }) => ({ model: options.model ?? 'settings-default-model' })),
  };
});

import { AcpServer, TeamAcpEngine, mapTeamEventToAcpUpdates } from '../src/acp/index.js';
import type { GraphTeamResult, TeamDefinition, TeamEvent } from '../src/types.js';

const CHANNEL = { notify: vi.fn(), request: vi.fn(async () => ({})) };

function teamResult(answer: string, overrides: Partial<GraphTeamResult> = {}): GraphTeamResult {
  return {
    mode: 'graph',
    answer,
    cost: { totalInputTokens: 0, totalOutputTokens: 0, estimatedCost: 0, breakdown: [] },
    durationMs: 1,
    reports: [],
    skippedNodes: [],
    ...overrides,
  };
}

function request(id: number, method: string, params?: unknown) {
  return { kind: 'request' as const, id, method, params };
}

describe('mapTeamEventToAcpUpdates', () => {
  it('maps member lifecycle to tool_call pairs and drops orchestration detail', () => {
    expect(mapTeamEventToAcpUpdates({ type: 'team.member.started', id: 'researcher', model: 'm1', round: 1 }))
      .toEqual([{
        sessionUpdate: 'tool_call',
        toolCallId: 'team-member:researcher:1',
        title: 'Team member researcher (m1)',
        kind: 'other',
        status: 'in_progress',
      }]);
    expect(mapTeamEventToAcpUpdates({
      type: 'team.member.completed', id: 'researcher', model: 'm1', round: 1, ok: false, toolCalls: 2, durationMs: 5, error: 'boom',
    })).toEqual([{
      sessionUpdate: 'tool_call_update',
      toolCallId: 'team-member:researcher:1',
      status: 'failed',
      rawOutput: 'boom',
    }]);
    expect(mapTeamEventToAcpUpdates({ type: 'team.round.completed', round: 1, reports: 2 })).toEqual([]);
  });
});

describe('TeamAcpEngine', () => {
  it('creates from built-in presets and marks the engine id', async () => {
    const engine = await TeamAcpEngine.create({ team: 'panel-analysis', workDir: process.cwd() });
    expect(engine.engineId).toBe('team:panel-analysis');
    const server = new AcpServer({ engine });
    const response = await server.handleRequest(
      request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} }),
      CHANNEL,
    );
    expect(response).toMatchObject({ result: { _meta: { hadamardEngine: 'team:panel-analysis' } } });
  });

  it('instantiates empty member models with the effective default model', async () => {
    const engine = await TeamAcpEngine.create({ team: 'panel-analysis', workDir: process.cwd(), model: 'chosen-model' });
    const session = await engine.createSession(process.cwd());
    askTeamDefinition.mockImplementationOnce(async (definition: TeamDefinition) => {
      // Canonicalized graph presets carry members as agent nodes.
      const nodeModels = (definition.nodes ?? [])
        .filter(node => (node.kind ?? 'agent') === 'agent')
        .map(node => node.model);
      expect(nodeModels.length).toBeGreaterThan(0);
      expect(nodeModels.every(model => model === 'chosen-model')).toBe(true);
      return teamResult('ok');
    });
    const run = session.run([{ type: 'text', text: 'hi' }], CHANNEL);
    await drain(run.events);
    await expect(run.result).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('fails fast with available teams when the definition is unknown', async () => {
    await expect(TeamAcpEngine.create({ team: 'no-such-team', workDir: process.cwd() }))
      .rejects.toThrowError(/Team definition "no-such-team" was not found.*panel-analysis/s);
  });

  it('streams member progress as tool updates and the answer as a message chunk', async () => {
    askTeamDefinition.mockImplementationOnce(async (
      _definition: TeamDefinition,
      _prompt: string,
      _signal: AbortSignal,
      opts: { onEvent?: (event: TeamEvent) => void },
    ) => {
      opts.onEvent?.({ type: 'team.member.started', id: 'researcher', model: 'm1', round: 1 });
      opts.onEvent?.({ type: 'team.member.completed', id: 'researcher', model: 'm1', round: 1, ok: true, toolCalls: 1, durationMs: 3 });
      return teamResult('panel answer');
    });
    const engine = await TeamAcpEngine.create({ team: 'panel-analysis', workDir: process.cwd() });
    const server = new AcpServer({ engine });
    const created = await server.handleRequest(request(1, 'session/new', { cwd: process.cwd() }), CHANNEL);
    const { sessionId } = (created as { result: { sessionId: string } }).result;

    const channel = { notify: vi.fn(), request: vi.fn(async () => ({})) };
    const response = await server.handleRequest(
      request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'analyze' }] }),
      channel,
    );
    expect(response).toMatchObject({ result: { stopReason: 'end_turn' } });
    const updates = channel.notify.mock.calls.map(call => (call[1] as { update: { sessionUpdate: string } }).update);
    expect(updates.map(update => update.sessionUpdate)).toEqual([
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
    ]);
    expect(updates[2]).toMatchObject({ content: { text: 'panel answer' } });
  });

  it('answers cancelled when the client cancels an in-flight team run', async () => {
    askTeamDefinition.mockImplementationOnce(async (
      _definition: TeamDefinition,
      _prompt: string,
      signal: AbortSignal,
    ) => new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    const engine = await TeamAcpEngine.create({ team: 'panel-analysis', workDir: process.cwd() });
    const server = new AcpServer({ engine });
    const created = await server.handleRequest(request(1, 'session/new', { cwd: process.cwd() }), CHANNEL);
    const { sessionId } = (created as { result: { sessionId: string } }).result;

    const promptPromise = server.handleRequest(
      request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'long' }] }),
      CHANNEL,
    );
    await new Promise(resolve => setImmediate(resolve));
    await server.handleNotification({ kind: 'notification', method: 'session/cancel', params: { sessionId } });
    await expect(promptPromise).resolves.toMatchObject({ result: { stopReason: 'cancelled' } });
  });

  it('marks incomplete team results in the answer instead of faking success', async () => {
    askTeamDefinition.mockResolvedValueOnce(teamResult('partial findings', { incompleteReason: 'member skeptic failed' }));
    const engine = await TeamAcpEngine.create({ team: 'panel-analysis', workDir: process.cwd() });
    const session = await engine.createSession(process.cwd());
    const run = session.run([{ type: 'text', text: 'hi' }], CHANNEL);
    const updates: Array<{ sessionUpdate: string; content?: { text: string } }> = [];
    for await (const update of run.events) updates.push(update);
    await expect(run.result).resolves.toEqual({ stopReason: 'end_turn' });
    expect(updates.at(-1)?.content?.text).toContain('[incomplete: member skeptic failed]');
  });
});

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of events) { /* drain */ }
}
