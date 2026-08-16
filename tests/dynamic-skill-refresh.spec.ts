import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createAgentSdk, loadHadamardSkillDefinitions, tool } from '../src/index.js';
import type { HadamardSkillDefinition, ModelApi, ModelRequest } from '../src/index.js';
import type { Message } from '../src/provider/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-skill-refresh-'));
  tempDirs.push(directory);
  return directory;
}

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + description + '\n---\n\n# Body\n', 'utf8');
}

class MockModelApi implements ModelApi {
  readonly calls: ModelRequest[] = [];
  onSecond: ((request: ModelRequest) => void) | undefined;
  private index = 0;
  private build(request: ModelRequest): Message {
    this.calls.push(structuredClone(request));
    this.index += 1;
    if (this.index === 2) this.onSecond?.(request);
    const content = this.index === 1
      ? [{ type: 'tool_use', id: 'tu_add', name: 'add_skill', input: {} }]
      : [{ type: 'text', text: 'done.' }];
    return {
      id: 'm' + this.index,
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: content as Message['content'],
      stop_reason: this.index === 1 ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as Message;
  }
  async createMessage(request: ModelRequest): Promise<Message> { return this.build(request); }
  streamMessage(request: ModelRequest) {
    const message = this.build(request);
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<never> {},
      finalMessage: () => Promise.resolve(message),
    };
  }
}


describe('dynamic skill injection', () => {
  it('keeps ~/.hadamard/skills as the first-priority source for same-name skills', async () => {
    const root = await workspace();
    const homeDir = path.join(root, 'home');
    const externalDir = path.join(root, 'external');
    await writeSkill(path.join(homeDir, 'skills'), 'dupe', 'user version');
    await writeSkill(externalDir, 'dupe', 'external version');
    const definitions = await loadHadamardSkillDefinitions({
      homeDir,
      workDir: root,
      skillDirectories: [externalDir],
    });
    const dupe = definitions.find((definition: HadamardSkillDefinition) => definition.name === 'dupe');
    expect(dupe?.description).toBe('user version');
  });

  it('refreshes the registry when a skill is installed mid-run and re-folds per iteration', async () => {
    const root = await workspace();
    const homeDir = path.join(root, 'home');
    // resolveHadamardHome appends `.hadamard`: the SDK's user skills dir is
    // <homeDir>/.hadamard/skills (i.e. ~/.hadamard/skills).
    const sdkSkillsDir = path.join(homeDir, '.hadamard', 'skills');
    await writeSkill(sdkSkillsDir, 'alpha', 'Alpha skill.');
    let sawNewSkill = false;
    const modelApi = new MockModelApi();
    modelApi.onSecond = (request) => {
      const toolsJson = JSON.stringify(request.tools);
      sawNewSkill = toolsJson.includes('beta');
    };
    const sdk = await createAgentSdk({
      model: 'test-model',
      homeDir,
      sessionDirectory: path.join(root, 'sessions'),
      workDir: root,
      modelApi,
    });
    const addSkillTool = tool(
      { name: 'add_skill', description: 'Installs a skill.', inputSchema: z.strictObject({}) },
      async () => {
        await writeSkill(sdkSkillsDir, 'beta', 'Beta skill.');
        return 'installed';
      },
    );
    try {
      await sdk.run('Install a skill.', { tools: [addSkillTool] });
      expect(sawNewSkill).toBe(true);
      const summaries = sdk.listSkillDefinitions().map((entry) => entry.name);
      expect(summaries).toContain('beta');
    } finally {
      await sdk.close();
    }
  });
});

