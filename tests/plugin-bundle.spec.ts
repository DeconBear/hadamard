import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgentSdk,
  McpConnectionManager,
  PluginLoader,
  PluginPackageManager,
  type ModelApi,
  type ModelRequest,
  type ModelStreamHandle,
  type ToolExecutionContext,
} from '../src/index.js';
import type { Message } from '../src/provider/types.js';

const dirs: string[] = [];
const QWEN_SOURCE = 'https://github.com/QwenLM/Qwen-MM-Plugins';
const QWEN_COMMIT = '8d6ea5a1f658260743307c52c2024ec87599fa48';

afterEach(async () => {
  delete process.env.QWEN_CACHE;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; source: string; marker: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-plugin-bundle-'));
  dirs.push(root);
  const source = path.join(root, 'qwen-core');
  const marker = path.join(root, 'javascript-entry-ran');
  await mkdir(path.join(source, '.codex-plugin'), { recursive: true });
  await mkdir(path.join(source, 'skill'), { recursive: true });
  await writeFile(path.join(source, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'qwen-mm-plugins-core',
    version: '1.0.0',
    description: 'Qwen multimodal core',
    skills: './skill',
    mcpServers: './.mcp.json',
  }));
  await writeFile(path.join(source, '.mcp.json'), JSON.stringify({
    mcpServers: {
      'qwen-mm-plugins-core': {
        command: 'uvx',
        args: [
          '--from',
          'qwen-mm-plugins[core] @ git+https://github.com/QwenLM/Qwen-MM-Plugins.git@main',
          'qwen-mm-plugins-core',
        ],
        env: { QWEN_CACHE: '${QWEN_CACHE}' },
      },
    },
  }));
  await writeFile(path.join(source, 'skill', 'SKILL.md'), [
    '---',
    'name: qwen-mm-plugins-core',
    'description: Read and visualize multimodal files.',
    '---',
    '',
    '# Qwen-MM core',
  ].join('\n'));
  await writeFile(
    path.join(source, 'index.js'),
    `await import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(marker)}, 'ran'));`,
  );
  return { root, source, marker };
}

class FakeMcpClient {
  connectCalls = 0;
  callCalls = 0;
  closeCalls = 0;

  async connect(): Promise<void> { this.connectCalls += 1; }
  async listTools() {
    return { tools: [{ name: 'visualize', inputSchema: { type: 'object', properties: {} } }] };
  }
  async callTool() {
    this.callCalls += 1;
    return { content: [{ type: 'text', text: 'visualized' }] };
  }
  async close(): Promise<void> { this.closeCalls += 1; }
}

class NoopModelApi implements ModelApi {
  async createMessage(_request: ModelRequest): Promise<Message> {
    throw new Error('Unexpected model request.');
  }
  streamMessage(_request: ModelRequest): ModelStreamHandle {
    throw new Error('Unexpected model stream.');
  }
}

describe('Skill+MCP plugin bundles', () => {
  it('ships an inert disabled Qwen-MM core recipe pinned to an exact commit', async () => {
    const recipe = JSON.parse(await readFile(
      new URL('../assets/plugin-recipes/qwen-mm-core.json', import.meta.url),
      'utf8',
    )) as Record<string, any>;
    expect(recipe).toMatchObject({
      schemaVersion: 1,
      id: 'qwen-mm-plugins-core',
      enabled: false,
      source: {
        repository: QWEN_SOURCE,
        commit: QWEN_COMMIT,
        subdirectory: 'src/capabilities/core',
      },
    });
    expect(recipe.install.hadamard).toContain(`--commit=${QWEN_COMMIT}`);
  });

  it('discovers, reviews, trusts, starts, calls, disables, and uninstalls without importing JS', async () => {
    const { root, source, marker } = await fixture();
    const manager = new PluginPackageManager(path.join(root, 'installed'));
    await manager.execute(
      `install ${source} --source=${QWEN_SOURCE} --commit=${QWEN_COMMIT}`,
    );

    expect(await manager.snapshot()).toEqual([
      expect.objectContaining({
        id: 'qwen-mm-plugins-core',
        packageType: 'skill-mcp-bundle',
        enabled: false,
        trusted: false,
        commit: QWEN_COMMIT,
        network: true,
        fileAccess: ['read', 'write'],
      }),
    ]);
    const inspection = await manager.execute('inspect qwen-mm-plugins-core');
    expect(inspection.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Commit', description: QWEN_COMMIT }),
      expect.objectContaining({ label: 'Environment', description: 'QWEN_CACHE' }),
      expect.objectContaining({ label: 'Network', description: 'requested' }),
      expect.objectContaining({ label: 'Files', description: 'read + write' }),
      expect.objectContaining({
        label: 'Startup · qwen-mm-plugins-core',
        description: expect.stringContaining(`@${QWEN_COMMIT}`),
      }),
    ]));

    await manager.execute('enable qwen-mm-plugins-core');
    const loader = new PluginLoader(manager.packages, manager.trust);
    await expect(loader.load('qwen-mm-plugins-core')).rejects.toThrow('not trusted');
    await expect(access(marker)).rejects.toThrow();

    await manager.execute('trust qwen-mm-plugins-core');
    process.env.QWEN_CACHE = path.join(root, 'cache');
    const loaded = await loader.load('qwen-mm-plugins-core') as Awaited<ReturnType<PluginLoader['loadEnabledBundles']>>[number];
    expect(loaded.kind).toBe('skill-mcp-bundle');
    expect(loaded.skillRoots[0]).toBe(path.join(loaded.packagePath, 'skill'));
    expect(loaded.mcpServers[0]).toMatchObject({
      kind: 'stdio',
      command: 'uvx',
      args: expect.arrayContaining([expect.stringContaining(`@${QWEN_COMMIT}`)]),
      env: { QWEN_CACHE: path.join(root, 'cache') },
      contentProvenance: expect.objectContaining({
        trust: 'untrusted',
        pluginId: 'qwen-mm-plugins-core',
        commit: QWEN_COMMIT,
      }),
    });
    await expect(access(marker)).rejects.toThrow();

    const fake = new FakeMcpClient();
    const connections = new McpConnectionManager(
      { name: 'plugin-test', version: '1' },
      { clientFactory: () => fake as never },
    );
    const adapters = await connections.resolveToolAdapters([], loaded.mcpServers);
    expect(fake.connectCalls).toBe(1);
    const result = await adapters[0]!.execute({}, {
      runId: 'run-1',
      cwd: root,
      metadata: {},
      prompt: 'visualize',
      iteration: 1,
    } satisfies ToolExecutionContext);
    expect(JSON.stringify(result)).toContain('visualized');
    expect(result.text).toContain('[Untrusted plugin content · qwen-mm-plugins-core · sha256:');
    expect(result.rawOutput).toEqual(expect.objectContaining({
      hadamardProvenance: expect.objectContaining({
        pluginId: 'qwen-mm-plugins-core',
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    }));
    expect(fake.callCalls).toBe(1);
    await connections.closeAll();

    await manager.execute('disable qwen-mm-plugins-core');
    await expect(loader.loadEnabledBundles()).resolves.toEqual([]);
    await manager.execute('remove qwen-mm-plugins-core');
    await expect(manager.packages.list()).resolves.toEqual([]);
  });

  it('automatically registers trusted enabled bundle skills in the Hadamard SDK', async () => {
    const { root, source } = await fixture();
    const dataRoot = path.join(root, '.hadamard');
    const workDir = path.join(root, 'work');
    const manager = new PluginPackageManager(path.join(dataRoot, 'plugin-packages'));
    await mkdir(workDir, { recursive: true });
    await manager.execute(
      `install ${source} --source=${QWEN_SOURCE} --commit=${QWEN_COMMIT}`,
    );
    await manager.execute('trust qwen-mm-plugins-core');
    await manager.execute('enable qwen-mm-plugins-core');
    process.env.QWEN_CACHE = path.join(root, 'cache');

    const sdk = await createAgentSdk({
      homeDir: dataRoot,
      workDir,
      sessionDirectory: path.join(root, 'sessions'),
      model: 'test-model',
      modelApi: new NoopModelApi(),
    });
    try {
      expect(sdk.skills.listMetadata()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'qwen-mm-plugins-core' }),
      ]));
    } finally {
      await sdk.close();
    }
  });

  it('refuses an installed bundle whose files change after trust', async () => {
    const { root, source } = await fixture();
    const manager = new PluginPackageManager(path.join(root, 'installed'));
    await manager.execute(
      `install ${source} --source=${QWEN_SOURCE} --commit=${QWEN_COMMIT}`,
    );
    await manager.execute('trust qwen-mm-plugins-core');
    await manager.execute('enable qwen-mm-plugins-core');
    const [installed] = await manager.packages.list();
    await writeFile(path.join(installed!.packagePath, 'skill', 'SKILL.md'), 'tampered');

    await expect(manager.packages.list()).resolves.toEqual([]);
    await expect(new PluginLoader(manager.packages, manager.trust).load('qwen-mm-plugins-core'))
      .rejects.toThrow('not enabled');
  });
});
