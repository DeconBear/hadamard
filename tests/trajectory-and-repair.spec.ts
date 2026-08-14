import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { tool } from '../src/index.js';
import type { ModelApi, ModelRequest } from '../src/index.js';
import { executeConversation } from '../src/runtime/conversationEngine.js';
import { McpConnectionManager } from '../src/mcp/connectionManager.js';
import { resolveRuntimeConfig } from '../src/config/resolveRuntimeConfig.js';
import { buildUnpairedToolUseRepair } from '../src/runtime/conversationToolBatch.js';
import type { TrajectoryEvent } from '../src/runtime/trajectoryEvents.js';
import type { Message, MessageParam } from '../src/provider/types.js';

const tempDirs: string[] = [];
let messageId = 0;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeMessage(content: unknown[], stopReason: 'tool_use' | 'end_turn'): Message {
  messageId += 1;
  return {
    id: 'traj-message-' + String(messageId),
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: content as Message['content'],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as Message;
}

class TrajectoryModel implements ModelApi {
  readonly calls: ModelRequest[] = [];
  async createMessage(request: ModelRequest): Promise<Message> {
    this.calls.push(structuredClone(request));
    if (this.calls.length === 1) {
      return makeMessage([{
        type: 'tool_use',
        id: 'tu_run_1',
        name: 'lookup',
        input: {},
      }], 'tool_use');
    }
    return makeMessage([{ type: 'text', text: 'finished' }], 'end_turn');
  }
  streamMessage(): never {
    throw new Error('not used');
  }
}

async function engineHarness(modelApi: ModelApi) {
  const homeDir = await tempDir('hadamard-trajectory-home-');
  const workDir = await tempDir('hadamard-trajectory-work-');
  const sessionDirectory = await tempDir('hadamard-trajectory-sessions-');
  const config = await resolveRuntimeConfig({ model: 'test-model', modelApi, homeDir, workDir, sessionDirectory });
  const mcpManager = new McpConnectionManager({ name: 'test', version: '0' });
  return { config, mcpManager, homeDir, workDir, sessionDirectory };
}

describe('buildUnpairedToolUseRepair', () => {
  it('closes unpaired tool_use blocks and leaves paired history alone', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }, { type: 'tool_use', id: 'b', name: 'Grep', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    ];
    const repair = buildUnpairedToolUseRepair(messages);
    expect(repair?.role).toBe('user');
    const blocks = Array.isArray(repair?.content) ? repair.content : [];
    expect(blocks.map(block => (block as { tool_use_id?: string }).tool_use_id)).toEqual(['b']);
    expect((blocks[0] as { is_error?: boolean }).is_error).toBe(true);
    expect(JSON.stringify(blocks)).toContain('read-only or idempotent');
  });

  it('returns undefined for fully paired history', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    ];
    expect(buildUnpairedToolUseRepair(messages)).toBeUndefined();
  });
});

describe('executeConversation trajectory and repair', () => {
  it('repairs resumed unpaired tool_use before the first request', async () => {
    const modelApi = new TrajectoryModel();
    const harness = await engineHarness(modelApi);
    const lookup = tool(
      { name: 'lookup', description: 'A lookup.', inputSchema: z.strictObject({}), isReadOnly: () => true },
      async () => 'result',
    );
    const result = await executeConversation({
      runId: 'trajectory-repair-run',
      input: 'Continue.',
      model: 'test-model',
      streaming: false,
      modelApi,
      config: harness.config,
      mcpManager: harness.mcpManager,
      tools: [lookup],
      permissionMode: 'bypassPermissions',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'dangling', name: 'Read', input: {} }] },
      ],
    });
    expect(result.text).toContain('finished');
    const firstRequest = modelApi.calls[0]!;
    expect(JSON.stringify(firstRequest.messages)).toContain('dangling');
    expect(JSON.stringify(firstRequest.messages)).toContain('read-only or idempotent');
  });

  it('emits an append-only structured trajectory', async () => {
    const modelApi = new TrajectoryModel();
    const harness = await engineHarness(modelApi);
    const lookup = tool(
      { name: 'lookup', description: 'A lookup.', inputSchema: z.strictObject({}), isReadOnly: () => true },
      async () => 'result',
    );
    const events: TrajectoryEvent[] = [];
    const result = await executeConversation({
      runId: 'trajectory-events-run',
      input: 'Look it up.',
      model: 'test-model',
      streaming: false,
      modelApi,
      config: harness.config,
      mcpManager: harness.mcpManager,
      tools: [lookup],
      permissionMode: 'bypassPermissions',
      onTrajectoryEvent: event => { events.push(structuredClone(event)); },
    });
    expect(result.text).toContain('finished');
    const kinds = events.map(event => event.type);
    expect(kinds[0]).toBe('run.started');
    expect(kinds).toContain('request.started');
    expect(kinds).toContain('assistant.message');
    expect(kinds).toContain('tool.result');
    expect(kinds.at(-1)).toBe('run.completed');
    // Monotonic per-run seqs.
    const seqs = events.map(event => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const completed = events.find(event => event.type === 'run.completed') as Extract<TrajectoryEvent, { type: 'run.completed' }>;
    expect(completed.stopReason).toBe('end_turn');
  });
});
