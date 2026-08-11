import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parsePluginPackageManifest } from '../src/index.js';

describe('plugin package manifest', () => {
  it('validates ids, SemVer, integrity, and package-local entries', () => {
    expect(parsePluginPackageManifest({
      schemaVersion: 1,
      id: 'review-tools',
      name: 'Review Tools',
      version: '1.2.3',
      entry: 'dist/index.js',
      capabilities: ['tools'],
    })).toMatchObject({ id: 'review-tools', version: '1.2.3' });
    expect(() => parsePluginPackageManifest({
      schemaVersion: 1,
      id: 'bad',
      name: 'Bad',
      version: '1.0.0',
      entry: '../outside.js',
      capabilities: [],
    })).toThrow('stay inside');
  });

  it('continues to read the v1 manifest fixture unchanged', async () => {
    const fixture = JSON.parse(await readFile(
      new URL('./fixtures/compat/hadamard-plugin-v1.json', import.meta.url),
      'utf8',
    ));
    expect(parsePluginPackageManifest(fixture)).toEqual(fixture);
  });

  it('normalizes Codex-style Skill+MCP bundles without requiring a JavaScript entry', () => {
    expect(parsePluginPackageManifest({
      name: 'qwen-mm-plugins-core',
      version: '1.0.0',
      description: 'Multimodal tools',
      skills: './skill',
      mcpServers: './.mcp.json',
    }, {
      integrity: 'sha256-YWJj',
      source: {
        kind: 'git',
        location: 'https://github.com/QwenLM/Qwen-MM-Plugins',
        commit: '8d6ea5a1f658260743307c52c2024ec87599fa48',
      },
    })).toMatchObject({
      packageType: 'skill-mcp-bundle',
      id: 'qwen-mm-plugins-core',
      skills: 'skill',
      mcpServers: '.mcp.json',
      capabilities: ['skills', 'mcp', 'process', 'network', 'filesystem.read', 'filesystem.write'],
    });
    expect(() => parsePluginPackageManifest({
      name: 'escape',
      version: '1.0.0',
      skills: '../outside',
    })).toThrow('stay inside');
  });
});
