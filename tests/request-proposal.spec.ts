import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createAgentSdk, tool } from '../src/index.js';
import type { ModelApi, ModelRequest } from '../src/index.js';
import type { Message } from '../src/provider/types.js';

const tempDirs: string[] = [];
let messageId = 0;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeMessage(content: unknown[], stopReason: 'tool_use' | 'end_turn'): Message {
  messageId += 1;
  return {
    id: 'proposal-message-' + String(messageId),
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: content as Message['content'],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as Message;
}

class ProposalModel implements ModelApi {
  readonly calls: ModelRequest[] = [];
  async createMessage(request: ModelRequest): Promise<Message> {
    this.calls.push(structuredClone(request));
    if (this.calls.length === 1) {
      return makeMessage([{
        type: 'tool_use',
        id: 'tu_lookup_1',
        name: 'lookup',
        input: {},
      }], 'tool_use');
    }
    return makeMessage([{ type: 'text', text: 'done' }], 'end_turn');
  }
  streamMessage(): never {
    throw new Error('not used');
  }
}

describe('requestProposal hook', () => {
  it('re-routes model, effort, and maxTokens for the next request', async () => {
    const homeDir = await tempDir('hadamard-proposal-home-');
    const workDir = await tempDir('hadamard-proposal-work-');
    const sessionDirectory = await tempDir('hadamard-proposal-sessions-');
    const modelApi = new ProposalModel();
    const lookup = tool(
      { name: 'lookup', description: 'A lookup.', inputSchema: z.strictObject({}), isReadOnly: () => true },
      async () => 'result',
    );
    const sdk = await createAgentSdk({
      model: 'test-model',
      modelApi,
      homeDir,
      workDir,
      sessionDirectory,
    });
    const proposals: string[] = [];
    try {
      const result = await sdk.run('Look something up.', {
        tools: [lookup],
        permissionMode: 'bypassPermissions',
        requestProposal: context => {
          proposals.push(context.model + '@' + context.iteration);
          if (context.iteration === 1) {
            return { model: 'routed-model', effort: 'high', maxTokens: 1234 };
          }
          return undefined;
        },
      });
      expect(result.text).toContain('done');
      // The proposal runs before each request and applies to that same
      // request: iteration 1 is re-routed, iteration 2 keeps the route.
      expect(proposals[0]).toBe('test-model@1');
      expect(proposals[1]).toBe('routed-model@2');
      expect(modelApi.calls[0]?.model).toBe('routed-model');
      expect(modelApi.calls[0]?.max_tokens).toBe(1234);
      expect(modelApi.calls[0]?.effort).toBe('high');
      expect(modelApi.calls[1]?.model).toBe('routed-model');
      expect(modelApi.calls[1]?.max_tokens).toBe(1234);
    } finally {
      await sdk.close();
    }
  });

  it.each([
    [{ model: '   ' }, /model/i],
    [{ effort: 'extreme' }, /effort/i],
    [{ maxTokens: -1 }, /maxTokens/i],
    [{ maxTokens: 1.5 }, /maxTokens/i],
  ] as const)('rejects an invalid proposal before calling the provider: %o', async (proposal, expected) => {
    const homeDir = await tempDir('hadamard-proposal-home-');
    const workDir = await tempDir('hadamard-proposal-work-');
    const sessionDirectory = await tempDir('hadamard-proposal-sessions-');
    const modelApi = new ProposalModel();
    const sdk = await createAgentSdk({
      model: 'test-model', modelApi, homeDir, workDir, sessionDirectory,
    });
    try {
      await expect(sdk.run('Validate the proposal.', {
        requestProposal: () => proposal as never,
      })).rejects.toThrow(expected);
      expect(modelApi.calls).toHaveLength(0);
    } finally {
      await sdk.close();
    }
  });
});

describe('plan mode guidance', () => {
  it('injects a plan-mode guidance section into the system prompt', async () => {
    const homeDir = await tempDir('hadamard-plan-home-');
    const workDir = await tempDir('hadamard-plan-work-');
    const sessionDirectory = await tempDir('hadamard-plan-sessions-');
    const modelApi = new ProposalModel();
    const sdk = await createAgentSdk({
      model: 'test-model',
      modelApi,
      homeDir,
      workDir,
      sessionDirectory,
    });
    try {
      await sdk.run('Plan a small refactor.', {
        tools: [],
        permissionMode: 'plan',
        maxToolIterations: 1,
      });
      const system = String(modelApi.calls[0]?.system ?? '');
      expect(system).toContain('You are in plan mode.');
      expect(system).toContain('ExitPlanMode');
    } finally {
      await sdk.close();
    }
  });
});
