import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { tool } from '../src/index.js';
import type { AgentToolDefinition, ModelApi, ModelRequest } from '../src/index.js';
import type { Message, ToolUseBlock } from '../src/provider/types.js';
import { executeConversation } from '../src/runtime/conversationEngine.js';
import type { ConversationExtensionPoints } from '../src/runtime/conversationExtensions.js';
import { McpConnectionManager } from '../src/mcp/connectionManager.js';
import { resolveRuntimeConfig } from '../src/config/resolveRuntimeConfig.js';
import { HadamardContributionHost } from '../src/contrib/contributionHost.js';
import { conversationExtensionsFactoryKey, createBuiltInConversationExtensionsContribution } from '../src/runtime/conversationExtensions.js';
import type { AgentEvent } from '../src/index.js';

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
    id: `extension-message-${messageId}`,
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

async function runWith(options: {
  script: ScriptEntry[];
  tools: AgentToolDefinition[];
  extensions?: ConversationExtensionPoints;
  onEvent?: (event: AgentEvent) => void;
}) {
  const homeDir = await tempDir('hadamard-extensions-home-');
  const workDir = await tempDir('hadamard-extensions-work-');
  const sessionDirectory = await tempDir('hadamard-extensions-sessions-');
  const modelApi = new ScriptedModel(options.script);
  const config = await resolveRuntimeConfig({
    model: 'test-model',
    modelApi,
    homeDir,
    workDir,
    sessionDirectory,
    baseURL: 'https://example.invalid/v1',
  });
  const mcpManager = new McpConnectionManager({ name: 'test', version: '0' });
  const result = await executeConversation({
    runId: 'extensions-run',
    input: 'Do the task.',
    model: 'test-model',
    streaming: false,
    modelApi,
    config,
    mcpManager,
    tools: options.tools,
    permissionMode: 'bypassPermissions',
    ...(options.extensions ? { extensions: options.extensions } : {}),
    ...(options.onEvent ? { emit: options.onEvent } : {}),
  });
  return { result, modelApi, config };
}

describe('conversation extension points', () => {
  it('invokes a custom autoCompact strategy instead of the built-in', async () => {
    const invoked: string[] = [];
    const { result } = await runWith({
      tools: [],
      script: [[{ type: 'text', text: 'done.' }]],
      extensions: {
        autoCompact: async (messages, context) => {
          invoked.push(`autoCompact:${context.runKey}:${messages.length}`);
          return {
            messages: [...messages],
            compacted: false,
            tokenEstimateBefore: 1,
            tokenEstimateAfter: 1,
            messagesSummarized: 0,
            preservedMessages: messages.length,
            clearedToolResults: 0,
            reason: 'threshold_not_met',
          };
        },
      },
    });
    expect(result.stopReason).toBe('end_turn');
    expect(invoked).toHaveLength(1); // once per iteration, not the built-in
    expect(invoked[0]).toContain('autoCompact:extensions-run:1');
  });

  it('lets a custom requestError strategy switch the fallback model', async () => {
    let switched = false;
    const events: AgentEvent[] = [];
    const { result, modelApi } = await runWith({
      tools: [],
      script: [
        () => { throw new Error('upstream outage'); },
        [{ type: 'text', text: 'recovered on fallback.' }],
      ],
      extensions: {
        requestError: async (context) => {
          if (!switched && context.model === 'test-model') {
            switched = true;
            return { action: 'fallback-model', toModel: 'fallback-model' };
          }
          return { action: 'rethrow' };
        },
      },
      onEvent: (event) => { events.push(event); },
    });
    expect(result.stopReason).toBe('end_turn');
    expect(result.model).toBe('fallback-model');
    expect(modelApi.calls).toHaveLength(2);
    expect(modelApi.calls[1]!.model).toBe('fallback-model');
    expect(events.some((event) => event.type === 'model.fallback' && event.fromModel === 'test-model' && event.toModel === 'fallback-model')).toBe(true);
  });

  it('honors a custom repeatCall strategy for hard stops', async () => {
    const failing = tool<Record<string, never>, unknown>(
      { name: 'failing_tool', description: 'Always fails.', inputSchema: z.strictObject({}), isReadOnly: () => true },
      async () => { throw new Error('tool broken'); },
    );
    const recorded: string[] = [];
    const { result } = await runWith({
      tools: [failing],
      script: [[toolUse('tu_fail', 'failing_tool')]],
      extensions: {
        repeatCall: {
          record: (toolName, _input, isError) => {
            recorded.push(`${toolName}:${isError}`);
            return { hardStop: true };
          },
        },
      },
    });
    expect(recorded).toEqual(['failing_tool:true']);
    expect(result.incompleteReason).toBe('consecutive_tool_failures:failing_tool');
  });

  it('appends a custom todoReminder strategy result to the tool results', async () => {
    const read = tool(
      { name: 'read_thing', description: 'Read.', inputSchema: z.strictObject({}), isReadOnly: () => true },
      async () => 'read-result',
    );
    const { result, modelApi } = await runWith({
      tools: [read],
      script: [
        [toolUse('tu_read', 'read_thing')],
        [{ type: 'text', text: 'done.' }],
      ],
      extensions: {
        todoReminder: {
          observe: () => 'CUSTOM_TODO_REMINDER',
        },
      },
    });
    expect(result.stopReason).toBe('end_turn');
    expect(JSON.stringify(modelApi.calls[1]!.messages)).toContain('CUSTOM_TODO_REMINDER');
  });
});

describe('conversation extensions contribution', () => {
  it('registers the built-in factory through the contribution host and revokes on dispose', async () => {
    const host = new HadamardContributionHost();
    const handle = await host.load(createBuiltInConversationExtensionsContribution());
    const factory = host.getService(conversationExtensionsFactoryKey);
    expect(factory).toBeTruthy();
    const extensions = factory!();
    expect(typeof extensions.autoCompact).toBe('function');
    expect(typeof extensions.requestError).toBe('function');
    expect(typeof extensions.repeatCall.record).toBe('function');
    expect(typeof extensions.todoReminder.observe).toBe('function');
    await handle.dispose();
    expect(host.getService(conversationExtensionsFactoryKey)).toBeUndefined();
  });
});

