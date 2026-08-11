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
    const instance = service({ enabled: true, maxOutputChars: 1_000 });
    const result = await instance.execute({
      language: 'python',
      code: 'print("z" * 5000)',
      context: context(cwd),
    });
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
