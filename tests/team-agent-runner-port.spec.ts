import { describe, expect, it } from 'vitest';

import {
  getTeamAgentRunnerFactory,
  registerTeamAgentRunnerFactory,
} from '../src/application/teamAgentRunnerRegistry.js';
import type { CreateAgentSdkOptions } from '../src/types.js';
import { runMemberAgent } from '../src/team/teamRuntime.js';

describe('TeamAgentRunner port', () => {
  it('runs a member through the injected factory and closes the runtime', async () => {
    await import('../src/runtime/agentClient.js');
    const defaultFactory = getTeamAgentRunnerFactory();
    let received: CreateAgentSdkOptions | undefined;
    let closed = false;
    try {
      registerTeamAgentRunnerFactory(async (options) => {
        received = options;
        return {
          stream: () => ({
            async *[Symbol.asyncIterator]() {},
            result: Promise.resolve({
              text: 'team result',
              toolCalls: [],
              usage: { input_tokens: 11, output_tokens: 7 },
            } as never),
          }),
          close: async () => {
            closed = true;
          },
        };
      });

      const result = await runMemberAgent({
        identity: { id: 'reviewer', model: 'test-model', role: 'review' },
        member: { model: 'test-model' },
        task: 'Review this',
        systemPrompt: 'Be precise',
        cwd: process.cwd(),
        tools: [],
        maxIterations: 4,
        round: 1,
      });

      expect(received).toMatchObject({
        model: 'test-model',
        systemPrompt: 'Be precise',
        maxToolIterations: 4,
        workDir: process.cwd(),
      });
      expect(result).toMatchObject({
        report: 'team result',
        inputTokens: 11,
        outputTokens: 7,
      });
      expect(result.status.ok).toBe(true);
      expect(closed).toBe(true);
    } finally {
      registerTeamAgentRunnerFactory(defaultFactory);
    }
  });
});
