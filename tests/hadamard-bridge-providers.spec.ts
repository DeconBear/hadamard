import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clearLoadedJsonConfig,
  loadJsonConfigFile,
  detectBridgeProviders,
} from '../src/index.js';
import { BRIDGE_PROVIDER_CREDENTIALS, claudeProvider, piProvider, codexProvider, cursorProvider } from '../src/parity/bridgeProviders.js';

const tempDirs: string[] = [];
const fixtureCliPath = path.resolve(process.cwd(), 'tests', 'fixtures', 'fake-hadamard-runtime-cli.mjs');
const originalConfigDir = process.env.HADAMARD_CONFIG_DIR;
const providerPathEnvKeys = [
  'HADAMARD_CLAUDE_PATH',
  'HADAMARD_PI_PATH',
  'HADAMARD_CODEX_PATH',
  'HADAMARD_CODEWHALE_PATH',
  'HADAMARD_REASONIX_PATH',
  'HADAMARD_CRUSH_PATH',
  'HADAMARD_CURSOR_PATH',
] as const;
const originalProviderPaths = new Map(
  providerPathEnvKeys.map(key => [key, process.env[key]] as const),
);
const originalProbePidFile = process.env.HADAMARD_BRIDGE_PROBE_PID_FILE;

afterEach(async () => {
  clearLoadedJsonConfig();
  if (originalConfigDir == null) {
    delete process.env.HADAMARD_CONFIG_DIR;
  } else {
    process.env.HADAMARD_CONFIG_DIR = originalConfigDir;
  }
  for (const key of providerPathEnvKeys) {
    const original = originalProviderPaths.get(key);
    if (original == null) delete process.env[key];
    else process.env[key] = original;
  }
  if (originalProbePidFile == null) delete process.env.HADAMARD_BRIDGE_PROBE_PID_FILE;
  else process.env.HADAMARD_BRIDGE_PROBE_PID_FILE = originalProbePidFile;
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function maskProviderExecutablesAsMissing(): void {
  for (const key of providerPathEnvKeys) {
    process.env[key] = path.join(os.tmpdir(), 'hadamard-definitely-missing-provider');
  }
}

async function createHangingVersionExecutable(): Promise<{
  executablePath: string;
  pidFile: string;
}> {
  const tempDir = await createTempDir('bridge-prov-hanging-');
  const pidFile = path.join(tempDir, 'pids.txt');
  const scriptPath = path.join(tempDir, 'hang-version.mjs');
  const script = [
    `import { appendFileSync } from 'node:fs';`,
    `appendFileSync(process.env.HADAMARD_BRIDGE_PROBE_PID_FILE, String(process.pid) + '\\n');`,
    `setInterval(() => {}, 1_000);`,
    '',
  ].join('\n');

  if (process.platform !== 'win32') {
    await writeFile(scriptPath, `#!/usr/bin/env node\n${script}`, 'utf8');
    await chmod(scriptPath, 0o755);
    return { executablePath: scriptPath, pidFile };
  }

  await writeFile(scriptPath, script, 'utf8');
  const wrapperPath = path.join(tempDir, 'hang-version.cmd');
  await writeFile(
    wrapperPath,
    `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
    'utf8',
  );
  return { executablePath: wrapperPath, pidFile };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Bridge provider: resolveExecutable precedence', () => {
  it('returns explicitPath when provided, skipping env + settings', async () => {
    const explicit = path.resolve(fixtureCliPath);
    const result = await claudeProvider.resolveExecutable(explicit);
    expect(result).toBe(explicit);
  });

  it('reads HADAMARD_<ID>_PATH from the loaded settings env block', async () => {
    const tempDir = await createTempDir('bridge-prov-resolve-env-');
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ env: { HADAMARD_CLAUDE_PATH: fixtureCliPath } }),
      'utf8',
    );
    await loadJsonConfigFile(configPath);

    const result = await claudeProvider.resolveExecutable();
    expect(result).toBe(fixtureCliPath);
  });

  it('reads HADAMARD_<ID>_PATH from process.env as fallback after settings env', async () => {
    process.env.HADAMARD_CODEX_PATH = fixtureCliPath;
    const result = await codexProvider.resolveExecutable();
    expect(result).toBe(fixtureCliPath);
  });

  it('reads bridge.providers[id].path from the settings block', async () => {
    const tempDir = await createTempDir('bridge-prov-resolve-block-');
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        bridge: {
          defaultProvider: 'pi',
          providers: { pi: { path: fixtureCliPath } },
        },
      }),
      'utf8',
    );
    await loadJsonConfigFile(configPath);

    const result = await piProvider.resolveExecutable();
    expect(result).toBe(fixtureCliPath);
  });

  it('rejects an explicitPath that is not executable / does not exist', async () => {
    await expect(claudeProvider.resolveExecutable('/no/such/claude-binary')).rejects.toThrow(
      /not found/,
    );
  });

  it('rejects an HADAMARD_<ID>_PATH that points at a missing file', async () => {
    process.env.HADAMARD_PI_PATH = '/no/such/pi-binary';
    await expect(piProvider.resolveExecutable()).rejects.toThrow(
      /HADAMARD_PI_PATH.*not found/,
    );
  });
});

describe('detectBridgeProviders', () => {
  it('returns entries for all seven registered providers', async () => {
    maskProviderExecutablesAsMissing();
    const results = await detectBridgeProviders();
    expect(results).toHaveLength(7);

    for (const entry of results) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('displayName');
      expect(entry).toHaveProperty('available');
      expect(entry).toHaveProperty('path');
      expect(entry).toHaveProperty('version');
      if (entry.available) {
        expect(typeof entry.path).toBe('string');
      }
    }
  });

  it('reports unavailable when a provider is unresolvable', async () => {
    // Broken env overrides skip PATH and keep this test independent from
    // whatever provider CLIs happen to be installed on the host.
    maskProviderExecutablesAsMissing();
    const results = await detectBridgeProviders();
    const piResult = results.find(r => r.id === 'pi');
    expect(piResult?.available).toBe(false);
    expect(piResult?.path).toBeUndefined();
    expect(piResult?.version).toBeUndefined();
  });

  it('honours the defaultProvider from bridge settings', async () => {
    const tempDir = await createTempDir('bridge-prov-detect-default-');
    const configPath = path.join(tempDir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ bridge: { defaultProvider: 'codex' } }),
      'utf8',
    );
    await loadJsonConfigFile(configPath);
    maskProviderExecutablesAsMissing();

    // getDefaultProviderId is used internally by resolveProvider and
    // HadamardBridgeSdkClient.create. The detect API itself doesn't
    // change — but we confirm settings load correctly (all seven entries
    // present, regardless of what's on PATH).
    const results = await detectBridgeProviders();
    expect(results.find(r => r.id === 'codex')).toBeDefined();
    expect(results).toHaveLength(7);
  });

  it('bounds direct probes and avoids unkillable Windows batch-shim trees', async () => {
    const { executablePath, pidFile } = await createHangingVersionExecutable();
    process.env.HADAMARD_BRIDGE_PROBE_PID_FILE = pidFile;
    for (const key of providerPathEnvKeys) process.env[key] = executablePath;

    const startedAt = Date.now();
    const results = await detectBridgeProviders({ probeTimeoutMs: 750 });
    const elapsedMs = Date.now() - startedAt;

    expect(results).toHaveLength(7);
    expect(results.every(result => result.available && result.version === undefined)).toBe(true);
    // Windows batch shims are deliberately not executed because restricted
    // hosts may deny taskkill /T; direct probes on other platforms time out.
    expect(elapsedMs).toBeLessThan(process.platform === 'win32' ? 5_000 : 4_000);

    const pidText = await readFile(pidFile, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    });
    const pids = pidText
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter(Number.isFinite);
    if (process.platform === 'win32') {
      expect(pids).toEqual([]);
      return;
    }
    expect(pids.length).toBeGreaterThan(0);
    const alivePids = pids.filter(isProcessAlive);
    expect(alivePids, `Timed-out provider probes still alive: ${alivePids.join(', ')}`).toEqual([]);
  }, 10_000);
});

describe('Bridge provider: probeVersion (best-effort)', () => {
  it('returns undefined when --version spawn fails (non-executable .mjs)', async () => {
    // The fake CLIs are .mjs node scripts — they can't be spawned
    // directly. probeVersion wraps in try/catch → undefined.
    const version = await claudeProvider.probeVersion(fixtureCliPath);
    expect(version).toBeUndefined();
  });

  it('returns a version for a real binary without consulting a shell profile', async () => {
    const version = await claudeProvider.probeVersion(process.execPath);
    expect(version).toBe(process.version);
  });
});

describe('BRIDGE_PROVIDER_CREDENTIALS', () => {
  // Advisory display data only — surfaces which env var each provider's CLI
  // reads so the TUI /bridge board can show credential readiness.
  it('covers all seven providers', () => {
    expect(Object.keys(BRIDGE_PROVIDER_CREDENTIALS).sort()).toEqual([
      'claude',
      'codewhale',
      'codex',
      'crush',
      'cursor',
      'pi',
      'reasonix',
    ]);
  });

  it('lists the credential vars each known provider reads', () => {
    expect(BRIDGE_PROVIDER_CREDENTIALS.claude).toContain('ANTHROPIC_API_KEY');
    expect(BRIDGE_PROVIDER_CREDENTIALS.claude).toContain('HADAMARD_API_KEY');
    expect(BRIDGE_PROVIDER_CREDENTIALS.pi).toContain('OPENAI_API_KEY');
    expect(BRIDGE_PROVIDER_CREDENTIALS.codex).toContain('OPENAI_API_KEY');
    expect(BRIDGE_PROVIDER_CREDENTIALS.reasonix).toContain('DEEPSEEK_API_KEY');
    expect(BRIDGE_PROVIDER_CREDENTIALS.cursor).toEqual(['CURSOR_API_KEY']);
  });

  it('uses an empty list (honest "unknown") for multi-backend providers', () => {
    expect(BRIDGE_PROVIDER_CREDENTIALS.codewhale).toEqual([]);
    expect(BRIDGE_PROVIDER_CREDENTIALS.crush).toEqual([]);
  });
});

describe('Codex direct CLI arguments', () => {
  it('persists a new exec session and resumes the native thread id', () => {
    const first = codexProvider.buildArgs('first turn', {
      model: 'gpt-5',
    });
    expect(first.slice(0, 2)).toEqual(['exec', '--json']);
    expect(first).not.toContain('--ephemeral');
    expect(first.at(-1)).toBe('first turn');

    const resumed = codexProvider.buildArgs('second turn', {
      model: 'gpt-5',
      resume: 'thread-native-123',
    });
    expect(resumed.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(resumed).not.toContain('--ephemeral');
    expect(resumed).toContain('thread-native-123');
    expect(resumed.at(-1)).toBe('second turn');
  });

  it('uses Codex --last when continuing without an explicit thread id', () => {
    const args = codexProvider.buildArgs('continue turn', {
      continueMostRecent: true,
    });
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(args).toContain('--last');
    expect(args.at(-1)).toBe('continue turn');
  });
});

describe('Pi managed RPC adapter', () => {
  it('keeps prompts out of argv and maps permission modes to bounded tool sets', () => {
    const safe = piProvider.buildArgs('--version', {
      model: 'openai/gpt-5',
      permissionMode: 'default',
      sessionId: 'pi-session-123',
    });
    expect(safe.slice(0, 2)).toEqual(['--mode', 'rpc']);
    expect(safe).not.toContain('--version');
    expect(safe).toContain('--provider');
    expect(safe).toContain('openai');
    expect(safe).toContain('--model');
    expect(safe).toContain('gpt-5');
    expect(safe).toContain('--tools');
    expect(safe).toContain('read,grep,find,ls');
    expect(safe).toContain('--session-id');
    expect(safe).toContain('pi-session-123');

    const edits = piProvider.buildArgs('edit', { permissionMode: 'acceptEdits' });
    expect(edits).toContain('read,grep,find,ls,edit,write');

    for (const permissionMode of ['default', 'plan', 'acceptEdits'] as const) {
      const bounded = piProvider.buildArgs('bounded tools', {
        permissionMode,
        tools: ['read', 'bash'],
      });
      expect(bounded).not.toContain('bash');
      expect(bounded).toContain('read');
    }

    const bypass = piProvider.buildArgs('run', { permissionMode: 'bypassPermissions' });
    expect(bypass).not.toContain('--tools');
    expect(bypass).not.toContain('--no-tools');
  });

  it('uses credentialProvider for a plain model while a model prefix takes precedence', () => {
    const configured = piProvider.buildArgs('configured provider', {
      credentialProvider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    expect(configured.slice(configured.indexOf('--provider'), configured.indexOf('--provider') + 2))
      .toEqual(['--provider', 'anthropic']);

    const prefixed = piProvider.buildArgs('prefixed provider', {
      credentialProvider: 'anthropic',
      model: 'openai/gpt-5',
    });
    expect(prefixed.slice(prefixed.indexOf('--provider'), prefixed.indexOf('--provider') + 2))
      .toEqual(['--provider', 'openai']);
  });

  it('rejects interactive or option-like session selection', () => {
    expect(() => piProvider.buildArgs('resume', { resume: true })).toThrow(/exact session id/i);
    expect(() => piProvider.buildArgs('resume', { resume: '--approve' })).toThrow(/session id/i);
  });

  it('normalizes state, thinking, tools, usage, and terminal events', () => {
    const normalizer = piProvider.createNormalizer('inspect runtime', {
      permissionMode: 'default',
      sessionId: 'seed-id',
    });
    const outbound: Array<Record<string, unknown>> = [];
    let inputEnded = false;
    const control = {
      write: (record: Record<string, unknown>) => outbound.push(record),
      endInput: () => { inputEnded = true; },
    };
    normalizer.start?.(control);
    expect(outbound).toEqual([
      { id: 'hadamard-state', type: 'get_state' },
      { id: 'hadamard-prompt', type: 'prompt', message: 'inspect runtime' },
    ]);

    expect(normalizer.translate({
      id: 'hadamard-state',
      type: 'response',
      success: true,
      data: { sessionId: 'pi-native-1', cwd: '/workspace', model: 'gpt-5' },
    }, control)).toEqual([expect.objectContaining({
      type: 'system',
      subtype: 'init',
      session_id: 'pi-native-1',
    })]);

    expect(normalizer.translate({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'checking' },
    }, control)).toEqual([expect.objectContaining({ type: 'stream_event' })]);
    expect(normalizer.translate({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'done' },
    }, control)).toEqual([expect.objectContaining({ type: 'stream_event' })]);

    expect(normalizer.translate({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'read',
      args: { path: 'README.md' },
    }, control)).toEqual([expect.objectContaining({
      type: 'assistant',
      message: expect.objectContaining({
        content: [expect.objectContaining({ type: 'tool_use', id: 'tool-1', name: 'read' })],
      }),
    })]);
    expect(normalizer.translate({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: '# readme' }] },
      isError: false,
    }, control)).toEqual([expect.objectContaining({
      type: 'user',
      message: expect.objectContaining({
        content: [expect.objectContaining({
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: '# readme',
          is_error: false,
        })],
      }),
    })]);

    normalizer.translate({
      type: 'message_end',
      message: {
        role: 'assistant',
        model: 'gpt-5',
        content: [{ type: 'text', text: 'done' }],
        usage: { cost: { total: 0.01 } },
        stopReason: 'stop',
      },
    }, control);
    normalizer.translate({ type: 'turn_end' }, control);
    expect(normalizer.translate({ type: 'agent_end' }, control)).toEqual([
      expect.objectContaining({
        type: 'result',
        subtype: 'success',
        session_id: 'pi-native-1',
        result: 'done',
        total_cost_usd: 0.01,
      }),
    ]);
    expect(inputEnded).toBe(true);
  });
});

describe('Codex JSONL tool event normalization', () => {
  it.each([
    {
      item: {
        id: 'cmd-1',
        type: 'command_execution',
        command: 'npm test',
        aggregated_output: 'all tests passed',
        exit_code: 0,
        status: 'completed',
      },
      expectedName: 'command_execution',
      expectedInput: { command: 'npm test' },
      expectedResult: 'all tests passed',
      expectedError: false,
    },
    {
      item: {
        id: 'patch-1',
        type: 'file_change',
        changes: [{ path: 'src/index.ts', kind: 'update' }],
        status: 'completed',
      },
      expectedName: 'file_change',
      expectedInput: { changes: [{ path: 'src/index.ts', kind: 'update' }] },
      expectedResult: JSON.stringify([{ path: 'src/index.ts', kind: 'update' }], null, 2),
      expectedError: false,
    },
    {
      item: {
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'filesystem',
        tool: 'read_file',
        arguments: { path: 'README.md' },
        error: { message: 'denied' },
        status: 'failed',
      },
      expectedName: 'mcp__filesystem__read_file',
      expectedInput: { path: 'README.md' },
      expectedResult: JSON.stringify({ message: 'denied' }, null, 2),
      expectedError: true,
    },
  ])('maps $item.type start/completion to tool_use and tool_result', ({
    item,
    expectedName,
    expectedInput,
    expectedResult,
    expectedError,
  }) => {
    const normalizer = codexProvider.createNormalizer();
    normalizer.translate({ type: 'thread.started', thread_id: 'thread-123' });

    expect(normalizer.translate({ type: 'item.started', item })).toEqual([expect.objectContaining({
      type: 'assistant',
      session_id: 'thread-123',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: item.id,
          name: expectedName,
          input: expectedInput,
        }],
      },
    })]);
    expect(normalizer.translate({ type: 'item.completed', item })).toEqual([expect.objectContaining({
      type: 'user',
      session_id: 'thread-123',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: item.id,
          content: expectedResult,
          is_error: expectedError,
        }],
      },
    })]);
  });
});

describe('Codex exec JSONL normalization', () => {
  it('maps command, file-change, and MCP item lifecycles to paired tool events', () => {
    const normalizer = codexProvider.createNormalizer();
    const threadId = 'codex-thread-123';

    expect(normalizer.translate({
      type: 'thread.started',
      thread_id: threadId,
    })).toEqual([expect.objectContaining({
      type: 'system',
      subtype: 'init',
      session_id: threadId,
    })]);

    const changes = [{ path: 'src/runtime.ts', kind: 'update' }];
    const mcpResult = {
      content: [{ type: 'text', text: '# Hadamard' }],
      structured_content: null,
    };
    const cases = [
      {
        started: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: '',
          exit_code: null,
          status: 'in_progress',
        },
        completed: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: '42 tests passed\n',
          exit_code: 0,
          status: 'completed',
        },
        name: 'command_execution',
        input: { command: 'npm test' },
        content: '42 tests passed\n',
        isError: false,
      },
      {
        started: {
          id: 'patch-1',
          type: 'file_change',
          changes,
          status: 'in_progress',
        },
        completed: {
          id: 'patch-1',
          type: 'file_change',
          changes,
          status: 'completed',
        },
        name: 'file_change',
        input: { changes },
        content: JSON.stringify(changes, null, 2),
        isError: false,
      },
      {
        started: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'filesystem',
          tool: 'read_file',
          arguments: { path: 'README.md' },
          status: 'in_progress',
        },
        completed: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'filesystem',
          tool: 'read_file',
          arguments: { path: 'README.md' },
          result: mcpResult,
          error: null,
          status: 'completed',
        },
        name: 'mcp__filesystem__read_file',
        input: { path: 'README.md' },
        content: JSON.stringify(mcpResult, null, 2),
        isError: false,
      },
      {
        started: {
          id: 'mcp-2',
          type: 'mcp_tool_call',
          server: 'filesystem',
          tool: 'read_file',
          arguments: { path: 'missing.md' },
          status: 'in_progress',
        },
        completed: {
          id: 'mcp-2',
          type: 'mcp_tool_call',
          server: 'filesystem',
          tool: 'read_file',
          arguments: { path: 'missing.md' },
          result: null,
          error: { message: 'file not found' },
          status: 'failed',
        },
        name: 'mcp__filesystem__read_file',
        input: { path: 'missing.md' },
        content: JSON.stringify({ message: 'file not found' }, null, 2),
        isError: true,
      },
    ];

    for (const testCase of cases) {
      expect(normalizer.translate({
        type: 'item.started',
        item: testCase.started,
      })).toEqual([expect.objectContaining({
        type: 'assistant',
        session_id: threadId,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: testCase.started.id,
            name: testCase.name,
            input: testCase.input,
          }],
        },
      })]);
      expect(normalizer.translate({
        type: 'item.completed',
        item: testCase.completed,
      })).toEqual([expect.objectContaining({
        type: 'user',
        session_id: threadId,
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: testCase.completed.id,
            content: testCase.content,
            is_error: testCase.isError,
          }],
        },
      })]);
    }
  });
});

describe('Cursor direct CLI arguments', () => {
  it('maps permission modes onto cursor-agent flags and keeps the prompt last', () => {
    const plan = cursorProvider.buildArgs('plan this', { permissionMode: 'plan' });
    expect(plan.slice(0, 4)).toEqual(['--trust', '--output-format', 'stream-json', '--stream-partial-output']);
    expect(plan).toContain('--mode');
    expect(plan).toContain('plan');
    expect(plan).not.toContain('--force');
    expect(plan.slice(-2)).toEqual(['-p', 'plan this']);

    const readOnly = cursorProvider.buildArgs('inspect', { permissionMode: 'default' });
    expect(readOnly).not.toContain('--force');
    expect(readOnly).not.toContain('--mode');

    for (const permissionMode of ['acceptEdits', 'bypassPermissions'] as const) {
      const write = cursorProvider.buildArgs('apply edits', { permissionMode });
      expect(write).toContain('--force');
      expect(write).not.toContain('--mode');
    }

    const forced = cursorProvider.buildArgs('apply edits', { dangerouslySkipPermissions: true });
    expect(forced).toContain('--force');
  });

  it('passes --model and resumes via --resume/--continue', () => {
    const args = cursorProvider.buildArgs('second turn', {
      model: 'composer-2.5',
      resume: 'cursor-session-123',
    });
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2))
      .toEqual(['--model', 'composer-2.5']);
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2))
      .toEqual(['--resume', 'cursor-session-123']);
    expect(args.slice(-2)).toEqual(['-p', 'second turn']);

    const latest = cursorProvider.buildArgs('continue turn', { continueMostRecent: true });
    expect(latest).toContain('--continue');
    expect(latest).not.toContain('--resume');

    expect(() => cursorProvider.buildArgs('resume', { resume: '--force' })).toThrow(/session id/i);
    expect(() => cursorProvider.buildArgs('model', { model: '--force' })).toThrow(/model/i);
  });
});

describe('Cursor stream-json normalization', () => {
  it('maps init, deltas, tool calls, and result with usage', () => {
    const normalizer = cursorProvider.createNormalizer();

    expect(normalizer.translate({
      type: 'system',
      subtype: 'init',
      cwd: '/workspace',
      session_id: 'cursor-session-1',
      model: 'composer-2.5',
    })).toEqual([expect.objectContaining({
      type: 'system',
      subtype: 'init',
      session_id: 'cursor-session-1',
      model: 'composer-2.5',
      cwd: '/workspace',
    })]);

    // user echoes have no bridge equivalent.
    expect(normalizer.translate({ type: 'user', message: { role: 'user', content: [] } }))
      .toEqual([]);

    // A delta (timestamp_ms, no model_call_id) streams as a text delta.
    expect(normalizer.translate({
      type: 'assistant',
      timestamp_ms: 100,
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
    })).toEqual([expect.objectContaining({
      type: 'stream_event',
      session_id: 'cursor-session-1',
      event: expect.objectContaining({
        delta: expect.objectContaining({ type: 'text_delta', text: 'partial' }),
      }),
    })]);

    // A recap (model_call_id) repeats streamed text and is dropped.
    expect(normalizer.translate({
      type: 'assistant',
      model_call_id: 'call-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial full recap' }] },
    })).toEqual([]);

    // tool_call started/completed pairs map to tool_use / tool_result.
    expect(normalizer.translate({
      type: 'tool_call',
      subtype: 'started',
      tool_call: { writeToolCall: { args: { path: 'README.md' } } },
    })).toEqual([expect.objectContaining({
      type: 'assistant',
      session_id: 'cursor-session-1',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'cursor-tool-1',
          name: 'write',
          input: { path: 'README.md' },
        }],
      },
    })]);
    expect(normalizer.translate({
      type: 'tool_call',
      subtype: 'completed',
      tool_call: { writeToolCall: { args: { path: 'README.md' }, result: { success: true } } },
    })).toEqual([expect.objectContaining({
      type: 'user',
      session_id: 'cursor-session-1',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'cursor-tool-1',
          content: JSON.stringify({ success: true }, null, 2),
          is_error: false,
        }],
      },
    })]);

    // The result event carries duration and token usage.
    expect(normalizer.translate({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1200,
      result: 'done',
      session_id: 'cursor-session-1',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
    })).toEqual([expect.objectContaining({
      type: 'result',
      subtype: 'success',
      session_id: 'cursor-session-1',
      is_error: false,
      result: 'done',
      duration_ms: 1200,
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_write_tokens: 1,
    })]);
  });

  it('uses recap text only when no deltas were streamed in the turn', () => {
    const normalizer = cursorProvider.createNormalizer();
    normalizer.translate({ type: 'system', subtype: 'init', session_id: 's' });

    // No deltas this turn: the model_call_id recap becomes the assistant text.
    expect(normalizer.translate({
      type: 'assistant',
      model_call_id: 'call-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'buffered answer' }] },
    })).toEqual([expect.objectContaining({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'buffered answer' }] },
    })]);

    // A delta followed by a recap drops the recap; the next turn's recap is
    // used again once no new deltas precede it.
    normalizer.translate({
      type: 'assistant',
      timestamp_ms: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'd' }] },
    });
    expect(normalizer.translate({
      type: 'assistant',
      model_call_id: 'call-2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'd full' }] },
    })).toEqual([]);
    expect(normalizer.translate({
      type: 'assistant',
      model_call_id: 'call-3',
      message: { role: 'assistant', content: [{ type: 'text', text: 'fresh turn' }] },
    })).toEqual([expect.objectContaining({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'fresh turn' }] },
    })]);
  });

  it('matches the real cursor-agent wire shape (2026.08.11)', () => {
    const normalizer = cursorProvider.createNormalizer();
    normalizer.translate({ type: 'system', subtype: 'init', session_id: 's' });

    // thinking deltas stream as thinking_delta events; completed is ignored.
    expect(normalizer.translate({
      type: 'thinking', subtype: 'delta', text: 'hmm', timestamp_ms: 1, session_id: 's',
    })).toEqual([expect.objectContaining({
      type: 'stream_event',
      event: expect.objectContaining({
        delta: expect.objectContaining({ type: 'thinking_delta', thinking: 'hmm' }),
      }),
    })]);
    expect(normalizer.translate({ type: 'thinking', subtype: 'completed', timestamp_ms: 2 }))
      .toEqual([]);

    // The real recap carries NEITHER timestamp_ms NOR model_call_id and must
    // be dropped after streamed deltas.
    normalizer.translate({
      type: 'assistant',
      timestamp_ms: 3,
      message: { role: 'assistant', content: [{ type: 'text', text: 'real' }] },
    });
    expect(normalizer.translate({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'real' }] },
    })).toEqual([]);

    // tool_call events carry a stable call_id used for started/completed pairing.
    const callId = 'call-abc-0\nfc_def_0';
    expect(normalizer.translate({
      type: 'tool_call',
      subtype: 'started',
      call_id: callId,
      toolCallId: callId,
      model_call_id: 'mc-0',
      timestamp_ms: 4,
      tool_call: { readToolCall: { args: { path: 'a.txt' } } },
    })).toEqual([expect.objectContaining({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: callId, name: 'read', input: { path: 'a.txt' } }],
      },
    })]);
    expect(normalizer.translate({
      type: 'tool_call',
      subtype: 'completed',
      call_id: callId,
      toolCallId: callId,
      model_call_id: 'mc-0',
      timestamp_ms: 5,
      tool_call: { readToolCall: { args: { path: 'a.txt' }, result: { error: { message: 'denied' } } } },
    })).toEqual([expect.objectContaining({
      type: 'user',
      message: {
        role: 'user',
        content: [expect.objectContaining({
          type: 'tool_result',
          tool_use_id: callId,
          is_error: true,
        })],
      },
    })]);
  });

  it('maps an error result to an error terminal event', () => {
    const normalizer = cursorProvider.createNormalizer();
    normalizer.translate({ type: 'system', subtype: 'init', session_id: 's' });
    expect(normalizer.translate({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'cursor usage limit reached',
      session_id: 's',
    })).toEqual([expect.objectContaining({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'cursor usage limit reached',
      stop_reason: 'error',
    })]);
  });
});
