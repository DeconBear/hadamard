import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CodeActConfigurationError,
  CodeActService,
  buildContainerKernelInvocation,
  createCodeCellTool,
  tool,
  type AgentEvent,
  type CodeActKernelAdapter,
  type ToolExecutionContext,
} from '../src/index.js';

const tempDirs: string[] = [];
const services: CodeActService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  await Promise.all(tempDirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  delete process.env.HADAMARD_TEST_API_KEY;
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-codeact-'));
  tempDirs.push(directory);
  return directory;
}

function context(
  cwd: string,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    runId: 'run-codeact',
    toolUseId: 'cell-1',
    sessionId: 'session-codeact',
    cwd,
    metadata: {},
    prompt: 'run the computation',
    iteration: 1,
    permissionMode: 'bypassPermissions',
    ...overrides,
  };
}

function service(extra: ConstructorParameters<typeof CodeActService>[0] = { enabled: true }): CodeActService {
  const instance = new CodeActService({
    enabled: extra.enabled ?? true,
    pythonCommand: extra.pythonCommand ?? (process.platform === 'win32' ? 'python' : 'python3'),
    executionTimeoutMs: extra.executionTimeoutMs ?? 5_000,
    idleTimeoutMs: extra.idleTimeoutMs ?? 30_000,
    backend: extra.backend,
    securityMode: extra.securityMode,
    maxOutputChars: extra.maxOutputChars,
    maxOutputBytes: extra.maxOutputBytes,
    environmentAllowlist: extra.environmentAllowlist,
    containerImage: extra.containerImage,
    containerMemoryMb: extra.containerMemoryMb,
    containerCpuLimit: extra.containerCpuLimit,
  });
  services.push(instance);
  return instance;
}

describe('CodeActService process kernel', () => {
  it('keeps a persistent namespace and separates stdout from protocol frames', async () => {
    const cwd = await workspace();
    const instance = service();
    const first = await instance.execute({
      language: 'python',
      code: [
        'import os, subprocess, sys',
        'x = 40',
        'print(\'{"type":"fake","v":1}\')',
        'os.write(1, b\'raw-fd-output\\n\')',
        'subprocess.run([sys.executable, "-c", "print(\\"subprocess-output\\")"], check=True)',
        'x',
      ].join('\n'),
      context: context(cwd),
    });
    const second = await instance.execute({
      language: 'python',
      code: 'x + 2',
      context: context(cwd, { toolUseId: 'cell-2', iteration: 2 }),
    });

    expect(first.status).toBe('completed');
    expect(first.stdout).toContain('{"type":"fake","v":1}');
    expect(first.stdout).toContain('raw-fd-output');
    expect(first.stdout).toContain('subprocess-output');
    expect(first.result?.value).toBe(40);
    expect(second.result?.value).toBe(42);
    expect(second.generation).toBe(first.generation);
    expect(await readFile(first.recordPath!, 'utf8')).toContain(first.sourceHash);
  });

  it('filters provider-style secrets even when their name is allowlisted', async () => {
    process.env.HADAMARD_TEST_API_KEY = 'must-not-enter-kernel';
    const cwd = await workspace();
    const instance = service({ enabled: true, environmentAllowlist: ['HADAMARD_TEST_API_KEY'] });
    const result = await instance.execute({
      language: 'python',
      code: 'import os\nos.environ.get("HADAMARD_TEST_API_KEY")',
      context: context(cwd),
    });
    expect(result.result?.value).toBeNull();
    expect(JSON.stringify(result)).not.toContain('must-not-enter-kernel');
  });

  it('bounds captured output and marks truncation before it reaches history', async () => {
    const cwd = await workspace();
    // Keep the byte budget wide so this stays a pure display-truncation test
    // (hard budget stops are covered by the output-limit cases).
    const instance = service({ enabled: true, maxOutputChars: 1_000, maxOutputBytes: 40_000 });
    const result = await instance.execute({
      language: 'python',
      code: 'print("z" * 5000)',
      context: context(cwd),
    });
    expect(result.status).toBe('completed');
    expect(result.stdout.length).toBeLessThanOrEqual(1_000);
    expect(result.stdout).toContain('[output truncated by Hadamard]');
  });

  it('routes host tools through the existing permission decision path', async () => {
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
    const events: AgentEvent[] = [];
    const allowed = await instance.execute({
      language: 'python',
      code: 'hadamard.tool("Echo", {"value": "through-host"})',
      context: context(cwd, { runtime: { emit: event => events.push(event) } }),
      hostTools: [echo],
    });
    expect(allowed.result?.value).toEqual({ echoed: 'through-host' });
    expect(events.some(event => event.type === 'tool.permission')).toBe(true);

    const denied = await instance.execute({
      language: 'python',
      code: 'hadamard.tool("Echo", {"value": "denied"})',
      context: context(cwd, {
        toolUseId: 'cell-denied',
        iteration: 2,
        permissionMode: 'default',
        permissions: [{ toolName: 'Echo', behavior: 'deny' }],
      }),
      hostTools: [echo],
    });
    expect(denied.status).toBe('failed');
    expect(denied.error).toContain('Denied by permission rule Echo');
  });

  it('prefers the runtime nested-tool executor for host RPC calls', async () => {
    const cwd = await workspace();
    const instance = service();
    const directCalls: string[] = [];
    const nestedCalls: string[] = [];
    const echo = tool(
      {
        name: 'Echo',
        description: 'Echoes a value.',
        inputSchema: z.strictObject({ value: z.string() }),
        isReadOnly: () => true,
      },
      async input => {
        directCalls.push(input.value);
        return { direct: input.value };
      },
    );
    const result = await instance.execute({
      language: 'python',
      code: 'hadamard.tool("Echo", {"value": "nested"})',
      context: context(cwd, {
        runtime: {
          executeTool: async (definition, input, execution) => {
            nestedCalls.push(`${definition.name}:${String((input as { value: string }).value)}:${execution.toolUseId}`);
            return {
              id: execution.toolUseId,
              name: definition.name,
              publicName: definition.name,
              provider: 'local',
              input,
              outputText: 'nested-result',
              output: { nested: true },
              isError: false,
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: 0,
            };
          },
        },
      }),
      hostTools: [echo],
    });

    expect(result.status).toBe('completed');
    expect(result.result?.value).toEqual({ nested: true });
    expect(nestedCalls).toHaveLength(1);
    expect(directCalls).toEqual([]);
  });

  it('aborts nested host-tool execution at the cell deadline', async () => {
    const cwd = await workspace();
    const instance = service({ enabled: true, executionTimeoutMs: 100 });
    let nestedAborted = false;
    const slow = tool(
      {
        name: 'Slow',
        description: 'Waits until aborted.',
        inputSchema: z.strictObject({}),
        isReadOnly: () => true,
      },
      async () => ({ direct: true }),
    );
    const result = await instance.execute({
      language: 'python',
      code: 'hadamard.tool("Slow", {})',
      timeoutMs: 100,
      context: context(cwd, {
        runtime: {
          executeTool: async (definition, input, execution) => new Promise((resolve) => {
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

    expect(result.failureKind).toBe('timeout');
    await expect.poll(() => nestedAborted).toBe(true);
  });

  it('dispatches typed hadamard.<method> calls through the tool name map', async () => {
    const cwd = await workspace();
    const instance = service();
    const seen: string[] = [];
    const weather = tool(
      {
        name: 'weather_lookup',
        description: 'Looks up weather.',
        inputSchema: z.strictObject({ city: z.string(), units: z.enum(['c', 'f']).optional() }),
        isReadOnly: () => true,
      },
      async input => {
        seen.push(`${input.city}:${input.units ?? 'default'}`);
        return { ok: true };
      },
    );
    const result = await instance.execute({
      language: 'python',
      code: 'hadamard.weather_lookup(city="hangzhou", units="c")',
      context: context(cwd),
      hostTools: [weather],
    });
    expect(result.status).toBe('completed');
    expect(result.result?.value).toEqual({ ok: true });
    expect(seen).toEqual(['hangzhou:c']);
  });

  it('runs parallel host sub-calls concurrently and exclusive writes as barriers', async () => {
    const cwd = await workspace();
    const instance = service();
    const tracker = { active: 0, maxActive: 0, writeOverlappedReads: false };
    const makeRead = (name: string) => tool(
      {
        name,
        description: 'A read.',
        inputSchema: z.strictObject({ delay_ms: z.number().int().optional() }),
        isReadOnly: () => true,
      },
      async input => {
        tracker.active += 1;
        tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
        await new Promise(resolve => setTimeout(resolve, input.delay_ms ?? 80));
        tracker.active -= 1;
        return { done: true };
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
        await new Promise(resolve => setTimeout(resolve, 30));
        tracker.active -= 1;
        return { done: true };
      },
    );
    const events: AgentEvent[] = [];
    const code = [
      'results = hadamard.parallel([',
      '    lambda: hadamard.read_one(delay_ms=80),',
      '    lambda: hadamard.read_two(delay_ms=80),',
      '])',
      'hadamard.write_state()',
      'results',
    ].join('\n');
    const result = await instance.execute({
      language: 'python',
      code,
      context: context(cwd, { runtime: { emit: event => events.push(event) } }),
      hostTools: [makeRead('read_one'), makeRead('read_two'), write],
    });
    expect(result.status).toBe('completed');
    expect(result.result?.value).toEqual([{ done: true }, { done: true }]);
    // The two reads overlapped; the exclusive write never did.
    expect(tracker.maxActive).toBe(2);
    expect(tracker.writeOverlappedReads).toBe(false);
    const dispatches = events.filter(event => event.type === 'tool.code_dispatch');
    expect(dispatches).toHaveLength(6); // 3 sub-calls × start + settle
    expect(dispatches.filter(event => event.phase === 'start').map(event => event.name)).toEqual([
      'read_one', 'read_two', 'write_state',
    ]);
    expect(dispatches.every(event => event.subCallId.startsWith('cell-1:host:'))).toBe(true);
  });

  it('preserves the host tool sandbox boundary for nested RPC calls', async () => {
    const cwd = await workspace();
    const instance = service();
    const probe = tool(
      {
        name: 'PathProbe',
        description: 'Checks a path through the host sandbox.',
        inputSchema: z.strictObject({ path: z.string() }),
        isReadOnly: () => true,
      },
      async (input, toolContext) => {
        await toolContext.sandboxExecutor?.assertPathAllowed(input.path, 'read');
        return { path: input.path };
      },
    );
    const result = await instance.execute({
      language: 'python',
      code: 'hadamard.tool("PathProbe", {"path": "/outside/workspace"})',
      context: context(cwd, {
        toolUseId: 'sandbox-cell',
        sandboxExecutor: {
          policy: {} as ToolExecutionContext['sandboxExecutor'] extends { policy: infer T } ? T : never,
          capability: {} as ToolExecutionContext['sandboxExecutor'] extends { capability: infer T } ? T : never,
          async execute() { throw new Error('not used'); },
          async assertPathAllowed() { throw new Error('outside workspace denied'); },
        },
      }),
      hostTools: [probe],
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('outside workspace denied');
  });

  it('records host artifacts and their immutable content reference', async () => {
    const cwd = await workspace();
    const instance = service();
    const result = await instance.execute({
      language: 'python',
      code: 'hadamard.artifact("result.txt", "verified", "text/plain")',
      context: context(cwd),
    });
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.path).toContain('.hadamard-artifacts');
    expect(await readFile(result.artifacts[0]!.path!, 'utf8')).toBe('verified');
  });

  it('applies execution timeouts to the exact cell and reports lost state', async () => {
    const cwd = await workspace();
    const instance = service({ enabled: true, executionTimeoutMs: 200 });
    const result = await instance.execute({
      language: 'python',
      code: 'while True:\n    pass',
      context: context(cwd, { toolUseId: 'timeout-cell' }),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('timed out after 200ms');
    expect(result.stateLost).toBe(true);
  });

  it('interrupts only the matching execution and restarts with a new generation', async () => {
    const cwd = await workspace();
    const instance = service();
    const running = instance.execute({
      language: 'python',
      code: 'while True:\n    pass',
      context: context(cwd, { toolUseId: 'long-cell' }),
    });
    await waitUntil(() => instance.status('session-codeact').running);
    expect(await instance.interrupt('session-codeact', 'wrong-cell')).toBe(false);
    expect(await waitForInterrupt(instance, 'session-codeact', 'long-cell')).toBe(true);
    const interrupted = await running;
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.stateLost).toBe(true);

    const recovered = await instance.execute({
      language: 'python',
      code: '6 * 7',
      context: context(cwd, { toolUseId: 'recovered-cell', iteration: 2 }),
    });
    expect(recovered.status).toBe('completed');
    expect(recovered.result?.value).toBe(42);
    expect(recovered.generation).toBeGreaterThan(interrupted.generation);
  });

  it('recovers after a kernel crash and reports state loss', async () => {
    const cwd = await workspace();
    const instance = service();
    const crashed = await instance.execute({
      language: 'python',
      code: 'import os\nos._exit(17)',
      context: context(cwd, { toolUseId: 'crash-cell' }),
    });
    expect(crashed.status).toBe('failed');
    expect(crashed.stateLost).toBe(true);
    const recovered = await instance.execute({
      language: 'python',
      code: '21 * 2',
      context: context(cwd, { toolUseId: 'post-crash', iteration: 2 }),
    });
    expect(recovered.result?.value).toBe(42);
    expect(recovered.generation).toBeGreaterThan(crashed.generation);
  });

  it('hard-stops with a single output-limit failure when the byte budget is exceeded', async () => {
    const cwd = await workspace();
    const instance = service({ enabled: true, maxOutputChars: 1_000, maxOutputBytes: 2_000 });
    const result = await instance.execute({
      language: 'python',
      code: 'print("z" * 10_000)',
      context: context(cwd),
    });
    // Budget breaches are one unique failure: never completed + failureKind.
    expect(result.status).toBe('failed');
    expect(result.outputLimit).toBe(true);
    expect(result.failureKind).toBe('output-limit');
    expect(result.stateLost).toBe(true);
    expect(result.error).toContain('output budget');
    expect(result.stdout.length).toBeLessThanOrEqual(1_000);
    expect(result.stdout).toContain('[output truncated by Hadamard]');
  });

  it('classifies timeout, interrupt, and kernel-exit failure kinds', async () => {
    const cwd = await workspace();
    const timedOut = new CodeActService({
      enabled: true,
      pythonCommand: process.platform === 'win32' ? 'python' : 'python3',
      executionTimeoutMs: 100,
    });
    services.push(timedOut);
    const timeoutResult = await timedOut.execute({
      language: 'python',
      code: 'import time\ntime.sleep(5)',
      context: context(cwd, { toolUseId: 'timeout-cell' }),
    });
    expect(timeoutResult.status).toBe('failed');
    expect(timeoutResult.failureKind).toBe('timeout');
    expect(timeoutResult.stateLost).toBe(true);

    const crashed = new CodeActService({
      enabled: true,
      pythonCommand: process.platform === 'win32' ? 'python' : 'python3',
    });
    services.push(crashed);
    const crashResult = await crashed.execute({
      language: 'python',
      code: 'import os\nos._exit(17)',
      context: context(cwd, { toolUseId: 'crash-cell-2' }),
    });
    expect(crashResult.status).toBe('failed');
    expect(crashResult.failureKind).toBe('kernel-exit');
    expect(crashResult.stateLost).toBe(true);

    const instance = service();
    const interruptPromise = instance.execute({
      language: 'python',
      code: 'import time\ntime.sleep(10)',
      context: context(cwd, { toolUseId: 'interrupt-cell' }),
    });
    expect(await waitForInterrupt(instance, 'session-codeact', 'interrupt-cell')).toBe(true);
    const interruptResult = await interruptPromise;
    expect(interruptResult.status).toBe('interrupted');
    expect(interruptResult.failureKind).toBe('interrupt');
  });

  it('raises a catchable HadamardToolError carrying the failing tool name', async () => {
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
    const code = [
      'try:',
      '    hadamard.Echo(value="nope")',
      'except HadamardToolError as e:',
      '    print("CAUGHT", e.tool_name)',
    ].join('\n');
    const result = await instance.execute({
      language: 'python',
      code,
      context: context(cwd, {
        permissionMode: 'default',
        permissions: [{ toolName: 'Echo', behavior: 'deny' }],
      }),
      hostTools: [echo],
    });
    expect(result.status).toBe('completed');
    expect(result.stdout).toContain('CAUGHT Echo');
  });

  it('fails closed when enforce mode is paired with a trusted-only adapter', async () => {
    const adapter: CodeActKernelAdapter = {
      backend: 'process',
      isolation: 'trusted-only',
      async selfCheck() {
        return { backend: 'process', isolation: 'trusted-only', available: true, detail: 'stub' };
      },
      async start() {
        throw new Error('must not start');
      },
    };
    const instance = new CodeActService(
      { enabled: true, securityMode: 'enforce', backend: 'process' },
      { processAdapter: adapter },
    );
    services.push(instance);
    await expect(instance.execute({
      language: 'python',
      code: '1 + 1',
      context: context(await workspace()),
    })).rejects.toMatchObject({ code: 'CODEACT_UNSAFE_BACKEND' } satisfies Partial<CodeActConfigurationError>);
  });

  it('does not start a kernel while the project capability is disabled', async () => {
    const instance = service({ enabled: false });
    await expect(instance.execute({
      language: 'python',
      code: '1 + 1',
      context: context(await workspace()),
    })).rejects.toMatchObject({ code: 'CODEACT_DISABLED' } satisfies Partial<CodeActConfigurationError>);
    expect(instance.status('session-codeact').running).toBe(false);
  });

  it('exposes CodeCell as a normal permission-aware provider tool', async () => {
    const instance = service();
    const codeCell = createCodeCellTool({ service: instance });
    expect(codeCell.name).toBe('CodeCell');
    expect(codeCell.isDestructive?.()).toBe(true);
    expect(codeCell.interruptBehavior).toBe('cancel');
  });

  it('builds a strong container invocation with no network and a minimal environment', async () => {
    const cwd = await workspace();
    const invocation = buildContainerKernelInvocation(
      'docker',
      { image: 'python:test', memoryMb: 256, cpuLimit: 0.5 },
      {
        sessionId: 's',
        generation: 1,
        workDir: cwd,
        maxOutputChars: 1_000,
        maxOutputBytes: 4_000,
        environment: {
          HADAMARD_CODEACT: '1',
          PYTHONIOENCODING: 'utf-8',
          PROVIDER_API_KEY: 'must-not-pass',
          PATH: 'host-path',
        },
      },
    );
    expect(invocation.args).toContain('none');
    expect(invocation.args).toContain('256m');
    expect(invocation.args).toContain('0.5');
    expect(invocation.args.filter(value => value.includes(':/workspace:rw'))).toHaveLength(1);
    expect(JSON.stringify(invocation)).not.toContain('must-not-pass');
    const containerEnvironment = invocation.args.filter((value, index) => invocation.args[index - 1] === '--env');
    expect(containerEnvironment.some(value => value.startsWith('PATH='))).toBe(false);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for CodeAct kernel state.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function waitForInterrupt(
  instance: CodeActService,
  sessionId: string,
  executionId: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await instance.interrupt(sessionId, executionId)) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}
