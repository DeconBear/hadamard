import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createManagedPluginRuntime,
  prepareKimiCommandArgs,
} from '../src/plugins/managedPluginRuntime.js';
import { createManagedActionDispatcher } from '../src/plugins/managedPluginSkills.js';
import { patchManagedPluginSettings } from '../src/plugins/managedPluginCatalog.js';
import { decideHadamardToolPermission } from '../src/runtime/hadamardPermissions.js';
import { tool } from '../src/runtime/tools.js';
import { z } from 'zod';

describe('managed plugin runtime', () => {
  it('mounts only enabled and configured managed plugin tools', async () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'ocr', {
      enabled: true,
      apiKey: 'qwen-secret',
      provider: 'qwen',
      api: 'responses',
    });
    patchManagedPluginSettings(raw, 'computer-use', {
      enabled: true,
      backend: 'local',
    });
    patchManagedPluginSettings(raw, 'github', {
      enabled: true,
      hostname: 'github.com',
    });
    patchManagedPluginSettings(raw, 'kimi-webbridge', {
      enabled: true,
      daemonUrl: 'http://127.0.0.1:10086',
    });
    patchManagedPluginSettings(raw, 'playwright', {
      enabled: true,
      headless: true,
      channel: 'chromium',
    });
    patchManagedPluginSettings(raw, 'tavily', {
      enabled: true,
      apiKey: 'tvly-secret',
    });
    patchManagedPluginSettings(raw, 'exa', {
      enabled: true,
      apiKey: 'exa-secret',
    });

    const runtime = createManagedPluginRuntime(raw, { cwd: process.cwd() });
    const names = runtime.tools.map(item => item.name);

    expect(names).toEqual(expect.arrayContaining([
      'ocr_extract',
      'computer_use',
      'kimi_webbridge',
      'browser_use',
    ]));
    // TavilySearch/ExaSearch moved out of this switch: they mount as runtime
    // contributions (see contribution-host tests).
    expect(names).not.toContain('TavilySearch');
    expect(names).not.toContain('ExaSearch');
    expect(names.some(name => name.startsWith('github_'))).toBe(false);
    expect(names.some(name => name.startsWith('computer_') && name !== 'computer_use')).toBe(false);
    expect(names.some(name => name.startsWith('browser_') && name !== 'browser_use')).toBe(false);
    expect(runtime.skills.map(skill => skill.name)).toEqual(expect.arrayContaining([
      'computer-use',
      'github',
      'playwright',
    ]));
    expect(runtime.tools).toHaveLength(4);
    expect(JSON.stringify(runtime.tools.map(item => item.inputJsonSchema))).not.toContain('qwen-secret');
    await runtime.close();
  });

  it('does not mount tools that still need a credential', async () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'ocr', { enabled: true });
    patchManagedPluginSettings(raw, 'computer-use', {
      enabled: true,
      backend: 'e2b',
    });

    const runtime = createManagedPluginRuntime(raw, { cwd: process.cwd() });
    expect(runtime.tools).toEqual([]);
    expect(runtime.skills).toEqual([]);
    await runtime.close();
  });

  it('mounts the E2B driver lazily when configured', async () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'computer-use', {
      enabled: true,
      backend: 'e2b',
      e2bApiKey: 'e2b-secret',
    });

    const runtime = createManagedPluginRuntime(raw, { cwd: process.cwd() });
    expect(runtime.tools.map(item => item.name)).toEqual(['computer_use']);
    expect(runtime.skills.map(item => item.name)).toEqual(['computer-use']);
    expect(JSON.stringify(runtime.tools.map(item => item.inputJsonSchema))).not.toContain('e2b-secret');
    await runtime.close();
  });

  it('registers GitHub only as a gh CLI skill and keeps interactive tool approvals', async () => {
    const raw: Record<string, unknown> = {};
    patchManagedPluginSettings(raw, 'github', { enabled: true });
    patchManagedPluginSettings(raw, 'kimi-webbridge', { enabled: true });
    const runtime = createManagedPluginRuntime(raw, { cwd: process.cwd() });

    try {
      expect(runtime.tools.some(item => item.name.startsWith('github_'))).toBe(false);
      expect(runtime.skills.find(item => item.name === 'github')?.prompt).toContain('gh auth status');
      const kimi = runtime.tools.find(item => item.name === 'kimi_webbridge')!;
      expect(kimi.requiresUserInteraction?.()).toBe(true);
      expect(kimi.isReadOnly?.({ action: 'screenshot', args: {} })).toBe(true);
      expect(kimi.isDestructive?.({
        action: 'screenshot',
        args: { path: 'screen.png' },
      })).toBe(true);
      for (const [definition, toolInput] of [
        [kimi, { action: 'click', args: { ref: 1 } }],
      ] as const) {
        const approver = vi.fn(async () => ({
          behavior: 'allow' as const,
          reason: 'approved',
        }));
        const decision = await decideHadamardToolPermission({
          mode: 'bypassPermissions',
          rules: [],
          approver,
          adapter: definition,
          runId: 'run-managed-plugin',
          workDir: process.cwd(),
          toolName: definition.name,
          publicName: definition.name,
          prompt: 'managed plugin security test',
          toolInput,
          iteration: 1,
        });
        expect(approver, definition.name).toHaveBeenCalledOnce();
        expect(decision.behavior, definition.name).toBe('allow');
      }
    } finally {
      await runtime.close();
    }
  });

  it('dispatches compact actions through the original schema and permission metadata', async () => {
    const read = tool(
      {
        name: 'demo_read',
        description: 'Read a value.',
        inputSchema: z.strictObject({ value: z.string().min(1) }),
        isReadOnly: () => true,
      },
      async ({ value }) => ({ value }),
    );
    const write = tool(
      {
        name: 'demo_write',
        description: 'Write a value.',
        inputSchema: z.strictObject({ value: z.string().min(1) }),
        isDestructive: () => true,
      },
      async ({ value }) => ({ value }),
    );
    const dispatcher = createManagedActionDispatcher({
      name: 'demo_use',
      description: 'Dispatch demo actions.',
      sourcePrefix: 'demo_',
      sourceTools: [read, write],
    });

    expect(dispatcher.isReadOnly?.({ action: 'read', args: { value: 'ok' } })).toBe(true);
    expect(dispatcher.isDestructive?.({ action: 'write', args: { value: 'ok' } })).toBe(true);
    expect(dispatcher.isDestructive?.({ action: 'missing' })).toBe(true);
    await expect(dispatcher.execute(
      { action: 'read', args: { value: '' } },
      {
        cwd: process.cwd(),
        runId: 'run-dispatch',
        permissionMode: 'default',
        metadata: {},
        prompt: 'dispatcher validation test',
        iteration: 1,
      },
    )).rejects.toThrow(/Invalid args/);
  });

  it('constrains Kimi output and upload paths to the workspace', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'hadamard-kimi-policy-'));
    const canonicalWorkspace = realpathSync.native(workspace);
    const source = path.join(workspace, 'upload.txt');
    await writeFile(source, 'safe', 'utf8');

    try {
      expect(prepareKimiCommandArgs('screenshot', { path: 'screen.png' }, workspace))
        .toEqual({ path: path.join(canonicalWorkspace, 'screen.png') });
      expect(prepareKimiCommandArgs('upload', { files: ['upload.txt'] }, workspace))
        .toEqual({ files: [realpathSync.native(source)] });
      expect(() =>
        prepareKimiCommandArgs('screenshot', { path: '../outside.png' }, workspace),
      ).toThrow(/inside the workspace/i);
      expect(() =>
        prepareKimiCommandArgs('upload', { files: ['../outside.txt'] }, workspace),
      ).toThrow(/inside the workspace/i);
      expect(() =>
        prepareKimiCommandArgs('save_as_pdf', {}, workspace),
      ).toThrow(/requires a workspace output path/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
