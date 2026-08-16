import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ProgrammaticToolRuntime,
  WorkerThreadCodeRuntime,
  renderTsHostSdk,
  sanitizeTsName,
  tool,
  type ToolExecutionContext,
} from '../src/index.js';

function context(cwd: string, overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: 'run-ts',
    toolUseId: 'cell-1',
    sessionId: 'session-ts',
    cwd,
    metadata: {},
    prompt: 'run a program',
    iteration: 1,
    permissionMode: 'bypassPermissions',
    ...overrides,
  };
}

describe('WorkerThreadCodeRuntime', () => {
  it('runs a type-annotated TypeScript program and returns the completion value with logs', async () => {
    const runtime = new WorkerThreadCodeRuntime();
    try {
      const result = await runtime.run({
        program: 'const a: number = 21;\nconsole.log("step", a);\nconst b = a * 2;\nreturn b;',
        bindings: [],
      });
      expect(result.error).toBeUndefined();
      expect(result.value).toBe(42);
      expect(result.logs).toEqual(['step 21']);
    } finally {
      await runtime.close();
    }
  });

  it('bridges binding calls with lossless JSON arguments', async () => {
    const runtime = new WorkerThreadCodeRuntime();
    const seen: unknown[] = [];
    try {
      const result = await runtime.run({
        program: 'const first = await tools.Weather({ city: "hangzhou", units: "c" });\nreturn { first: first, count: 1 };',
        bindings: [
          {
            global: 'tools',
            functions: {
              Weather: async (args) => {
                seen.push(args);
                return { temperature: 21 };
              },
            },
          },
        ],
      });
      expect(result.error).toBeUndefined();
      expect(seen).toEqual([{ city: 'hangzhou', units: 'c' }]);
      expect(result.value).toEqual({ first: { temperature: 21 }, count: 1 });
    } finally {
      await runtime.close();
    }
  });

  it('rejects binding failures as ToolCallError carrying the tool name', async () => {
    const runtime = new WorkerThreadCodeRuntime();
    try {
      const result = await runtime.run({
        program: [
          'try {',
          '  await tools.Failing({});',
          '  return "unreachable";',
          '} catch (error) {',
          '  return { name: error.name, toolName: error.toolName };',
          '}',
        ].join('\n'),
        bindings: [
          {
            global: 'tools',
            functions: {
              Failing: async () => { throw new Error('boom'); },
            },
            errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
          },
        ],
      });
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual({ name: 'ToolCallError', toolName: 'Failing' });
    } finally {
      await runtime.close();
    }
  });

  it('fails a non-JSON completion as invalid-output', async () => {
    const runtime = new WorkerThreadCodeRuntime();
    try {
      const result = await runtime.run({
        program: 'return () => 42;',
        bindings: [],
      });
      expect(result.error?.kind).toBe('invalid-output');
      expect(result.error?.message).toContain('lossless JSON');
    } finally {
      await runtime.close();
    }
  });

  it('expires a hot loop on the measured compute budget', async () => {
    const runtime = new WorkerThreadCodeRuntime({ computeMs: 200, maxWallMs: 30_000 });
    try {
      const result = await runtime.run({
        program: 'while (true) {}',
        bindings: [],
      });
      expect(result.error?.kind).toBe('timeout');
      expect(result.error?.message).toContain('compute budget');
    } finally {
      await runtime.close();
    }
  }, 30_000);

  it('expires an unresolved promise on the wall-clock ceiling', async () => {
    const runtime = new WorkerThreadCodeRuntime({ computeMs: 30_000, maxWallMs: 300 });
    try {
      const result = await runtime.run({
        program: 'await new Promise(() => {});',
        bindings: [],
      });
      expect(result.error?.kind).toBe('timeout');
      expect(result.error?.message).toContain('wall-clock');
    } finally {
      await runtime.close();
    }
  }, 30_000);

  it('turns an oversized log stream into one output-limit failure', async () => {
    const runtime = new WorkerThreadCodeRuntime({ maxOutputBytes: 500 });
    try {
      const result = await runtime.run({
        program: 'console.log("z".repeat(10_000));',
        bindings: [],
      });
      expect(result.error?.kind).toBe('output-limit');
    } finally {
      await runtime.close();
    }
  });

  it('stops on abort with kind abort', async () => {
    const runtime = new WorkerThreadCodeRuntime({ computeMs: 30_000, maxWallMs: 30_000 });
    try {
      const controller = new AbortController();
      const running = runtime.run({
        program: 'await new Promise(() => {});',
        bindings: [],
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      controller.abort('user stopped');
      const result = await running;
      expect(result.error?.kind).toBe('abort');
    } finally {
      await runtime.close();
    }
  }, 30_000);

  it('reports worker-exit when the program exits the process', async () => {
    const runtime = new WorkerThreadCodeRuntime();
    try {
      const result = await runtime.run({
        program: 'process.exit(3);',
        bindings: [],
      });
      expect(result.error?.kind).toBe('worker-exit');
    } finally {
      await runtime.close();
    }
  });

  it('rejects reserved binding globals and invalid error members', async () => {
    const runtime = new WorkerThreadCodeRuntime();
    try {
      await expect(runtime.run({
        program: 'return 1;',
        bindings: [{ global: 'console', functions: {} }],
      })).rejects.toThrow(/reserved binding global/);
      await expect(runtime.run({
        program: 'return 1;',
        bindings: [{ global: 'tools', functions: {}, errorClass: { name: 'ToolCallError', memberNameProperty: 'stack' } }],
      })).rejects.toThrow(/error member property/);
    } finally {
      await runtime.close();
    }
  });
});

describe('TS SDK renderer and PTC typescript arm', () => {
  it('renders a typed, sorted, sanitized tools block', () => {
    const echo = tool(
      {
        name: 'Echo',
        description: 'Echoes a value.',
        inputSchema: z.strictObject({ value: z.string(), times: z.number().int().optional() }),
        outputSchema: z.object({ echoed: z.string() }),
        isReadOnly: () => true,
      },
      async (input) => ({ echoed: input.value }),
    );
    const sdk = renderTsHostSdk([echo]);
    expect(sdk).toContain('declare const tools:');
    expect(sdk).toContain('Echo(args: { value: string; times?: number; }): Promise<{ echoed: string; }>;');
    expect(sdk).toContain('ToolCallError');
    expect(sanitizeTsName('my-tool')).toBe('my_tool');
    expect(sanitizeTsName('class')).toBe('class_');
  });

  it('runs a TypeScript run_code program through the PTC service with a nested host tool', async () => {
    const echo = tool(
      {
        name: 'Echo',
        description: 'Echoes a value.',
        inputSchema: z.strictObject({ value: z.string() }),
        isReadOnly: () => true,
      },
      async (input) => ({ echoed: input.value }),
    );
    const service = new ProgrammaticToolRuntime({ enabled: true, ptcBackend: 'worker-thread' });
    expect(service.language).toBe('typescript');
    const result = await service.run({
      code: 'const r = await tools.Echo({ value: "nested" });\nconsole.log("ok");\nreturn r;',
      context: context(process.cwd(), {
        runtime: {
          executeTool: async (definition, input, execution) => ({
            record: {
              id: execution.toolUseId,
              name: definition.name,
              publicName: definition.name,
              provider: 'local',
              input,
              outputText: JSON.stringify({ echoed: (input as { value: string }).value }),
              output: { echoed: (input as { value: string }).value },
              isError: false,
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: 0,
            },
          }),
        },
      }),
      hostTools: [echo],
    });
    expect(result.status).toBe('completed');
    expect(result.stdout).toContain('ok');
    expect(result.result?.value).toEqual({ echoed: 'nested' });
  });

  it('rejects enforce mode on the worker-thread backend (containment only)', async () => {
    const service = new ProgrammaticToolRuntime({ enabled: true, ptcBackend: 'worker-thread', securityMode: 'enforce' });
    await expect(service.run({
      code: 'return 1;',
      context: context(process.cwd()),
      hostTools: [],
    })).rejects.toMatchObject({ code: 'CODEACT_UNSAFE_BACKEND' });
  });
});

