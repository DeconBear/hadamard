import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { tool } from '../src/index.js';
import type { AgentToolDefinition, ModelApi, ModelRequest } from '../src/index.js';
import type { Message, MessageParam, ToolUseBlock } from '../src/provider/types.js';
import { HadamardProviderApiError } from '../src/errors.js';
import { executeConversation } from '../src/runtime/conversationEngine.js';
import { McpConnectionManager } from '../src/mcp/connectionManager.js';
import { resolveRuntimeConfig } from '../src/config/resolveRuntimeConfig.js';
import type { TrajectoryEvent } from '../src/runtime/trajectoryEvents.js';
import {
  fingerprintRequestHeader,
  headerFingerprintMatches,
  parseTrajectoryEnvelopes,
  projectModelSurfaceFromTrajectory,
  projectModelSurfaceThrough,
} from '../src/runtime/surfaceProjection.js';

const tempDirs: string[] = [];
let messageId = 0;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeMessage(content: unknown[], stopReason: 'tool_use' | 'end_turn'): Message {
  messageId += 1;
  return {
    id: `surface-message-${messageId}`,
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: content as Message['content'],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as Message;
}

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input } as ToolUseBlock;
}

/** Wire-level cache_control annotations are not model-visible content: strip them for byte comparison. */
function normalizeSurface(messages: MessageParam[]): string {
  return JSON.stringify(messages, (key, value) => (key === 'cache_control' ? undefined : value));
}

function compareSurfaces(left: MessageParam[], right: MessageParam[]): void {
  expect(normalizeSurface(left)).toBe(normalizeSurface(right));
}

type ScriptEntry = unknown[] | ((request: ModelRequest) => unknown[]);

class ScriptedModel implements ModelApi {
  readonly calls: ModelRequest[] = [];
  private index = 0;
  constructor(private readonly script: ScriptEntry[]) {}
  async createMessage(request: ModelRequest): Promise<Message> {
    this.calls.push(structuredClone(request));
    const entry = this.script[Math.min(this.index, this.script.length - 1)]!;
    this.index += 1;
    const content = typeof entry === 'function' ? entry(request) : entry;
    const hasToolUse = content.some((block) => (block as { type?: string }).type === 'tool_use');
    return makeMessage(content, hasToolUse ? 'tool_use' : 'end_turn');
  }
  streamMessage(): never {
    throw new Error('not used');
  }
}

async function buildHarness(options: {
  script: ScriptEntry[];
  tools: AgentToolDefinition[];
  messages?: MessageParam[];
  signal?: AbortSignal;
}): Promise<{
  events: TrajectoryEvent[];
  modelApi: ScriptedModel;
  run: ReturnType<typeof executeConversation>;
  systemPrompt: string;
  providerTools: unknown[];
}> {
  const homeDir = await tempDir('hadamard-surface-home-');
  const workDir = await tempDir('hadamard-surface-work-');
  const sessionDirectory = await tempDir('hadamard-surface-sessions-');
  const modelApi = new ScriptedModel(options.script);
  const config = await resolveRuntimeConfig({
    model: 'test-model',
    modelApi,
    homeDir,
    workDir,
    sessionDirectory,
    systemPrompt: 'You are a test agent.',
    // Non-Anthropic baseURL: skips wire-level cache_control mutations so the
    // recorded requests equal the logical model-visible surface byte-for-byte.
    baseURL: 'https://example.invalid/v1',
  });
  const mcpManager = new McpConnectionManager({ name: 'test', version: '0' });
  const events: TrajectoryEvent[] = [];
  const systemPrompt = 'You are a test agent.';
  const resolvedTools = await mcpManager.resolveToolAdapters(options.tools, [], { timeoutMs: config.mcpTimeoutMs });
  const providerTools = resolvedTools.map((entry) => entry.providerTool);
  const run = executeConversation({
    runId: 'surface-run',
    input: 'Do the task.',
    model: 'test-model',
    streaming: false,
    signal: options.signal,
    modelApi,
    config,
    mcpManager,
    tools: options.tools,
    permissionMode: 'bypassPermissions',
    ...(options.messages ? { messages: options.messages } : {}),
    onTrajectoryEvent: (event) => { events.push(structuredClone(event)); },
  });
  return { events, modelApi, run, systemPrompt, providerTools };
}

describe('persisted trajectory envelopes', () => {
  it('parses persisted event lines and tolerates a torn tail write', () => {
    const event = {
      type: 'conversation.append',
      seq: 3,
      timestamp: '2026-08-16T00:00:00.000Z',
      runId: 'run-x',
      iteration: 1,
      origin: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    } as const;
    const lines = [
      JSON.stringify({ type: 'event', uuid: 'u1', timestamp: '2026-08-16T00:00:00.000Z', sessionId: 's1', cwd: '/tmp', event }),
      '{"type":"event","uuid":"u2","torn',
      '',
    ];
    const events = parseTrajectoryEnvelopes(lines);
    expect(events).toHaveLength(1);
    const projected = projectModelSurfaceFromTrajectory(events);
    expect(JSON.stringify(projected)).toBe(JSON.stringify([event.message]));
  });
});

describe('durable surface projection', () => {
  it('rebuilds the model-visible surface byte-for-byte for a normal multi-step run', async () => {
    const readA = tool(
      { name: 'read_a', description: 'Read A.', inputSchema: z.strictObject({}), isReadOnly: () => true },
      async () => 'a-result',
    );
    const readB = tool(
      { name: 'read_b', description: 'Read B.', inputSchema: z.strictObject({}), isReadOnly: () => true },
      async () => 'b-result',
    );
    const harness = await buildHarness({
      tools: [readA, readB],
      script: [
        [toolUse('tu_a', 'read_a'), toolUse('tu_b', 'read_b')],
        [{ type: 'text', text: 'both results are in.' }],
      ],
    });
    const result = await harness.run;
    expect(result.stopReason).toBe('end_turn');
    expect(harness.modelApi.calls).toHaveLength(2);
    const events = harness.events;
    // Each engine request is exactly reconstructable from the log up to its start seq.
    const started = events.filter((event) => event.type === 'request.started');
    expect(started).toHaveLength(harness.modelApi.calls.length);
    for (let index = 0; index < harness.modelApi.calls.length; index += 1) {
      const projection = projectModelSurfaceThrough(events, started[index]!.seq);
      compareSurfaces(projection, harness.modelApi.calls[index]!.messages);
    }
    // The final projection equals the completed run's message list.
    const finalProjection = projectModelSurfaceFromTrajectory(events);
    compareSurfaces(finalProjection, result.messages);
    // Turn/step pairing is intact.
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'turn.ended')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'step.started')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'step.ended')).toHaveLength(2);
  });

  it('records request headers whose fingerprints verify against the rebuilt header', async () => {
    const readA = tool(
      { name: 'read_a', description: 'Read A.', inputSchema: z.strictObject({}), isReadOnly: () => true },
      async () => 'a-result',
    );
    const harness = await buildHarness({
      tools: [readA],
      script: [
        [toolUse('tu_a', 'read_a')],
        [{ type: 'text', text: 'done.' }],
      ],
    });
    await harness.run;
    const headers = harness.events.filter(
      (event): event is Extract<TrajectoryEvent, { type: 'request.header' }> => event.type === 'request.header',
    );
    expect(headers).toHaveLength(2);
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index]!;
      const call = harness.modelApi.calls[index]!;
      expect(header.model).toBe('test-model');
      // The header event must verify against the exact request the engine sent.
      expect(header.headerKey).toBe(fingerprintRequestHeader(call.system, call.tools as unknown[] | undefined).headerKey);
      expect(headerFingerprintMatches(
        { systemHash: header.systemHash, toolsHash: header.toolsHash, headerKey: header.headerKey },
        call.system,
        call.tools as unknown[] | undefined,
      )).toBe(true);
      expect(header.maxTokens).toBe(call.max_tokens);
    }
  });

  it('keeps an aborted batch paired in the durable surface', async () => {
    const controller = new AbortController();
    const fastRead = tool(
      { name: 'fast_read', description: 'Fast read.', inputSchema: z.strictObject({}), isReadOnly: () => true },
      async () => {
        controller.abort(new Error('halt mid-batch'));
        return 'fast result';
      },
    );
    const slowRead = tool(
      { name: 'slow_read', description: 'Slow read.', inputSchema: z.strictObject({}), isReadOnly: () => true },
      async () => 'slow result',
    );
    const harness = await buildHarness({
      tools: [fastRead, slowRead],
      signal: controller.signal,
      script: [
        [toolUse('tu_fast', 'fast_read'), toolUse('tu_slow', 'slow_read'), toolUse('tu_skipped', 'fast_read')],
      ],
    });
    await expect(harness.run).rejects.toThrow(/halt mid-batch/);
    const events = harness.events;
    const projection = projectModelSurfaceFromTrajectory(events);
    const serialized = JSON.stringify(projection);
    expect(serialized).toContain('tu_fast');
    expect(serialized).toContain('tu_slow');
    expect(serialized).toContain('tu_skipped');
    // Every tool_use has a paired tool_result: the durable surface is resumable.
    const toolUseIds = projection.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => (block as { type?: string }).type === 'tool_use').map((block) => (block as { id: string }).id)
        : [],
    );
    const resultIds = projection.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => (block as { type?: string }).type === 'tool_result').map((block) => (block as { tool_use_id: string }).tool_use_id)
        : [],
    );
    expect(toolUseIds.sort()).toEqual(resultIds.sort());
  });

  it('folds cold-resume repair into the projected seed and pairs dangling tool uses', async () => {
    const readA = tool(
      { name: 'read_a', description: 'Read A.', inputSchema: z.strictObject({}), isReadOnly: () => true },
      async () => 'a-result',
    );
    const harness = await buildHarness({
      tools: [readA],
      messages: [
        { role: 'user', content: 'earlier prompt' },
        { role: 'assistant', content: [toolUse('dangling-1', 'read_a')] },
      ],
      script: [
        [{ type: 'text', text: 'recovered after resume.' }],
      ],
    });
    const result = await harness.run;
    expect(result.stopReason).toBe('end_turn');
    const events = harness.events;
    expect(events.some((event) => event.type === 'conversation.replaced' && event.reason === 'seed')).toBe(true);
    const projection = projectModelSurfaceFromTrajectory(events);
    const serialized = JSON.stringify(projection);
    expect(serialized).toContain('dangling-1');
    const resultIds = projection.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => (block as { type?: string }).type === 'tool_result').map((block) => (block as { tool_use_id: string }).tool_use_id)
        : [],
    );
    expect(resultIds).toContain('dangling-1');
  });

  it('replays a reactive compaction as an atomic surface replacement', async () => {
    const readA = tool(
      { name: 'read_a', description: 'Read A.', inputSchema: z.strictObject({}), isReadOnly: () => true },
      async () => 'a-result',
    );
    const harness = await buildHarness({
      tools: [readA],
      messages: [
        { role: 'user', content: 'first instruction' },
        { role: 'assistant', content: [{ type: 'text', text: 'working on it.' }] },
        { role: 'user', content: 'second instruction' },
        { role: 'assistant', content: [{ type: 'text', text: 'still working.' }] },
      ],
      script: [
        () => {
          throw new HadamardProviderApiError('prompt is too long for the context window', { status: 400 });
        },
        (request) => {
          const text = JSON.stringify(request.messages);
          if (text.includes('You are compacting') || text.includes('detailed summary')) {
            return [{ type: 'text', text: '<summary>compacted summary</summary>' }];
          }
          return [{ type: 'text', text: 'final answer after compact.' }];
        },
      ],
    });
    const result = await harness.run;
    expect(result.stopReason).toBe('end_turn');
    const events = harness.events;
    const replaced = events.find((event) => event.type === 'conversation.replaced' && event.reason === 'reactive-compact');
    expect(replaced).toBeTruthy();
    // The last engine request is byte-reconstructable from the log.
    const lastStarted = events.filter((event) => event.type === 'request.started').at(-1)!;
    const projection = projectModelSurfaceThrough(events, lastStarted.seq);
    compareSurfaces(projection, harness.modelApi.calls.at(-1)!.messages);
    expect(JSON.stringify(projection)).toContain('compacted summary');
  });

  it('keeps the main surface stable while CodeAct-style nested dispatches run', async () => {
    const inner = tool(
      { name: 'inner_read', description: 'Inner read.', inputSchema: z.strictObject({}), isReadOnly: () => true },
      async () => 'inner-result',
    );
    const outer = tool(
      { name: 'outer_dispatch', description: 'Dispatches a nested tool.', inputSchema: z.strictObject({}), isReadOnly: () => true },
      async (_input, context) => {
        const record = await context.runtime?.executeTool?.(inner, {}, { toolUseId: 'nested-1' });
        return `nested said: ${String(record?.output ?? '')}`;
      },
    );
    const harness = await buildHarness({
      tools: [inner, outer],
      script: [
        [toolUse('tu_outer', 'outer_dispatch')],
        [{ type: 'text', text: 'nested dispatch complete.' }],
      ],
    });
    const result = await harness.run;
    expect(result.stopReason).toBe('end_turn');
    expect(JSON.stringify(result.messages)).toContain('nested said: inner-result');
    const events = harness.events;
    const lastStarted = events.filter((event) => event.type === 'request.started').at(-1)!;
    const projection = projectModelSurfaceThrough(events, lastStarted.seq);
    compareSurfaces(projection, harness.modelApi.calls.at(-1)!.messages);
  });
});

