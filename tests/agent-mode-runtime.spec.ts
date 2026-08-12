import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createAgentSdk,
  tool,
  type ModelApi,
  type ModelRequest,
} from '../src/index.js';
import { writeProjectSettings } from '../src/config/projectSettings.js';
import type { Message } from '../src/provider/types.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

class CaptureModel implements ModelApi {
  readonly requests: ModelRequest[] = [];

  async createMessage(request: ModelRequest): Promise<Message> {
    this.requests.push(structuredClone(request));
    return {
      id: `mode-${this.requests.length}`,
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as Message;
  }

  streamMessage(): never {
    throw new Error('not used');
  }
}

describe('Agent mode runtime integration', () => {
  it('prunes prompt and tool schemas for ReAct, CodeAct, Hybrid, and Single', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-agent-mode-runtime-'));
    directories.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    const sessionDirectory = path.join(root, 'sessions');
    const modelApi = new CaptureModel();
    await writeProjectSettings(workDir, homeDir, {
      codeAct: { enabled: true, backend: 'process', securityMode: 'trusted' },
    });
    const echo = tool({
      name: 'Echo',
      description: 'Echo a value.',
      inputSchema: z.object({ value: z.string().optional() }),
    }, async input => input.value ?? 'echo');
    const sdk = await createAgentSdk({
      homeDir,
      workDir,
      sessionDirectory,
      model: 'test-model',
      modelApi,
      permissionMode: 'bypassPermissions',
    });

    try {
      for (const agentMode of ['react', 'codeact', 'hybrid', 'single'] as const) {
        await sdk.run(`run ${agentMode}`, {
          agentMode,
          inheritDefaultTools: false,
          tools: [echo],
          ...(agentMode === 'single' ? { allowedTools: ['Echo'] } : {}),
        });
      }

      const [react, codeact, hybrid, single] = modelApi.requests;
      expect(react?.tools?.map(item => item.name)).toEqual(['Echo']);
      expect(react?.system).not.toMatch(/CodeCell|kernel/i);

      expect(codeact?.tools?.map(item => item.name)).toEqual(['CodeCell']);
      expect(codeact?.system).toMatch(/CodeCell|code cell/i);
      expect(codeact?.system).not.toContain('Echo a value.');

      expect(hybrid?.tools?.map(item => item.name)).toEqual(['Echo', 'CodeCell']);
      expect(hybrid?.system).toContain('two action planes');

      expect(single?.tools?.map(item => item.name)).toEqual(['Echo']);
      expect(single?.system).toContain('at most one ordinary tool');
      expect(single?.system).not.toMatch(/CodeCell|kernel/i);
    } finally {
      await sdk.close();
    }
  });

  it('allows CodeAct selection without a project-level enable switch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-agent-mode-default-'));
    directories.push(root);
    const modelApi = new CaptureModel();
    const sdk = await createAgentSdk({
      homeDir: path.join(root, 'home'),
      workDir: path.join(root, 'work'),
      sessionDirectory: path.join(root, 'sessions'),
      model: 'test-model',
      modelApi,
      permissionMode: 'bypassPermissions',
    });
    try {
      await expect(sdk.run('select CodeAct', { agentMode: 'codeact' })).resolves.toMatchObject({
        stopReason: 'end_turn',
      });
      expect(modelApi.requests).toHaveLength(1);
      expect(modelApi.requests[0]?.tools?.map(item => item.name)).toEqual(['CodeCell']);
    } finally {
      await sdk.close();
    }
  });
});
