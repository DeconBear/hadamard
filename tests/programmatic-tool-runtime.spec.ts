import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ProgrammaticToolRuntime } from '../src/codeact/programmaticToolRuntime.js';
import { createRunCodeTool, RUN_CODE_TOOL_NAME } from '../src/codeact/runCodeTool.js';
import { resolveToolPresentation } from '../src/codeact/toolPresentation.js';
import { renderCodeActHostSdk } from '../src/codeact/codeActSdk.js';
import { tool } from '../src/runtime/tools.js';
import { executeConversation } from '../src/runtime/conversationEngine.js';
import { McpConnectionManager } from '../src/mcp/connectionManager.js';
import { resolveRuntimeConfig } from '../src/config/resolveRuntimeConfig.js';
import type { AgentEvent, AgentToolDefinition, ModelApi, ModelRequest, ToolExecutionContext } from '../src/index.js';
import type { Message, ToolUseBlock } from '../src/provider/types.js';

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

function context(cwd: string, overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: 'run-ptc',
    toolUseId: 'ptc-1',
    sessionId: 'session-ptc',
    cwd,
    metadata: {},
    prompt: 'run the program',
    iteration: 1,
    permissionMode: 'bypassPermissions',
    ...overrides,
  };
}

function echoTool(): AgentToolDefinition {
  return tool(
    {
      name: 'Echo',
      description: 'Echoes a value.',
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ echoed: z.string() }),
      isReadOnly: () => true,
    },
    async (input) => ({ echoed: input.value }),
  );
}

describe('ProgrammaticToolRuntime', () => {
  it('keeps every run stateless: no variables survive between run_code calls', async () => {
    const cwd = await tempDir('hadamard-ptc-');
    const runtime = new ProgrammaticToolRuntime({ enabled: true });
    const first = await runtime.run({
      code: 'shared_value = 41\nprint("set")',
      context: context(cwd),
      hostTools: [],
    });
    expect(first.status).toBe('completed');
    const second = await runtime.run({
      code: 'shared_value + 1',
      context: context(cwd, { toolUseId: 'ptc-2' }),
      hostTools: [],
    });
    expect(second.status).toBe('failed');
    expect(second.error).toContain('NameError');
  });

  it('returns only print/final-expression content while host dispatches stay audit-only', async () => {
    const cwd = await tempDir('hadamard-ptc-');
    const events: AgentEvent[] = [];
    const runtime = new ProgrammaticToolRuntime({ enabled: true });
    const result = await runtime.run({
      code: 'value = hadamard.tool("Echo", {"value": "through-host"})\nprint("PROGRAM_OUTPUT")\nvalue',
      context: context(cwd, { runtime: { emit: (event) => { events.push(event); } } }),
      hostTools: [echoTool()],
    });
    expect(result.status).toBe('completed');
    expect(result.stdout).toContain('PROGRAM_OUTPUT');
    expect(result.result?.value).toEqual({ echoed: 'through-host' });
    // Sub-dispatch produced structured audit events (transcript-only); the
    // model-visible result is just the outer program output.
    const dispatches = events.filter((event) => event.type === 'tool.code_dispatch');
    expect(dispatches).toHaveLength(2); // start + settle for the Echo sub-call
  });

  it('routes nested host calls through the same permission decision path', async () => {
    const cwd = await tempDir('hadamard-ptc-');
    const events: AgentEvent[] = [];
    const runtime = new ProgrammaticToolRuntime({ enabled: true });
    const result = await runtime.run({
      code: 'hadamard.tool("Echo", {"value": "denied"})',
      context: context(cwd, {
        toolUseId: 'ptc-denied',
        permissionMode: 'default',
        permissions: [{ toolName: 'Echo', behavior: 'deny' }],
        runtime: { emit: (event) => { events.push(event); } },
      }),
      hostTools: [echoTool()],
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Denied by permission rule Echo');
    expect(events.some((event) => event.type === 'tool.permission')).toBe(true);
  });

  it('exposes run_code as a destructive, interruptible wire tool', () => {
    const runtime = new ProgrammaticToolRuntime({ enabled: true });
    const definition = createRunCodeTool({ service: runtime, hostTools: [echoTool()] });
    expect(definition.name).toBe(RUN_CODE_TOOL_NAME);
    expect(definition.isDestructive?.()).toBe(true);
    expect(definition.interruptBehavior).toBe('cancel');
  });
});

describe('resolveToolPresentation', () => {
  it('keeps native as the exact current wire shape', async () => {
    const mcpManager = new McpConnectionManager({ name: 'test', version: '0' });
    const resolved = await mcpManager.resolveToolAdapters([echoTool()], [], { timeoutMs: 5_000 });
    const plan = resolveToolPresentation({ mode: 'native', resolvedTools: resolved, sdkTools: [echoTool()] });
    expect(plan.providerTools).toHaveLength(1);
    expect(plan.instructions).toBe('');
    expect(plan.sdk).toBe('');
  });

  it('presents only the run_code wire tool in ptc mode', async () => {
    const mcpManager = new McpConnectionManager({ name: 'test', version: '0' });
    const runtime = new ProgrammaticToolRuntime({ enabled: true });
    const wire = createRunCodeTool({ service: runtime, hostTools: [echoTool()] });
    const resolved = await mcpManager.resolveToolAdapters([echoTool(), wire], [], { timeoutMs: 5_000 });
    const plan = resolveToolPresentation({ mode: 'ptc', resolvedTools: resolved, sdkTools: [echoTool(), wire] });
    expect(plan.wireToolName).toBe('run_code');
    expect(plan.providerTools).toHaveLength(1);
    expect((plan.providerTools[0] as { name?: string }).name).toBe('run_code');
    expect(plan.sdk).toContain('def Echo(');
    expect(plan.sdk).not.toContain('def run_code');
    expect(plan.instructions).toContain('fresh, stateless');
  });

  it('presents every tool plus run_code in both mode', async () => {
    const mcpManager = new McpConnectionManager({ name: 'test', version: '0' });
    const runtime = new ProgrammaticToolRuntime({ enabled: true });
    const wire = createRunCodeTool({ service: runtime, hostTools: [echoTool()] });
    const resolved = await mcpManager.resolveToolAdapters([echoTool(), wire], [], { timeoutMs: 5_000 });
    const plan = resolveToolPresentation({ mode: 'both', resolvedTools: resolved, sdkTools: [echoTool(), wire] });
    expect(plan.providerTools.map((entry) => (entry as { name?: string }).name).sort()).toEqual(['Echo', 'run_code']);
  });

  it('fails closed when ptc mode has no run_code tool registered', async () => {
    const mcpManager = new McpConnectionManager({ name: 'test', version: '0' });
    const resolved = await mcpManager.resolveToolAdapters([echoTool()], [], { timeoutMs: 5_000 });
    expect(() => resolveToolPresentation({ mode: 'ptc', resolvedTools: resolved, sdkTools: [echoTool()] }))
      .toThrow(/run_code/);
  });
});

describe('PTC end-to-end engine run', () => {
  function makeMessage(content: unknown[], stopReason: 'tool_use' | 'end_turn'): Message {
    messageId += 1;
    return {
      id: `ptc-message-${messageId}`,
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: content as Message['content'],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as Message;
  }
  class QueueModel implements ModelApi {
    readonly calls: ModelRequest[] = [];
    private index = 0;
    constructor(private readonly responses: unknown[][]) {}
    async createMessage(request: ModelRequest): Promise<Message> {
      this.calls.push(structuredClone(request));
      const content = this.responses[Math.min(this.index, this.responses.length - 1)]!;
      this.index += 1;
      const hasToolUse = content.some((block) => (block as { type?: string }).type === 'tool_use');
      return makeMessage(content, hasToolUse ? 'tool_use' : 'end_turn');
    }
    streamMessage(): never {
      throw new Error('not used');
    }
  }

  it('executes a run_code program whose sub-calls never enter model history', async () => {
    const homeDir = await tempDir('hadamard-ptc-home-');
    const workDir = await tempDir('hadamard-ptc-work-');
    const sessionDirectory = await tempDir('hadamard-ptc-sessions-');
    const runtime = new ProgrammaticToolRuntime({ enabled: true });
    const wire = createRunCodeTool({ service: runtime, hostTools: [echoTool()] });
    const modelApi = new QueueModel([
      [{ type: 'tool_use', id: 'ptc_call', name: 'run_code', input: { code: 'hadamard.tool("Echo", {"value": "inner"})' } } as ToolUseBlock],
      [{ type: 'text', text: 'program finished.' }],
    ]);
    const config = await resolveRuntimeConfig({
      model: 'test-model',
      modelApi,
      homeDir,
      workDir,
      sessionDirectory,
      baseURL: 'https://example.invalid/v1',
    });
    const mcpManager = new McpConnectionManager({ name: 'test', version: '0' });
    const events: AgentEvent[] = [];
    const result = await executeConversation({
      runId: 'ptc-e2e',
      input: 'Compose a program.',
      model: 'test-model',
      streaming: false,
      modelApi,
      config,
      mcpManager,
      tools: [echoTool(), wire],
      toolPresentation: 'ptc',
      permissionMode: 'bypassPermissions',
      emit: (event) => { events.push(event); },
    });
    expect(result.stopReason).toBe('end_turn');
    // Only the run_code wire tool was offered to the provider.
    const firstWire = modelApi.calls[0]!.tools ?? [];
    expect(firstWire.map((entry) => (entry as { name?: string }).name)).toEqual(['run_code']);
    // The nested Echo result is inside the outer tool_result only.
    const serialized = JSON.stringify(result.messages);
    // The pretty-printed outer result is embedded as an escaped string.
    expect(serialized).toContain('\\"echoed\\"');
    expect(events.filter((event) => event.type === 'tool.code_dispatch')).toHaveLength(2);
    // The PTC instructions + typed SDK rode the system prompt.
    expect(JSON.stringify(modelApi.calls[0]!.system)).toContain('fresh, stateless');
  });
});

