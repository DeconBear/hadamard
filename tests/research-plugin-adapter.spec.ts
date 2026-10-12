import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { CodeActArtifactRecorder } from '../src/codeact/codeActArtifacts.js';
import { CodeActHostRpcDispatcher } from '../src/codeact/hostRpcDispatcher.js';
import { adaptResearchPluginTool, createResearchTextStatsTool, researchPluginEvidenceSchema } from '../src/research/pluginAdapter.js';
import { createLocalToolAdapter, tool } from '../src/runtime/tools.js';
import type { ToolExecutionContext } from '../src/types.js';

const plugin = { id: 'test.research', version: '1.0.0', adapter: 'explicit-tool' as const };

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: 'research-test',
    toolUseId: 'call-1',
    cwd: process.cwd(),
    metadata: {},
    prompt: 'Inspect test evidence.',
    iteration: 1,
    ...overrides,
  };
}

function testTool(execute = vi.fn(() => ({ answer: 42 }))) {
  return tool({
    name: 'ResearchTest',
    description: 'Test tool.',
    inputSchema: z.object({ query: z.string() }).strict(),
    outputSchema: z.object({ answer: z.number() }).strict(),
    isReadOnly: () => true,
    isDestructive: () => false,
    isConcurrencySafe: () => true,
    checkPermissions: () => 'ask',
    aliases: ['ResearchTestAlias'],
    interruptBehavior: 'cancel',
    isResultTruncated: output => output.answer > 10,
  }, execute);
}

describe('research plugin tool adapter', () => {
  it('retains the original permission, validation and scheduling metadata', () => {
    const original = testTool();
    const adapted = adaptResearchPluginTool({ plugin, tool: original });
    expect(adapted.name).toBe(original.name);
    expect(adapted.inputSchema).toBe(original.inputSchema);
    expect(adapted.inputJsonSchema).toBe(original.inputJsonSchema);
    expect(adapted.isReadOnly).toBe(original.isReadOnly);
    expect(adapted.isDestructive).toBe(original.isDestructive);
    expect(adapted.isConcurrencySafe).toBe(original.isConcurrencySafe);
    expect(adapted.checkPermissions).toBe(original.checkPermissions);
    expect(adapted.interruptBehavior).toBe(original.interruptBehavior);
    expect(adapted.aliases).toEqual(original.aliases);
  });

  it('returns serializable untrusted provenance through the existing local adapter', async () => {
    const adapted = adaptResearchPluginTool({ plugin, tool: testTool() });
    const execution = await createLocalToolAdapter(adapted).execute({ query: 'test' }, context());
    const result = JSON.parse(execution.text);
    expect(result.value).toEqual({ answer: 42 });
    expect(researchPluginEvidenceSchema.parse(result.evidence)).toMatchObject({
      schemaVersion: 1,
      kind: 'tool-output',
      trust: 'untrusted',
      plugin,
      toolName: 'ResearchTest',
      runId: 'research-test',
      toolUseId: 'call-1',
    });
    expect(result.evidence.outputSha256).toBe(createHash('sha256').update('{"answer":42}').digest('hex'));
    expect(adapted.isResultTruncated?.(result)).toBe(true);
    await expect(adapted.outputSchema?.parseAsync(result)).resolves.toEqual(result);
  });

  it('keeps input validation and validates the original output schema', async () => {
    const execute = vi.fn(() => ({ answer: 42 }));
    const original = testTool(execute);
    const adapted = adaptResearchPluginTool({ plugin, tool: original });
    await expect(createLocalToolAdapter(adapted).execute({ query: 3 }, context())).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    original.outputSchema = z.object({ answer: z.number().max(10) });
    await expect(createLocalToolAdapter(adapted).execute({ query: 'test' }, context())).rejects.toThrow();
  });

  it('does not execute a denied call in the shared CodeAct permission path', async () => {
    const execute = vi.fn(() => ({ answer: 42 }));
    const adapted = adaptResearchPluginTool({ plugin, tool: testTool(execute) });
    const dispatcher = new CodeActHostRpcDispatcher([adapted], context({
      permissions: [{ toolName: 'ResearchTest', behavior: 'deny' }],
    }), new CodeActArtifactRecorder(), 'test-session');
    const result = await dispatcher.dispatch({
      id: 'request-1', method: 'tool.call', input: { name: adapted.name, input: { query: 'test' } },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Denied by permission rule');
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not promote an unclassified tool to read-only', () => {
    const original = tool({ name: 'Unclassified', description: 'Unknown effects.', inputSchema: z.object({}) }, () => null);
    const adapted = adaptResearchPluginTool({ plugin, tool: original });
    expect(adapted.isReadOnly).toBeUndefined();
    expect(adapted.isDestructive).toBeUndefined();
    expect(adapted.isConcurrencySafe).toBeUndefined();
  });

  it('returns the same evidence envelope through ordinary CodeAct host dispatch', async () => {
    const definition = createResearchTextStatsTool();
    const dispatcher = new CodeActHostRpcDispatcher([definition], context(), new CodeActArtifactRecorder(), 'test-session');
    const result = await dispatcher.dispatch({
      id: 'request-2', method: 'tool.call', input: { name: definition.name, input: { text: 'offline' } },
    });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      value: { characters: 7, utf8Bytes: 7, lines: 1 },
      evidence: { trust: 'untrusted', runId: 'research-test', toolName: definition.name },
    });
  });

  it('passes context, progress and turn control through unchanged', async () => {
    const ctx = context({ deferAdditionalContext: vi.fn(), concludeTurn: vi.fn() });
    const progress = vi.fn();
    const original = testTool();
    original.execute = vi.fn((_input, received, onProgress) => {
      expect(received).toBe(ctx);
      expect(onProgress).toBe(progress);
      received.deferAdditionalContext?.({ type: 'text', text: 'Tool data.' });
      received.concludeTurn?.();
      return { answer: 42 };
    });
    const adapted = adaptResearchPluginTool({ plugin, tool: original });
    await adapted.execute({ query: 'test' }, ctx, progress);
    expect(ctx.deferAdditionalContext).toHaveBeenCalledOnce();
    expect(ctx.concludeTurn).toHaveBeenCalledOnce();
  });

  it('rejects already cancelled calls before executing and cancellation before evidence', async () => {
    const controller = new AbortController();
    const execute = vi.fn(() => ({ answer: 42 }));
    const adapted = adaptResearchPluginTool({ plugin, tool: testTool(execute) });
    controller.abort(new Error('cancelled'));
    await expect(adapted.execute({ query: 'test' }, context({ signal: controller.signal }))).rejects.toThrow('cancelled');
    expect(execute).not.toHaveBeenCalled();

    const later = new AbortController();
    const original = testTool(vi.fn(() => {
      later.abort(new Error('cancelled while executing'));
      return { answer: 42 };
    }));
    await expect(adaptResearchPluginTool({ plugin, tool: original }).execute({ query: 'test' }, context({ signal: later.signal }))).rejects.toThrow('cancelled while executing');
  });

  it.each([NaN, undefined, { hidden: undefined }, new Date(0)])('rejects lossy JSON output %j', async output => {
    const original = tool({ name: 'InvalidJson', description: 'Test.', inputSchema: z.object({}) }, () => output);
    await expect(adaptResearchPluginTool({ plugin, tool: original }).execute({}, context())).rejects.toThrow('finite, acyclic JSON');
  });

  it('does not turn tool failures into successful evidence', async () => {
    const original = tool({ name: 'Failure', description: 'Test.', inputSchema: z.object({}) }, () => { throw new Error('tool failed'); });
    await expect(adaptResearchPluginTool({ plugin, tool: original }).execute({}, context())).rejects.toThrow('tool failed');
  });

  it('hashes object key order consistently and snapshots output and descriptor', async () => {
    const output = { z: 2, a: 1 };
    const descriptor = { ...plugin };
    const original = tool({ name: 'Snapshot', description: 'Test.', inputSchema: z.object({}) }, () => output);
    const adapted = adaptResearchPluginTool({ plugin: descriptor, tool: original });
    descriptor.version = 'changed';
    const first = await adapted.execute({}, context());
    output.z = 99;
    expect(first.value).toEqual({ z: 2, a: 1 });
    expect(first.evidence.plugin.version).toBe('1.0.0');
    const reordered = tool({ name: 'Snapshot', description: 'Test.', inputSchema: z.object({}) }, () => ({ a: 1, z: 2 }));
    const second = await adaptResearchPluginTool({ plugin, tool: reordered }).execute({}, context());
    expect(first.evidence.outputSha256).toBe(second.evidence.outputSha256);
  });

  it('validates identity before running supplied code', async () => {
    expect(() => adaptResearchPluginTool({ plugin: { ...plugin, id: '../bad' }, tool: testTool() })).toThrow();
    const execute = vi.fn(() => ({ answer: 42 }));
    const adapted = adaptResearchPluginTool({ plugin, tool: testTool(execute) });
    await expect(adapted.execute({ query: 'test' }, context({ runId: '' }))).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('provides a bounded deterministic offline builtin without model keys', async () => {
    const definition = createResearchTextStatsTool();
    const adapter = createLocalToolAdapter(definition);
    const result = await adapter.execute({ text: 'a\r\n🐻' }, context());
    expect(result.rawOutput).toMatchObject({ value: { characters: 4, utf8Bytes: 7, lines: 2 }, evidence: { plugin: { adapter: 'builtin' } } });
    const repeated = await adapter.execute({ text: 'a\r\n🐻' }, context());
    expect(repeated.rawOutput).toEqual(result.rawOutput);
    await expect(adapter.execute({ text: 'a'.repeat(65_537) }, context())).rejects.toThrow();
    expect((await adapter.execute({ text: '' }, context())).rawOutput).toMatchObject({ value: { characters: 0, utf8Bytes: 0, lines: 0 } });
  });
});
