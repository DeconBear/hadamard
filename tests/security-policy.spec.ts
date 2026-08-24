import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  BuiltInExtensionToggles,
  ToolPolicyPipeline,
  createBuiltInToolPolicyPipeline,
  resolveBuiltInExtensionStates,
  tool,
  type AgentEvent,
  type ExecuteConversationOptions,
  type ToolPolicyCall,
} from '../src/index.js';
import { HadamardContributionHost } from '../src/contrib/contributionHost.js';
import {
  InMemoryToolPolicyListenerRegistry,
  createBuiltInToolPolicyContribution,
  toolPolicyFactoryKey,
  toolPolicyListenerRegistryKey,
} from '../src/runtime/toolPolicyPipeline.js';
import {
  createSecurityPolicyContribution,
  createSecurityPreListener,
  findDangerousCommandViolation,
  findProtectedPathViolation,
} from '../src/extensions/securityPolicy.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-security-ext-'));
  tempDirs.push(directory);
  return directory;
}

function enabledToggles(config: Record<string, unknown> = {}): BuiltInExtensionToggles {
  return new BuiltInExtensionToggles(
    resolveBuiltInExtensionStates({ extensions: { security: { enabled: true, ...config } } }),
  );
}

describe('findDangerousCommandViolation', () => {
  const denied: Array<[string, string]> = [
    ['rm -rf /', 'recursive forced delete'],
    ['rm -rf / ', 'recursive forced delete'],
    ['sudo rm -rf ~', 'recursive forced delete'],
    ['rm -fr $HOME', 'recursive forced delete'],
    ['rm -rf *', 'recursive forced delete'],
    ['rm -rf /*', 'recursive forced delete'],
    ['rm --recursive --force ~/', 'recursive forced delete'],
    [':(){ :|:& };:', 'fork bomb'],
    ['format C:', 'drive format'],
    ['dd if=/dev/zero of=/dev/sda bs=1M', 'dd writing to a device'],
    ['mkfs.ext4 /dev/sda1', 'filesystem format'],
    ['shutdown now', 'system power command'],
    ['sudo reboot', 'system power command'],
    ['poweroff', 'system power command'],
    ['diskpart', 'diskpart'],
    ['bcdedit /deletevalue safeboot', 'bcdedit'],
    ['del /s /q C:\\', 'system-drive recursive delete'],
    ['echo x > /dev/sda', 'write to block device'],
  ];
  it.each(denied)('denies %s', (command, label) => {
    expect(findDangerousCommandViolation(command)).toContain(label);
  });

  const allowed = [
    'rm -rf ./dist',
    'rm -rf .',
    'rm -rf node_modules',
    'rm -rf /tmp/hadamard-scratch',
    'ls -la',
    'git clean -fdx',
    'git reset --hard',
    'npm run shutdown-script',
  ];
  it.each(allowed)('allows %s', (command) => {
    expect(findDangerousCommandViolation(command)).toBeNull();
  });

  it('honors extraDangerousPatterns and skips invalid regexes', () => {
    expect(findDangerousCommandViolation('psql -c "DROP TABLE users"', ['drop\\s+table'])).toContain('custom dangerous pattern');
    expect(findDangerousCommandViolation('psql -c "select 1"', ['[', 'drop\\s+table'])).toBeNull();
  });
});

describe('findProtectedPathViolation', () => {
  it('denies default protected paths (relative, ./-prefixed, and absolute forms)', async () => {
    const cwd = await workspace();
    const defaults = ['.env', '.env.*', '.git/', 'node_modules/'];
    for (const candidate of [
      '.env',
      './.env',
      '.env.local',
      path.join(cwd, '.env'),
      path.join(cwd, '.git', 'config'),
      '.git/config',
      'node_modules/pkg/index.js',
      path.join(cwd, 'src', 'node_modules', 'x.js'),
    ]) {
      expect(findProtectedPathViolation(candidate, cwd, defaults), candidate).not.toBeNull();
    }
  });

  it('allows ordinary workspace files', async () => {
    const cwd = await workspace();
    const defaults = ['.env', '.env.*', '.git/', 'node_modules/'];
    for (const candidate of ['src/foo.ts', '.envrc', '.gitignore', 'dist/output.js', 'docs/env-notes.md']) {
      expect(findProtectedPathViolation(candidate, cwd, defaults), candidate).toBeNull();
    }
  });

  it('honors configured protectedPaths (directory prefix and glob)', async () => {
    const cwd = await workspace();
    expect(findProtectedPathViolation('secrets/api.json', cwd, ['secrets/'])).toContain('secrets/');
    expect(findProtectedPathViolation('src/secrets/api.json', cwd, ['secrets/'])).not.toBeNull();
    expect(findProtectedPathViolation('config/prod.yaml', cwd, ['*.yaml'])).not.toBeNull();
    expect(findProtectedPathViolation('src/foo.ts', cwd, ['secrets/', '*.yaml'])).toBeNull();
  });
});

function baseOptions(workDir: string, events: AgentEvent[], overrides: Partial<ExecuteConversationOptions> = {}): ExecuteConversationOptions {
  return {
    runId: 'run-security',
    sessionId: 'session-security',
    input: 'probe',
    streaming: false,
    workDir,
    permissionMode: 'bypassPermissions',
    emit: (event: AgentEvent) => events.push(event),
    config: {
      workDir,
      compact: { toolResultArtifactMaxChars: 80_000 },
    } as ExecuteConversationOptions['config'],
    ...overrides,
  } as ExecuteConversationOptions;
}

function fakeAdapter(name: string, readOnly: boolean): ToolPolicyCall['adapter'] {
  const definition = tool(
    {
      name,
      description: `${name} tool.`,
      inputSchema: z.object({ value: z.string().optional() }),
      isReadOnly: () => readOnly,
    },
    async (input) => input,
  );
  return {
    publicName: name,
    sourceName: name,
    provider: 'local',
    providerTool: { name, description: definition.description, input_schema: definition.inputJsonSchema },
    execute: async (input: unknown) => ({ content: 'ok', text: 'ok', rawOutput: input }),
    isReadOnly: definition.isReadOnly,
    isDestructive: definition.isDestructive,
    isPlanReadOnly: definition.isPlanReadOnly,
    requiresUserInteraction: definition.requiresUserInteraction,
    checkPermissions: definition.checkPermissions,
  } as ToolPolicyCall['adapter'];
}

function policyCall(workDir: string, adapter: ToolPolicyCall['adapter'], input: unknown): ToolPolicyCall {
  return {
    iteration: 1,
    toolUseId: 'tu-1',
    toolName: adapter.sourceName,
    publicName: adapter.publicName,
    input,
    adapter,
    workDir,
    prompt: 'probe prompt',
  };
}

describe('security pre-listener in the built-in pipeline', () => {
  it('denies a dangerous command before the permission listener runs', async () => {
    const cwd = await workspace();
    const events: AgentEvent[] = [];
    const pipeline: ToolPolicyPipeline = createBuiltInToolPolicyPipeline(
      baseOptions(cwd, events),
      { pre: [createSecurityPreListener(enabledToggles())] },
    );
    const state = await pipeline.runPre(policyCall(cwd, fakeAdapter('Bash', false), { command: 'rm -rf /' }));
    expect(state.behavior).toBe('deny');
    expect(state.reason).toContain('[security extension]');
    expect(state.reason).toContain('extensions.security.enabled=false');
    // Deny short-circuits before the permission listener: no decision, no event.
    expect(state.decision).toBeUndefined();
    expect(events.some((event) => event.type === 'tool.permission')).toBe(false);
  });

  it('denies writes to protected paths and redirections into them', async () => {
    const cwd = await workspace();
    const pipeline = createBuiltInToolPolicyPipeline(
      baseOptions(cwd, []),
      { pre: [createSecurityPreListener(enabledToggles())] },
    );
    const writeState = await pipeline.runPre(
      policyCall(cwd, fakeAdapter('Write', false), { file_path: path.join(cwd, '.env') }),
    );
    expect(writeState.behavior).toBe('deny');
    expect(writeState.reason).toContain('protected path');
    const redirectState = await pipeline.runPre(
      policyCall(cwd, fakeAdapter('Bash', false), { command: 'echo secret > .env' }),
    );
    expect(redirectState.behavior).toBe('deny');
    expect(redirectState.reason).toContain('redirection');
  });

  it('allows ordinary commands and file edits when enabled', async () => {
    const cwd = await workspace();
    const pipeline = createBuiltInToolPolicyPipeline(
      baseOptions(cwd, []),
      { pre: [createSecurityPreListener(enabledToggles())] },
    );
    const lsState = await pipeline.runPre(policyCall(cwd, fakeAdapter('Bash', false), { command: 'ls -la' }));
    expect(lsState.behavior).toBe('allow');
    const editState = await pipeline.runPre(
      policyCall(cwd, fakeAdapter('Edit', false), { file_path: path.join(cwd, 'src', 'foo.ts') }),
    );
    expect(editState.behavior).toBe('allow');
  });

  it('no-ops when the extension is disabled (default off)', async () => {
    const cwd = await workspace();
    const toggles = new BuiltInExtensionToggles(resolveBuiltInExtensionStates(undefined));
    const pipeline = createBuiltInToolPolicyPipeline(
      baseOptions(cwd, []),
      { pre: [createSecurityPreListener(toggles)] },
    );
    const state = await pipeline.runPre(policyCall(cwd, fakeAdapter('Bash', false), { command: 'rm -rf /' }));
    expect(state.behavior).toBe('allow');
    // Live toggle takes effect on the next run without rebuilding the pipeline.
    toggles.setEnabled('security', true);
    const denied = await pipeline.runPre(policyCall(cwd, fakeAdapter('Bash', false), { command: 'rm -rf /' }));
    expect(denied.behavior).toBe('deny');
  });

  it('honors extraDangerousPatterns from settings config', async () => {
    const cwd = await workspace();
    const pipeline = createBuiltInToolPolicyPipeline(
      baseOptions(cwd, []),
      { pre: [createSecurityPreListener(enabledToggles({ extraDangerousPatterns: ['\\bkubectl\\s+delete\\b'] }))] },
    );
    const state = await pipeline.runPre(
      policyCall(cwd, fakeAdapter('Bash', false), { command: 'kubectl delete namespace prod' }),
    );
    expect(state.behavior).toBe('deny');
  });

  it('composes through the contribution host registry seam and disposes cleanly', async () => {
    const cwd = await workspace();
    const host = new HadamardContributionHost();
    const registry = new InMemoryToolPolicyListenerRegistry();
    host.registerService(toolPolicyListenerRegistryKey, registry);
    const toggles = enabledToggles();
    const handle = await host.load(createSecurityPolicyContribution(toggles));
    await host.load(createBuiltInToolPolicyContribution());
    try {
      const factory = host.getService(toolPolicyFactoryKey);
      expect(factory).toBeDefined();
      const pipeline = factory!(baseOptions(cwd, []));
      const state = await pipeline.runPre(policyCall(cwd, fakeAdapter('Bash', false), { command: 'rm -rf /' }));
      expect(state.behavior).toBe('deny');
      // Disposing the extension contribution removes the listener from the next run.
      await handle.dispose();
      const nextPipeline = host.getService(toolPolicyFactoryKey)!(baseOptions(cwd, []));
      const allowed = await nextPipeline.runPre(policyCall(cwd, fakeAdapter('Bash', false), { command: 'rm -rf /' }));
      expect(allowed.behavior).toBe('allow');
    } finally {
      await host.dispose();
    }
  });
});
