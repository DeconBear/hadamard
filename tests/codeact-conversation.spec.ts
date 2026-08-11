import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAgentSdk,
  type ModelApi,
  type ModelRequest,
} from '../src/index.js';
import { writeProjectSettings } from '../src/config/projectSettings.js';
import type { Message } from '../src/provider/types.js';

const tempDirs: string[] = [];
let messageId = 0;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function message(content: unknown[], stopReason: 'tool_use' | 'end_turn'): Message {
  messageId += 1;
  return {
    id: `codeact-message-${messageId}`,
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: content as Message['content'],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as Message;
}

class CodeActModel implements ModelApi {
  readonly calls: ModelRequest[] = [];

  async createMessage(request: ModelRequest): Promise<Message> {
    this.calls.push(structuredClone(request));
    if (this.calls.length === 1) {
      return message([{
        type: 'tool_use',
        id: 'cell-tool-use',
        name: 'CodeCell',
        input: { language: 'python', code: 'print("x" * 6000)\n6 * 7' },
      }], 'tool_use');
    }
    expect(JSON.stringify(request.messages)).toContain('cell-tool-use');
    expect(JSON.stringify(request.messages)).toContain('Tool output was large');
    return message([{ type: 'text', text: 'The verified result is 42.' }], 'end_turn');
  }

  streamMessage(): never {
    throw new Error('not used');
  }
}

describe('CodeAct in the Hadamard outer loop', () => {
  it('keeps tool-use/result history paired and artifacts large cell output at write time', async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-codeact-loop-'));
    const sessionDirectory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-codeact-sessions-'));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'hadamard-codeact-home-'));
    tempDirs.push(workDir, sessionDirectory, homeDir);
    const modelApi = new CodeActModel();
    await writeProjectSettings(workDir, homeDir, {
      codeAct: {
        enabled: true,
        backend: 'process',
        securityMode: 'trusted',
        pythonCommand: process.platform === 'win32' ? 'python' : 'python3',
        executionTimeoutMs: 5_000,
      },
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      modelApi,
      workDir,
      homeDir,
      sessionDirectory,
      permissionMode: 'bypassPermissions',
      compact: { toolResultArtifactMaxChars: 1_000 },
    });
    try {
      const result = await sdk.run('Calculate and verify.', { agentMode: 'codeact' });
      expect(result.text).toContain('42');
      expect(modelApi.calls).toHaveLength(2);
      const serialized = JSON.stringify(result.messages);
      expect(serialized).toContain('cell-tool-use');
      expect(serialized).toContain('Tool output was large');
      expect(result.toolCalls[0]?.name).toBe('CodeCell');
    } finally {
      await sdk.close();
    }
  });
});
