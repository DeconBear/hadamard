import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CodeActService, tool, type AgentEvent, type ToolExecutionContext } from '../src/index.js';

const tempDirs: string[] = [];
const services: CodeActService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(instance => instance.close()));
  await Promise.all(tempDirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-codeact-tx-'));
  tempDirs.push(directory);
  return directory;
}

function context(
  cwd: string,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    runId: 'run-tx',
    toolUseId: 'cell-1',
    sessionId: 'session-tx',
    cwd,
    metadata: {},
    prompt: 'run the computation',
    iteration: 1,
    permissionMode: 'bypassPermissions',
    ...overrides,
  };
}

function service(extra: Partial<ConstructorParameters<typeof CodeActService>[0]> = {}): CodeActService {
  const instance = new CodeActService({
    enabled: true,
    pythonCommand: process.platform === 'win32' ? 'python' : 'python3',
    executionTimeoutMs: 5_000,
    idleTimeoutMs: 30_000,
    ...extra,
  });
  services.push(instance);
  return instance;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for CodeAct kernel state.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('CodeAct transaction and budget contract', () => {
  it('awaits started host calls before the outer result lands (drain before settle)', async () => {
    const cwd = await workspace();
    const instance = service();
    let toolDone = false;
    const slow = tool(
      {
        name: 'Slow',
        description: 'A slow read.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
      },
      async () => {
        await new Promise(resolve => setTimeout(resolve, 120));
        toolDone = true;
        return { done: true };
      },
    );
    const events: AgentEvent[] = [];
    const result = await instance.execute({
      language: 'python',
      code: 'hadamard.tool("Slow", {})',
      context: context(cwd, { runtime: { emit: event => events.push(event) } }),
      hostTools: [slow],
    });
    expect(result.status).toBe('completed');
    // The outer result resolved only after the started nested call finished.
    expect(toolDone).toBe(true);
    // The settle audit event precedes the completed-cell event: the outer
    // tool result is the cell's last execution event.
    const settle = events.find(event => event.type === 'tool.code_dispatch' && event.phase === 'settle');
    const completed = events.find(event => event.type === 'code_cell.completed');
    expect(settle).toBeTruthy();
    expect(completed).toBeTruthy();
    expect(Date.parse(settle!.timestamp)).toBeLessThanOrEqual(Date.parse(completed!.timestamp));
  });

  it('drains a slow exclusive mutating tool before the outer result lands', async () => {
    const cwd = await workspace();
    const instance = service();
    let writeDone = false;
    const write = tool(
      {
        name: 'write_state',
        description: 'A mutating write.',
        inputSchema: z.strictObject({}),
        isConcurrencySafe: () => false,
      },
      async () => {
        await new Promise(resolve => setTimeout(resolve, 120));
        writeDone = true;
        return { done: true };
      },
    );
    const result = await instance.execute({
      language: 'python',
      code: 'hadamard.write_state()',
      context: context(cwd),
      hostTools: [write],
    });
    expect(result.status).toBe('completed');
    expect(writeDone).toBe(true);
  });

  it('turns an oversized final result into a single output-limit failure', async () => {
    const cwd = await workspace();
    const instance = service({ maxOutputChars: 4_000, maxOutputBytes: 2_000 });
    const result = await instance.execute({
      language: 'python',
      code: '"z" * 200_000',
      context: context(cwd),
    });
    expect(result.status).toBe('failed');
    expect(result.failureKind).toBe('output-limit');
    expect(result.outputLimit).toBe(true);
    expect(result.stateLost).toBe(true);
    expect(result.error).toContain('output budget');
  });

  it('hard-stops an unbounded stdout loop with one output-limit failure', async () => {
    const cwd = await workspace();
    const instance = service({ maxOutputBytes: 4_000 });
    const result = await instance.execute({
      language: 'python',
      code: [
        'import time',
        'while True:',
        '    print("z" * 1_000)',
        '    time.sleep(0.005)',
      ].join('\n'),
      timeoutMs: 5_000,
      context: context(cwd, { toolUseId: 'loop-cell' }),
    });
    expect(result.status).toBe('failed');
    expect(result.failureKind).toBe('output-limit');
    expect(result.stateLost).toBe(true);
  });

  it('cancellation aborts started nested tools and drains before settling interrupted', async () => {
    const cwd = await workspace();
    const instance = service();
    const controller = new AbortController();
    let nestedAborted = false;
    const slow = tool(
      {
        name: 'Slow',
        description: 'Waits until aborted.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
      },
      async () => ({ done: true }),
    );
    let nestedStarted = false;
    const running = instance.execute({
      language: 'python',
      code: 'hadamard.tool("Slow", {})',
      context: context(cwd, {
        signal: controller.signal,
        runtime: {
          executeTool: async (definition, input, execution) => new Promise((resolve) => {
            nestedStarted = true;
            execution.signal?.addEventListener('abort', () => {
              nestedAborted = true;
              resolve({
                id: execution.toolUseId,
                name: definition.name,
                publicName: definition.name,
                provider: 'local',
                input,
                outputText: 'aborted',
                output: { aborted: true },
                isError: true,
                startedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                durationMs: 0,
              });
            }, { once: true });
          }),
        },
      }),
      hostTools: [slow],
    });
    // Abort only after the nested tool really started, so the test covers
    // the in-flight-abort path (not the pre-dispatch guard).
    await waitUntil(() => nestedStarted);
    controller.abort(new Error('user cancelled'));
    const result = await running;
    expect(result.status).toBe('interrupted');
    expect(result.failureKind).toBe('interrupt');
    expect(nestedAborted).toBe(true);
  });

  it('rejects an oversized host request at the kernel precheck as output-limit, not a protocol crash', async () => {
    const cwd = await workspace();
    const instance = service({ maxOutputBytes: 40_000_000 });
    const echo = tool(
      {
        name: 'Echo',
        description: 'Echoes a value.',
        inputSchema: z.strictObject({ value: z.string() }),
        isReadOnly: () => true,
      },
      async input => ({ length: input.value.length }),
    );
    const result = await instance.execute({
      language: 'python',
      code: 'hadamard.tool("Echo", {"value": "z" * 2_000_000})',
      context: context(cwd),
      hostTools: [echo],
    });
    expect(result.status).toBe('failed');
    expect(result.failureKind).toBe('output-limit');
    expect(result.error).toContain('protocol payload limit');
  });

  it('shrinks an oversized host response instead of breaching the decoder line limit', async () => {
    const cwd = await workspace();
    const instance = service({ maxOutputBytes: 40_000_000 });
    const big = tool(
      {
        name: 'Big',
        description: 'Returns a huge payload.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
      },
      async () => 'z'.repeat(2_000_000),
    );
    const result = await instance.execute({
      language: 'python',
      code: 'hadamard.tool("Big", {})',
      context: context(cwd),
      hostTools: [big],
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('protocol line limit');
    // The kernel survives a host-side line shrink: same generation next cell.
    const recovered = await instance.execute({
      language: 'python',
      code: '21 * 2',
      context: context(cwd, { toolUseId: 'after-big', iteration: 2 }),
    });
    expect(recovered.status).toBe('completed');
    expect(recovered.result?.value).toBe(42);
    expect(recovered.generation).toBe(result.generation);
  });

  it('answers on-demand schema queries through hadamard.tool_schema', async () => {
    const cwd = await workspace();
    const instance = service();
    const echo = tool(
      {
        name: 'Echo',
        description: 'Echoes a value.',
        inputSchema: z.strictObject({ value: z.string() }),
        isReadOnly: () => true,
      },
      async input => ({ echoed: input.value }),
    );
    const result = await instance.execute({
      language: 'python',
      code: 'hadamard.tool_schema("Echo")',
      context: context(cwd),
      hostTools: [echo],
    });
    expect(result.status).toBe('completed');
    expect(result.result?.value).toMatchObject({ name: 'Echo' });
    const schema = (result.result?.value as { inputJsonSchema?: Record<string, unknown> } | undefined)?.inputJsonSchema;
    expect(schema?.properties).toMatchObject({ value: { type: 'string' } });
  });
});
