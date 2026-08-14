import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HADAMARD_PROJECT_INSTRUCTION_STATE_KEY,
  HadamardProviderApiError,
  createAgentSdk,
  parseProjectInstructionState,
  type ModelApi,
  type ModelRequest,
  type ModelStreamHandle,
} from '../src/index.js';
import type { Message, MessageStreamEvent } from '../src/provider/types.js';
import { extractTextFromContent } from '../src/runtime/messageUtils.js';

const tempDirs: string[] = [];
let messageCounter = 0;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeMessage(content: unknown[], stopReason: 'end_turn' | 'tool_use' = 'end_turn'): Message {
  messageCounter += 1;
  return {
    id: `msg_${messageCounter}`,
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: content as Message['content'],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 10,
      output_tokens: 5,
    },
  } as Message;
}

class MockStream implements ModelStreamHandle {
  constructor(
    private readonly events: MessageStreamEvent[],
    private readonly message: Message,
  ) {}

  async finalMessage(): Promise<Message> {
    return this.message;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
    for (const event of this.events) {
      yield event;
    }
  }
}

class MockModelApi implements ModelApi {
  readonly createCalls: ModelRequest[] = [];
  readonly streamCalls: ModelRequest[] = [];

  constructor(
    private readonly handlers: {
      create?: (request: ModelRequest, index: number) => Message | Promise<Message>;
    },
  ) {}

  async createMessage(request: ModelRequest): Promise<Message> {
    this.createCalls.push(structuredClone(request));
    if (!this.handlers.create) {
      throw new Error('Unexpected createMessage call.');
    }
    return this.handlers.create(request, this.createCalls.length - 1);
  }

  streamMessage(request: ModelRequest): ModelStreamHandle {
    this.streamCalls.push(structuredClone(request));
    throw new Error('Unexpected streamMessage call.');
  }
}

function requestText(request: ModelRequest | undefined): string {
  const system = String(request?.system ?? '');
  const messages = (request?.messages ?? []).map(message => extractTextFromContent(message.content)).join('\n');
  return `${system}\n${messages}`;
}

function projectInstructionMessages(request: ModelRequest | undefined) {
  return (request?.messages ?? []).filter(message =>
    message.role === 'user'
    && typeof message.content === 'string'
    && message.content.includes('# Project instructions'),
  );
}

function regularModelRequests(modelApi: MockModelApi): ModelRequest[] {
  return modelApi.createCalls.filter(request => {
    const task = (request.metadata as Record<string, unknown> | undefined)?.hadamard_internal_task;
    return task !== 'compact' && task !== 'loop_compact';
  });
}

async function isolatedProject(agentsBody: string) {
  const root = await makeDir('pir-');
  const workDir = path.join(root, 'work');
  const homeDir = path.join(root, 'home');
  const sessionDirectory = path.join(root, 'sessions');
  await mkdir(workDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await writeFile(path.join(workDir, 'AGENTS.md'), agentsBody, 'utf8');
  return { workDir, homeDir, sessionDirectory };
}

describe('project instruction runtime', () => {
  it('injects project instructions as the first user-role prefix and not into system', async () => {
    const { workDir, homeDir, sessionDirectory } = await isolatedProject('# Rules\nPrefer small diffs.\n');
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'Noted.' }]),
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      workDir,
      modelApi,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
    });

    try {
      const session = await sdk.createSession();
      await session.send('Ship a fix.');
      const request = regularModelRequests(modelApi)[0];
      expect(projectInstructionMessages(request)).toHaveLength(1);
      expect(request?.messages[0]).toMatchObject({
        role: 'user',
        content: expect.stringContaining('Prefer small diffs.'),
      });
      expect(request?.messages[0]).not.toHaveProperty('__hadamardContext');
      expect(session.messages[0]).toHaveProperty('__hadamardContext.kind', 'project-instructions');
      expect(request?.messages.some(message =>
        message.role === 'user' && extractTextFromContent(message.content) === 'Ship a fix.',
      )).toBe(true);
      expect(String(request?.system ?? '')).not.toContain('Prefer small diffs.');
      expect(parseProjectInstructionState(session.metadata)?.sources.length).toBeGreaterThan(0);
      expect(session.metadata[HADAMARD_PROJECT_INSTRUCTION_STATE_KEY]).toMatchObject({
        version: 1,
        injectedAtCompactCount: 0,
      });
    } finally {
      await sdk.close();
    }
  });

  it('does not repeat project instructions on the next ordinary turn', async () => {
    const { workDir, homeDir, sessionDirectory } = await isolatedProject('# Rules\nKeep comments rare.\n');
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'ok' }]),
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      workDir,
      modelApi,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
    });

    try {
      const session = await sdk.createSession();
      await session.send('First turn.');
      await session.send('Second turn.');
      const first = projectInstructionMessages(regularModelRequests(modelApi)[0]);
      const second = projectInstructionMessages(regularModelRequests(modelApi)[1]);
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(second[0]?.content).toBe(first[0]?.content);
    } finally {
      await sdk.close();
    }
  });

  it('replaces stale context when AGENTS.md changes', async () => {
    const { workDir, homeDir, sessionDirectory } = await isolatedProject('# Rules\nAlpha.\n');
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'ok' }]),
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      workDir,
      modelApi,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
    });

    try {
      const session = await sdk.createSession();
      await session.send('Start.');
      await writeFile(path.join(workDir, 'AGENTS.md'), '# Rules\nBeta.\n', 'utf8');
      await session.send('Continue.');
      const second = regularModelRequests(modelApi)[1];
      const injected = projectInstructionMessages(second);
      expect(injected).toHaveLength(1);
      expect(injected.at(-1)?.content).toContain('supersede');
      expect(injected.at(-1)?.content).toContain('Beta.');
      expect(requestText(second)).not.toContain('Alpha.');
    } finally {
      await sdk.close();
    }
  });

  it('clears project instructions when the file becomes empty', async () => {
    const { workDir, homeDir, sessionDirectory } = await isolatedProject('# Rules\nKeep me.\n');
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'ok' }]),
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      workDir,
      modelApi,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
    });

    try {
      const session = await sdk.createSession();
      await session.send('Start.');
      await writeFile(path.join(workDir, 'AGENTS.md'), '\n', 'utf8');
      await session.send('Continue.');
      const request = regularModelRequests(modelApi)[1];
      expect(projectInstructionMessages(request)).toHaveLength(1);
      const latest = projectInstructionMessages(request).at(-1);
      expect(latest?.content).toContain('no longer apply');
      expect(requestText(request)).not.toContain('Keep me.');
    } finally {
      await sdk.close();
    }
  });

  it('recomputes instructions when workDir changes', async () => {
    const { workDir, homeDir, sessionDirectory } = await isolatedProject('# Rules\nRoot scope.\n');
    const nested = path.join(workDir, 'pkg');
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, 'AGENTS.md'), '# Nested\nPackage scope.\n', 'utf8');
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'ok' }]),
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      workDir,
      modelApi,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
    });

    try {
      const session = await sdk.createSession();
      await session.send('In root.');
      await session.send('In package.', { workDir: nested });
      const request = regularModelRequests(modelApi)[1];
      expect(projectInstructionMessages(request)).toHaveLength(1);
      const latest = projectInstructionMessages(request).at(-1);
      expect(latest?.content).toContain('supersede');
      expect(latest?.content).toContain('Root scope.');
      expect(latest?.content).toContain('Package scope.');
    } finally {
      await sdk.close();
    }
  });

  it('restores after manual compact and does not repeat on the following turn', async () => {
    const { workDir, homeDir, sessionDirectory } = await isolatedProject('# Rules\nAfter compact.\n');
    const modelApi = new MockModelApi({
      create: (request) => {
        if ((request.metadata as Record<string, unknown> | undefined)?.hadamard_internal_task === 'compact') {
          return makeMessage([{ type: 'text', text: 'Compact summary of prior work.' }]);
        }
        return makeMessage([{ type: 'text', text: 'ok' }]);
      },
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      workDir,
      modelApi,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
    });

    try {
      const session = await sdk.createSession();
      await session.send('Before compact.');
      await session.compact({ force: true, preserveRecentMessages: 1 });
      await session.send('After compact.');
      await session.send('Still after compact.');
      const afterCompact = regularModelRequests(modelApi).slice(1);
      expect(afterCompact).toHaveLength(2);
      expect(projectInstructionMessages(afterCompact[0])).toHaveLength(1);
      expect(projectInstructionMessages(afterCompact[0]).at(-1)?.content).toContain('Restored after context compaction');
      expect(projectInstructionMessages(afterCompact[1])).toHaveLength(1);
      expect(parseProjectInstructionState(session.metadata)?.injectedAtCompactCount).toBe(1);
    } finally {
      await sdk.close();
    }
  });

  it('restores on the reactive compact retry of the same turn', async () => {
    const { workDir, homeDir, sessionDirectory } = await isolatedProject('# Rules\nReactive restore.\n');
    let nonCompactCalls = 0;
    const modelApi = new MockModelApi({
      create: (request) => {
        const task = (request.metadata as Record<string, unknown> | undefined)?.hadamard_internal_task;
        if (task === 'compact' || task === 'loop_compact') {
          return makeMessage([{ type: 'text', text: 'Reactive chain summary' }]);
        }
        nonCompactCalls += 1;
        if (nonCompactCalls === 1) {
          return makeMessage([{ type: 'text', text: 'Seeded.' }]);
        }
        if (nonCompactCalls <= 3) {
          throw new HadamardProviderApiError(
            'Provider request failed with HTTP 413: Prompt is too long',
            { status: 413 },
          );
        }
        return makeMessage([{ type: 'text', text: 'Recovered.' }]);
      },
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      workDir,
      modelApi,
      compact: { preserveRecentMessages: 1 },
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
    });

    try {
      const session = await sdk.createSession();
      await session.send('Seed.');
      const result = await session.send('Continue after overflow.');
      expect(result.text).toContain('Recovered.');
      const recoveredRequest = regularModelRequests(modelApi).at(-1);
      expect(extractTextFromContent(recoveredRequest!.messages.at(-1)!.content))
        .toBe('Continue after overflow.');
      await session.send('Follow-up after reactive compact.');
      const followUp = regularModelRequests(modelApi).at(-1);
      expect(requestText(followUp)).toContain('Reactive restore.');
      expect(projectInstructionMessages(followUp).length).toBeGreaterThan(0);
      expect(parseProjectInstructionState(session.metadata)?.injectedAtCompactCount).toBeGreaterThan(0);
    } finally {
      await sdk.close();
    }
  });

  it('resumes without duplicating project instructions', async () => {
    const { workDir, homeDir, sessionDirectory } = await isolatedProject('# Rules\nResume stable.\n');
    const firstApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'first' }]),
    });
    const firstSdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      workDir,
      modelApi: firstApi,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
    });
    const session = await firstSdk.createSession();
    await session.send('Start.');
    const sessionId = session.id;
    const hash = parseProjectInstructionState(session.metadata)?.contentHash;
    await firstSdk.close();

    const secondApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'second' }]),
    });
    const secondSdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      workDir,
      modelApi: secondApi,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
    });
    try {
      const resumed = await secondSdk.resumeSession(sessionId);
      await resumed.send('Continue.');
      expect(projectInstructionMessages(regularModelRequests(secondApi)[0])).toHaveLength(1);
      expect(parseProjectInstructionState(resumed.metadata)?.contentHash).toBe(hash);
    } finally {
      await secondSdk.close();
    }
  });

  it('forks keep state until cwd changes', async () => {
    const { workDir, homeDir, sessionDirectory } = await isolatedProject('# Rules\nFork root.\n');
    const other = path.join(path.dirname(workDir), 'other');
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, 'AGENTS.md'), '# Other\nFork other.\n', 'utf8');
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'ok' }]),
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      workDir,
      modelApi,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
    });

    try {
      const session = await sdk.createSession();
      await session.send('Root.');
      const forked = await session.fork({ title: 'Fork' });
      await forked.send('Same cwd.');
      expect(projectInstructionMessages(regularModelRequests(modelApi)[1])).toHaveLength(1);
      await forked.send('Moved.', { workDir: other });
      expect(projectInstructionMessages(regularModelRequests(modelApi)[2]).at(-1)?.content).toContain('Fork other.');
    } finally {
      await sdk.close();
    }
  });

  it('injects on every standalone run without a session', async () => {
    const { workDir, homeDir, sessionDirectory } = await isolatedProject('# Rules\nNo session.\n');
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'ok' }]),
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      workDir,
      modelApi,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
    });

    try {
      await sdk.run('One.');
      await sdk.run('Two.');
      expect(projectInstructionMessages(regularModelRequests(modelApi)[0])).toHaveLength(1);
      expect(projectInstructionMessages(regularModelRequests(modelApi)[1])).toHaveLength(1);
    } finally {
      await sdk.close();
    }
  });

  it('lets Explore omit project instructions while general-purpose inherits them', async () => {
    const { workDir, homeDir, sessionDirectory } = await isolatedProject('# Rules\nMust follow.\n');
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'ok' }]),
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      workDir,
      modelApi,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
    });

    try {
      await sdk.runWithAgent('Explore', 'Look around.');
      expect(projectInstructionMessages(regularModelRequests(modelApi)[0])).toHaveLength(0);
      expect(requestText(regularModelRequests(modelApi)[0])).not.toContain('Must follow.');
      await sdk.runWithAgent('general-purpose', 'Implement the change.');
      expect(projectInstructionMessages(regularModelRequests(modelApi)[1])).toHaveLength(1);
      expect(requestText(regularModelRequests(modelApi)[1])).toContain('Must follow.');
    } finally {
      await sdk.close();
    }
  });

  it('propagates project-instruction mode and roots through the Agent tool', async () => {
    const { workDir, homeDir, sessionDirectory } = await isolatedProject('# Agents only\nDo not load this.\n');
    await writeFile(path.join(workDir, 'CLAUDE.md'), '# Claude only\nChild inherits this.\n', 'utf8');
    const modelApi = new MockModelApi({
      create: (request) => {
        if (String(request.system ?? '').includes('general-purpose Hadamard subagent')) {
          return makeMessage([{ type: 'text', text: 'Child done.' }]);
        }
        if (!request.messages.some(message =>
          Array.isArray(message.content)
          && message.content.some(block => block.type === 'tool_result'),
        )) {
          return makeMessage([{
            type: 'tool_use',
            id: 'toolu_project_context_child',
            name: 'Agent',
            input: {
              description: 'Check context',
              prompt: 'Report the active project instructions.',
              subagent_type: 'general-purpose',
            },
          }], 'tool_use');
        }
        return makeMessage([{ type: 'text', text: 'Parent done.' }]);
      },
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      workDir,
      modelApi,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
    });

    try {
      const session = await sdk.createSession();
      await session.send('Delegate this check.', {
        projectInstructions: { mode: 'claude', workPaths: [workDir] },
      });
      const childRequest = regularModelRequests(modelApi).find(request =>
        String(request.system ?? '').includes('general-purpose Hadamard subagent'),
      );
      expect(requestText(childRequest)).toContain('Child inherits this.');
      expect(requestText(childRequest)).not.toContain('Do not load this.');
    } finally {
      await sdk.close();
    }
  });

  it('does not inject Hadamard project instructions into external CLI agents', async () => {
    const { workDir, homeDir, sessionDirectory } = await isolatedProject('# Rules\nExternal.\n');
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'should not run' }]),
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      workDir,
      modelApi,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
      agents: [{
        name: 'external-reviewer',
        description: 'External CLI agent',
        runtime: 'claude',
        systemPrompt: 'Review externally.',
      }],
      externalAgentRunner: async () => ({ text: 'external done' }),
    });

    try {
      const result = await sdk.runWithAgent('external-reviewer', 'Review this.');
      expect(result.text).toBe('external done');
      expect(modelApi.createCalls).toHaveLength(0);
    } finally {
      await sdk.close();
    }
  });

  it('strips a recognizable legacy Hadamard project section from resumed system prompts', async () => {
    const { workDir, homeDir, sessionDirectory } = await isolatedProject('# Rules\nLive file.\n');
    const modelApi = new MockModelApi({
      create: () => makeMessage([{ type: 'text', text: 'ok' }]),
    });
    const sdk = await createAgentSdk({
      model: 'test-model',
      sessionDirectory,
      homeDir,
      workDir,
      modelApi,
      disableDefaultSkills: true,
      loadDefaultSkillDirectories: false,
    });

    try {
      const session = await sdk.createSession({
        systemPrompt: [
          `You are Hadamard Agent, an interactive CLI agent. Working directory: ${workDir}`,
          '',
          '# Project context (AGENTS.md)',
          '',
          'The following instruction files are authoritative guidance for this workspace.',
          '',
          'Stale system AGENTS body.',
        ].join('\n'),
      });
      await session.send('Go.');
      const system = String(regularModelRequests(modelApi)[0]?.system ?? '');
      expect(system).toContain('interactive CLI agent');
      expect(system).not.toContain('Stale system AGENTS body.');
      expect(system).not.toContain('# Project context (AGENTS.md)');
      expect(requestText(regularModelRequests(modelApi)[0])).toContain('Live file.');
    } finally {
      await sdk.close();
    }
  });
});
