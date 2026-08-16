import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ToolPolicyPipeline,
  createBuiltInToolPolicyPipeline,
  tool,
  type AgentEvent,
  type ExecuteConversationOptions,
  type ToolPolicyCall,
  type ToolPrePolicyListener,
} from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-tool-policy-'));
  tempDirs.push(directory);
  return directory;
}

function baseOptions(workDir: string, overrides: Partial<ExecuteConversationOptions> = {}): ExecuteConversationOptions {
  return {
    runId: 'run-policy',
    sessionId: 'session-policy',
    input: 'probe',
    streaming: false,
    workDir,
    config: {
      workDir,
      compact: { toolResultArtifactMaxChars: 80_000 },
    } as ExecuteConversationOptions['config'],
    ...overrides,
  } as ExecuteConversationOptions;
}

function policyCall(workDir: string, adapter: ToolPolicyCall['adapter'], overrides: Partial<ToolPolicyCall> = {}): ToolPolicyCall {
  return {
    iteration: 1,
    toolUseId: 'tu-1',
    toolName: adapter.sourceName,
    publicName: adapter.publicName,
    input: { value: 'probe' },
    adapter,
    workDir,
    prompt: 'probe prompt',
    ...overrides,
  };
}


describe('ToolPolicyPipeline built-ins', () => {
  it('denies through the permission listener and emits the permission decision', async () => {
    const cwd = await workspace();
    const adapter = createAdapter('Probe', { value: z.string() }, () => ({ ok: true }), true);
    const events: AgentEvent[] = [];
    const decisions: unknown[] = [];
    const pipeline = createBuiltInToolPolicyPipeline(baseOptions(cwd, {
      permissionMode: 'default',
      permissions: [{ toolName: 'Probe', behavior: 'deny' }],
      emit: (event: AgentEvent) => events.push(event),
    }));
    const state = await pipeline.runPre(policyCall(cwd, adapter, { onPermissionDecision: (decision) => decisions.push(decision) }));
    expect(state.behavior).toBe('deny');
    expect(state.decision?.behavior).toBe('deny');
    expect(decisions).toHaveLength(1);
    expect(events.some((event) => event.type === 'tool.permission')).toBe(true);
  });

  it('allows read-only tools and threads the updated input through', async () => {
    const cwd = await workspace();
    const adapter = createAdapter('Probe', { value: z.string() }, () => ({ ok: true }), true);
    const pipeline = createBuiltInToolPolicyPipeline(baseOptions(cwd, { permissionMode: 'bypassPermissions' }));
    const state = await pipeline.runPre(policyCall(cwd, adapter));
    expect(state.behavior).toBe('allow');
    expect(state.decision).toBeDefined();
  });
});

describe('ToolPolicyPipeline composition', () => {
  it('keeps deny monotonic: a denied call never reaches a later listener', async () => {
    const cwd = await workspace();
    const adapter = createAdapter('Probe', { value: z.string() }, () => ({ ok: true }), true);
    let laterRan = false;
    const denyFirst: ToolPrePolicyListener = async (_call, state) => {
      state.behavior = 'deny';
      state.reason = 'refused by first listener';
    };
    const later: ToolPrePolicyListener = async () => { laterRan = true; };
    const pipeline = new ToolPolicyPipeline([denyFirst, later], []);
    const state = await pipeline.runPre(policyCall(cwd, adapter));
    expect(state.behavior).toBe('deny');
    expect(state.reason).toContain('refused by first');
    expect(laterRan).toBe(false);
  });

  it('lets a custom pre listener rewrite the input before the permission listener', async () => {
    const cwd = await workspace();
    const adapter = createAdapter('Probe', { value: z.string() }, () => ({ ok: true }), true);
    const rewriter: ToolPrePolicyListener = async (_call, state) => {
      state.updatedInput = { value: 'rewritten' };
    };
    const builtIn = createBuiltInToolPolicyPipeline(baseOptions(cwd, { permissionMode: 'bypassPermissions' }));
    const pipeline = new ToolPolicyPipeline([rewriter, ...builtIn.pre], builtIn.post);
    const state = await pipeline.runPre(policyCall(cwd, adapter));
    expect(state.behavior).toBe('allow');
    expect(state.updatedInput).toEqual({ value: 'rewritten' });
  });

  it('post waterfall: a block listener turns the result into a block decision', async () => {
    const cwd = await workspace();
    const adapter = createAdapter('Probe', { value: z.string() }, () => ({ ok: true }), true);
    const pipeline = new ToolPolicyPipeline([], [
      async (_call, _execution, next) => {
        await next();
        return { kind: 'block', reason: 'post-listener refused' };
      },
    ]);
    const decision = await pipeline.runPost(
      policyCall(cwd, adapter),
      { content: 'result text', text: 'result text', rawOutput: { ok: true } },
    );
    expect(decision.kind).toBe('block');
  });

  it('post waterfall: built-in spill shapes oversized accepted content', async () => {
    const cwd = await workspace();
    const adapter = createAdapter('Probe', { value: z.string() }, () => ({ ok: true }), true, 200);
    const pipeline = createBuiltInToolPolicyPipeline(baseOptions(cwd, { permissionMode: 'bypassPermissions' }));
    const big = 'x'.repeat(2_000);
    const decision = await pipeline.runPost(
      policyCall(cwd, adapter),
      { content: big, text: big, rawOutput: big },
    );
    expect(decision.kind).toBe('accept');
    const contentText = decision.kind === 'accept' && typeof decision.content === 'string' ? decision.content : '';
    expect(contentText.length).toBeLessThan(600);
    expect(contentText).toContain('Full output saved to:');
  });
});

function createAdapter(
  name: string,
  schema: unknown,
  execute: (input: unknown) => unknown,
  readOnly: boolean,
  maxResultSizeChars?: number,
) {
  const definition = tool(
    {
      name,
      description: name + ' tool.',
      inputSchema: z.object(schema as Record<string, z.ZodType>),
      isReadOnly: () => readOnly,
      ...(maxResultSizeChars !== undefined ? { maxResultSizeChars } : {}),
    },
    async (input) => execute(input),
  );
  const adapter = {
    publicName: name,
    sourceName: name,
    provider: 'local' as const,
    providerTool: { name, description: definition.description, input_schema: definition.inputJsonSchema },
    execute: async (input: unknown) => ({ content: JSON.stringify(input), text: JSON.stringify(input), rawOutput: input }),
    isReadOnly: definition.isReadOnly,
    isDestructive: definition.isDestructive,
    isPlanReadOnly: definition.isPlanReadOnly,
    requiresUserInteraction: definition.requiresUserInteraction,
    checkPermissions: definition.checkPermissions,
    ...(definition.maxResultSizeChars !== undefined ? { maxResultSizeChars: definition.maxResultSizeChars } : {}),
  };
  return adapter as ToolPolicyCall['adapter'];
}

