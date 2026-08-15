import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createAgentSdk, tool } from '../src/index.js';
import type { ModelApi, ModelRequest } from '../src/index.js';
import {
  buildAbortedBeforeDispatchResult,
  executeToolUsesWithContract,
} from '../src/runtime/conversationToolBatch.js';
import { executeConversation } from '../src/runtime/conversationEngine.js';
import { McpConnectionManager } from '../src/mcp/connectionManager.js';
import { resolveRuntimeConfig } from '../src/config/resolveRuntimeConfig.js';
import type { Message, MessageParam, ToolUseBlock } from '../src/provider/types.js';

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
    id: `contract-message-${messageId}`,
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

describe('executeToolUsesWithContract', () => {
  it('runs parallel-classified calls in a bounded pool with model-ordered results', async () => {
    const active = { current: 0, max: 0 };
    const run = async (_toolUse: ToolUseBlock, index: number): Promise<number> => {
      active.current += 1;
      active.max = Math.max(active.max, active.current);
      // Later calls finish first on purpose.
      const delay = (5 - index) * 5;
      await new Promise((resolve) => setTimeout(resolve, delay));
      active.current -= 1;
      return index * 10;
    };
    const toolUses = [0, 1, 2, 3, 4].map((n) => toolUse(`tu_${n}`, 'read'));
    const { results, aborted } = await executeToolUsesWithContract(
      toolUses,
      () => true,
      run,
      { maxParallel: 2 },
    );
    expect(results).toEqual([0, 10, 20, 30, 40]);
    expect(aborted).toBe(false);
    expect(active.max).toBeLessThanOrEqual(2);
  });

  it('exclusive calls drain the pool and hold the barrier through completion', async () => {
    const events: string[] = [];
    const run = async (_toolUse: ToolUseBlock, index: number): Promise<string> => {
      events.push(`start:${index}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push(`end:${index}`);
      return `result:${index}`;
    };
    const toolUses = [0, 1, 2].map((n) => toolUse(`tu_${n}`, 'mixed'));
    const { results } = await executeToolUsesWithContract(
      toolUses,
      (_toolUse, index) => index !== 1, // index 1 is exclusive
      run,
      { maxParallel: 2 },
    );
    expect(results).toEqual(['result:0', 'result:1', 'result:2']);
    // The exclusive call never overlaps call 0; call 2 starts only after the
    // exclusive barrier fully commits.
    expect(events.indexOf('start:1')).toBeGreaterThan(events.indexOf('end:0'));
    expect(events.indexOf('start:2')).toBeGreaterThan(events.indexOf('end:1'));
  });

  it('re-reads classification lazily before each start', async () => {
    const events: string[] = [];
    const run = async (_toolUse: ToolUseBlock, index: number): Promise<string> => {
      events.push(`start:${index}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push(`end:${index}`);
      return `result:${index}`;
    };
    let classifyCalls = 0;
    const toolUses = [0, 1, 2].map((n) => toolUse(`tu_${n}`, 'mixed'));
    const { results } = await executeToolUsesWithContract(
      toolUses,
      () => {
        classifyCalls += 1;
        // Flips exclusive after the first two classifications.
        return classifyCalls <= 2;
      },
      run,
      { maxParallel: 2 },
    );
    expect(results).toEqual(['result:0', 'result:1', 'result:2']);
    // Calls 0 and 1 overlapped (both classified parallel); call 2 was
    // reclassified exclusive and ran alone after the pool drained.
    expect(events.indexOf('start:2')).toBeGreaterThan(events.indexOf('end:1'));
    expect(events.indexOf('start:2')).toBeGreaterThan(events.indexOf('end:0'));
  });

  it('aborts by draining started calls and leaving skipped calls undefined', async () => {
    const controller = new AbortController();
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let slowStarted: (() => void) | undefined;
    const slowStartedSignal = new Promise<void>((resolve) => { slowStarted = resolve; });
    const run = async (_toolUse: ToolUseBlock, index: number): Promise<string> => {
      if (index === 0) return 'fast';
      if (index === 1) {
        slowStarted?.();
        await slowGate;
        return 'slow';
      }
      throw new Error(`unexpected start of call ${index}`);
    };
    const toolUses = [0, 1, 2].map((n) => toolUse(`tu_${n}`, 'read'));
    const runPromise = executeToolUsesWithContract(
      toolUses,
      () => true,
      run,
      { maxParallel: 1, signal: controller.signal },
    );
    await slowStartedSignal;
    controller.abort(new Error('stop'));
    releaseSlow?.();
    const { results, aborted } = await runPromise;
    expect(aborted).toBe(true);
    expect(results[0]).toBe('fast');
    expect(results[1]).toBe('slow'); // started call drained to quiescence
    expect(results[2]).toBeUndefined(); // skipped before dispatch
  });

  it('fails closed when the classifier throws', async () => {
    const events: string[] = [];
    const run = async (_toolUse: ToolUseBlock, index: number): Promise<string> => {
      events.push(`start:${index}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push(`end:${index}`);
      return `result:${index}`;
    };
    const toolUses = [0, 1].map((n) => toolUse(`tu_${n}`, 'mixed'));
    const { results } = await executeToolUsesWithContract(
      toolUses,
      (_toolUse, index) => {
        if (index === 1) throw new Error('classifier broken');
        return true;
      },
      run,
      { maxParallel: 2 },
    );
    expect(results).toEqual(['result:0', 'result:1']);
    // A throwing classifier means exclusive: no overlap with call 0.
    expect(events.indexOf('start:1')).toBeGreaterThan(events.indexOf('end:0'));
  });
});

describe('buildAbortedBeforeDispatchResult', () => {
  it('builds a paired synthetic error result for a skipped tool call', () => {
    const { callPayload, record, resultBlock } = buildAbortedBeforeDispatchResult(
      toolUse('tu_skipped', 'read', { q: 'x' }),
    );
    expect(callPayload.id).toBe('tu_skipped');
    expect(record.abortedBeforeDispatch).toBe(true);
    expect(record.isError).toBe(true);
    expect(record.outputText).toContain('aborted before dispatch');
    expect(resultBlock).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_skipped',
      is_error: true,
    });
  });
});

class QueueModel implements ModelApi {
  readonly calls: ModelRequest[] = [];
  constructor(private readonly responses: unknown[][]) {}
  async createMessage(request: ModelRequest): Promise<Message> {
    this.calls.push(structuredClone(request));
    const content = this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)]!;
    const hasToolUse = content.some((block) => (block as { type?: string }).type === 'tool_use');
    return makeMessage(content, hasToolUse ? 'tool_use' : 'end_turn');
  }
  streamMessage(): never {
    throw new Error('not used');
  }
}
describe('executeConversation tool contract', () => {
  it('keeps aborted batches paired with synthetic results for skipped calls', async () => {
    const homeDir = await tempDir('hadamard-contract-home-');
    const workDir = await tempDir('hadamard-contract-work-');
    const sessionDirectory = await tempDir('hadamard-contract-sessions-');
    const controller = new AbortController();
    const fastRead = tool(
      {
        name: 'fast_read',
        description: 'Fast read.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
      },
      async () => {
        controller.abort(new Error('halt mid-batch'));
        return 'fast result';
      },
    );
    const slowRead = tool(
      {
        name: 'slow_read',
        description: 'Slow read.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
      },
      async () => 'slow result',
    );
    const modelApi = new QueueModel([
      [
        toolUse('tu_fast', 'fast_read'),
        toolUse('tu_slow', 'slow_read'),
        toolUse('tu_skipped', 'fast_read'),
      ],
    ]);
    const config = await resolveRuntimeConfig({
      model: 'test-model',
      modelApi,
      homeDir,
      workDir,
      sessionDirectory,
      maxParallelToolCalls: 1,
    });
    const mcpManager = new McpConnectionManager({ name: 'test', version: '0' });
    const checkpoints: MessageParam[][] = [];
    const runPromise = executeConversation({
      runId: 'contract-abort-run',
      input: 'Run the batch.',
      model: 'test-model',
      streaming: false,
      signal: controller.signal,
      modelApi,
      config,
      mcpManager,
      tools: [fastRead, slowRead],
      permissionMode: 'bypassPermissions',
      onConversationCheckpoint: (messages) => { checkpoints.push(structuredClone(messages)); },
    });
    await expect(runPromise).rejects.toThrow(/halt mid-batch/);
    // The checkpointed conversation pairs every tool_use with a tool_result.
    const messages = checkpoints.at(-1)!;
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain('tu_fast');
    expect(serialized).toContain('tu_slow');
    expect(serialized).toContain('tu_skipped');
    const results = messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => (block as { type?: string }).type === 'tool_result')
        : [],
    ) as Array<{ tool_use_id: string; content: unknown; is_error?: boolean }>;
    expect(results.map((block) => block.tool_use_id).sort()).toEqual(['tu_fast', 'tu_skipped', 'tu_slow']);
    const skipped = results.find((block) => block.tool_use_id === 'tu_skipped')!;
    expect(skipped.content).toContain('aborted before dispatch');
  });

  it('ends the turn when a tool concludes it and defers additional context', async () => {
    const homeDir = await tempDir('hadamard-contract-home-');
    const workDir = await tempDir('hadamard-contract-work-');
    const sessionDirectory = await tempDir('hadamard-contract-sessions-');
    const finishTask = tool(
      {
        name: 'finish_task',
        description: 'Finishes the turn.',
        inputSchema: z.strictObject({}),
        isConcurrencySafe: () => false,
      },
      async (_input, context) => {
        context.deferAdditionalContext?.({ type: 'text', text: 'WRAP_UP_CONTEXT' });
        context.concludeTurn?.();
        return 'finished';
      },
    );
    const modelApi = new QueueModel([
      [toolUse('tu_finish', 'finish_task')],
      [{ type: 'text', text: 'should never be requested' }],
    ]);
    const config = await resolveRuntimeConfig({
      model: 'test-model',
      modelApi,
      homeDir,
      workDir,
      sessionDirectory,
    });
    const mcpManager = new McpConnectionManager({ name: 'test', version: '0' });
    const result = await executeConversation({
      runId: 'contract-conclude-run',
      input: 'Finish up.',
      model: 'test-model',
      streaming: false,
      modelApi,
      config,
      mcpManager,
      tools: [finishTask],
      permissionMode: 'bypassPermissions',
    });
    expect(result.stopReason).toBe('end_turn');
    expect(result.toolCalls[0]?.concludesTurn).toBe(true);
    expect(JSON.stringify(result.messages)).toContain('WRAP_UP_CONTEXT');
    expect(modelApi.calls).toHaveLength(1); // no follow-up request after conclude
  });

  it('discards conclude-turn and deferred context when the tool fails', async () => {
    const homeDir = await tempDir('hadamard-contract-home-');
    const workDir = await tempDir('hadamard-contract-work-');
    const sessionDirectory = await tempDir('hadamard-contract-sessions-');
    const failingFinish = tool<Record<string, never>, unknown>(
      {
        name: 'failing_finish',
        description: 'Requests completion and then fails.',
        inputSchema: z.strictObject({}),
        isConcurrencySafe: () => false,
      },
      async (_input, context) => {
        context.deferAdditionalContext?.({ type: 'text', text: 'MUST_NOT_LEAK' });
        context.concludeTurn?.();
        throw new Error('finish failed');
      },
    );
    const modelApi = new QueueModel([
      [toolUse('tu_failing_finish', 'failing_finish')],
      [{ type: 'text', text: 'recovered after tool failure' }],
    ]);
    const config = await resolveRuntimeConfig({
      model: 'test-model', modelApi, homeDir, workDir, sessionDirectory,
    });
    const mcpManager = new McpConnectionManager({ name: 'test', version: '0' });

    const result = await executeConversation({
      runId: 'contract-failed-conclude-run',
      input: 'Try to finish.',
      model: 'test-model',
      streaming: false,
      modelApi,
      config,
      mcpManager,
      tools: [failingFinish],
      permissionMode: 'bypassPermissions',
    });

    expect(result.text).toContain('recovered after tool failure');
    expect(result.toolCalls[0]?.isError).toBe(true);
    expect(result.toolCalls[0]?.concludesTurn).not.toBe(true);
    expect(JSON.stringify(result.messages)).not.toContain('MUST_NOT_LEAK');
    expect(modelApi.calls).toHaveLength(2);
  });

  it('runs an exclusive write as a barrier between parallel reads', async () => {
    const homeDir = await tempDir('hadamard-contract-home-');
    const workDir = await tempDir('hadamard-contract-work-');
    const sessionDirectory = await tempDir('hadamard-contract-sessions-');
    const tracker = { active: 0, maxActive: 0, writeOverlappedReads: false };
    const makeRead = (name: string) => tool(
      {
        name,
        description: 'A read.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
      },
      async () => {
        tracker.active += 1;
        tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        tracker.active -= 1;
        return 'read result';
      },
    );
    const write = tool(
      {
        name: 'write_state',
        description: 'A write.',
        inputSchema: z.strictObject({}),
        isConcurrencySafe: () => false,
      },
      async () => {
        if (tracker.active > 0) tracker.writeOverlappedReads = true;
        tracker.active += 1;
        tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        tracker.active -= 1;
        return 'write result';
      },
    );
    const firstRead = makeRead('read_one');
    const secondRead = makeRead('read_two');
    const modelApi = new QueueModel([
      [
        toolUse('tu_r1', 'read_one'),
        toolUse('tu_w', 'write_state'),
        toolUse('tu_r2', 'read_two'),
      ],
      [{ type: 'text', text: 'All done.' }],
    ]);
    const config = await resolveRuntimeConfig({
      model: 'test-model',
      modelApi,
      homeDir,
      workDir,
      sessionDirectory,
    });
    const mcpManager = new McpConnectionManager({ name: 'test', version: '0' });
    const result = await executeConversation({
      runId: 'contract-barrier-run',
      input: 'Mixed batch.',
      model: 'test-model',
      streaming: false,
      modelApi,
      config,
      mcpManager,
      tools: [firstRead, write, secondRead],
      permissionMode: 'bypassPermissions',
    });
    expect(result.text).toContain('All done.');
    expect(result.toolCalls.map((call) => call.name)).toEqual([
      'read_one',
      'write_state',
      'read_two',
    ]);
    expect(tracker.writeOverlappedReads).toBe(false);
    expect(tracker.maxActive).toBeLessThanOrEqual(2);
  });
});

describe('maxParallelToolCalls configuration', () => {
  it('resolves the configured bound and rejects invalid values', async () => {
    const homeDir = await tempDir('hadamard-contract-home-');
    const workDir = await tempDir('hadamard-contract-work-');
    const sessionDirectory = await tempDir('hadamard-contract-sessions-');
    const sdk = await createAgentSdk({
      model: 'test-model',
      modelApi: new QueueModel([]),
      homeDir,
      workDir,
      sessionDirectory,
      maxParallelToolCalls: 3,
    });
    try {
      expect(sdk.config.maxParallelToolCalls).toBe(3);
    } finally {
      await sdk.close();
    }
    await expect(resolveRuntimeConfig({
      model: 'test-model',
      modelApi: new QueueModel([]),
      homeDir,
      workDir,
      sessionDirectory,
      maxParallelToolCalls: 0,
    })).rejects.toThrow(/between 1 and 128/);
  });
});
