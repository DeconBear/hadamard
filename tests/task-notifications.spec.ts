import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildTerminalNotifySequence,
  formatTaskSettledNotification,
  resolveTaskNotificationOptions,
} from '../src/extensions/taskNotifications.js';
import { createAgentSdk } from '../src/index.js';
import type { ModelApi, ModelRequest, ModelStreamHandle } from '../src/index.js';
import type { Message, MessageStreamEvent } from '../src/provider/types.js';
import type { HadamardBackgroundTaskRecord } from '../src/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fakeHome(): Promise<{ homeDir: string; sessionDirectory: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-task-notify-'));
  tempDirs.push(root);
  const homeDir = path.join(root, '.hadamard');
  const sessionDirectory = path.join(root, 'sessions');
  await mkdir(homeDir, { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  return { homeDir, sessionDirectory };
}

function makeTask(
  overrides: Partial<HadamardBackgroundTaskRecord>,
): HadamardBackgroundTaskRecord {
  return {
    id: 'task_1',
    status: 'completed',
    description: 'List files',
    subagentType: 'bash',
    outputFile: 'unused',
    workDir: 'C:/work',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:01:00.000Z',
    ...overrides,
  };
}

describe('formatTaskSettledNotification', () => {
  it('formats a completed task with its result text', () => {
    const note = formatTaskSettledNotification(makeTask({
      status: 'completed',
      text: '  done\nwith details  ',
    }));
    expect(note.title).toBe('Background task completed: List files');
    expect(note.body).toBe('done with details');
  });

  it('formats a failed agent task with its error', () => {
    const note = formatTaskSettledNotification(makeTask({
      status: 'failed',
      subagentType: 'reviewer',
      agentName: 'release-reviewer',
      error: 'model exploded',
    }));
    expect(note.title).toBe('Background task failed: release-reviewer');
    expect(note.body).toBe('model exploded');
  });

  it('formats a cancelled task from partial text', () => {
    const note = formatTaskSettledNotification(makeTask({
      status: 'cancelled',
      partialText: 'half way there',
    }));
    expect(note.title).toBe('Background task cancelled: List files');
    expect(note.body).toBe('half way there');
  });

  it('truncates long bodies to ~200 chars', () => {
    const note = formatTaskSettledNotification(makeTask({
      status: 'completed',
      text: 'x'.repeat(500),
    }));
    expect(note.body).toHaveLength(200);
    expect(note.body.endsWith('…')).toBe(true);
  });

  it('omits the label when neither agentName nor description is set', () => {
    const note = formatTaskSettledNotification(makeTask({ description: '', agentName: undefined }));
    expect(note.title).toBe('Background task completed');
  });
});

describe('resolveTaskNotificationOptions', () => {
  it('defaults bell and osc to true', () => {
    expect(resolveTaskNotificationOptions(undefined)).toEqual({ bell: true, osc: true });
    expect(resolveTaskNotificationOptions({})).toEqual({ bell: true, osc: true });
  });

  it('honors explicit false values', () => {
    expect(resolveTaskNotificationOptions({ bell: false })).toEqual({ bell: false, osc: true });
    expect(resolveTaskNotificationOptions({ osc: false })).toEqual({ bell: true, osc: false });
  });
});

describe('buildTerminalNotifySequence', () => {
  const note = { title: 'Background task completed: List files', body: '3 files' };

  it('emits bell + OSC 777 + OSC 9 by default', () => {
    expect(buildTerminalNotifySequence(note, { bell: true, osc: true })).toBe(
      '\x07'
      + '\x1b]777;notify;Background task completed: List files;3 files\x1b\\'
      + '\x1b]9;3 files\x1b\\',
    );
  });

  it('emits only the bell when osc is off', () => {
    expect(buildTerminalNotifySequence(note, { bell: true, osc: false })).toBe('\x07');
  });

  it('emits only OSC sequences when bell is off', () => {
    const sequence = buildTerminalNotifySequence(note, { bell: false, osc: true });
    expect(sequence).not.toContain('\x07');
    expect(sequence).toContain('\x1b]777;notify;');
    expect(sequence).toContain('\x1b]9;3 files\x1b\\');
  });

  it('emits nothing when both are off', () => {
    expect(buildTerminalNotifySequence(note, { bell: false, osc: false })).toBe('');
  });

  it('strips escape characters and newlines from title/body', () => {
    const sequence = buildTerminalNotifySequence(
      { title: 'evil\x1b]0;pwned\x07title', body: 'line1\nline2\x9c' },
      { bell: false, osc: true },
    );
    expect(sequence).toBe(
      '\x1b]777;notify;evil ]0;pwned title;line1 line2\x1b\\'
      + '\x1b]9;line1 line2\x1b\\',
    );
  });
});

// ── Client fan-out ──────────────────────────────────────────────────────────

class MockStream implements ModelStreamHandle {
  constructor(private readonly message: Message) {}
  async finalMessage(): Promise<Message> {
    return this.message;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
    // no streaming events needed for these tests
  }
}

function makeMessage(
  content: unknown[],
  stopReason: 'end_turn' | 'tool_use' = 'end_turn',
): Message {
  return {
    id: 'msg_test',
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

/** Model API: the main session launches a background reviewer; the reviewer replies or fails. */
function makeModelApi(options: { failReviewer?: boolean } = {}): ModelApi {
  let mainCalls = 0;
  return {
    async createMessage(request: ModelRequest): Promise<Message> {
      const isReviewer = request.system?.includes('Review code carefully');
      if (isReviewer) {
        if (options.failReviewer) throw new Error('reviewer exploded');
        return makeMessage([{ type: 'text', text: 'Background reviewer summary.' }]);
      }
      mainCalls += 1;
      if (mainCalls === 1) {
        return makeMessage(
          [
            { type: 'text', text: 'Launching a background reviewer.' },
            {
              type: 'tool_use',
              id: 'toolu_task_bg_1',
              name: 'Task',
              input: {
                description: 'Review the release flow in the background.',
                subagent_type: 'reviewer',
                run_in_background: true,
              },
            },
          ],
          'tool_use',
        );
      }
      return makeMessage([{ type: 'text', text: 'The reviewer is running in the background.' }]);
    },
    streamMessage(request: ModelRequest): ModelStreamHandle {
      throw new Error(`Unexpected streamMessage call: ${request.model}`);
    },
  };
}

async function launchBackgroundReview(sdk: Awaited<ReturnType<typeof createAgentSdk>>): Promise<string> {
  const result = await sdk.run('Start a background review.');
  const taskOutput = result.toolCalls[0]?.output as Record<string, unknown> | undefined;
  const taskId = typeof taskOutput?.taskId === 'string' ? taskOutput.taskId : undefined;
  expect(taskId).toBeTruthy();
  return taskId!;
}

describe('HadamardAgentClient.onBackgroundTaskSettled', () => {
  it('notifies subscribers when a background task completes', async () => {
    const { homeDir, sessionDirectory } = await fakeHome();
    const sdk = await createAgentSdk({
      model: 'test-model',
      homeDir,
      sessionDirectory,
      modelApi: makeModelApi(),
      agents: [{
        name: 'reviewer',
        description: 'Review changes and call out risks.',
        systemPrompt: 'Review code carefully and focus on risks.',
      }],
    });
    try {
      const settled: HadamardBackgroundTaskRecord[] = [];
      sdk.onBackgroundTaskSettled((task) => settled.push(task));

      const taskId = await launchBackgroundReview(sdk);
      const task = await sdk.tasks.wait(taskId);
      expect(task.status).toBe('completed');
      await vi.waitFor(() => {
        expect(settled.some((entry) => entry.id === taskId && entry.status === 'completed')).toBe(true);
      });
      const note = formatTaskSettledNotification(settled.find((entry) => entry.id === taskId)!);
      expect(note.title).toContain('Background task completed');
    } finally {
      await sdk.close();
    }
  });

  it('notifies subscribers when a background task fails', async () => {
    const { homeDir, sessionDirectory } = await fakeHome();
    const sdk = await createAgentSdk({
      model: 'test-model',
      homeDir,
      sessionDirectory,
      modelApi: makeModelApi({ failReviewer: true }),
      agents: [{
        name: 'reviewer',
        description: 'Review changes and call out risks.',
        systemPrompt: 'Review code carefully and focus on risks.',
      }],
    });
    try {
      const settled: HadamardBackgroundTaskRecord[] = [];
      sdk.onBackgroundTaskSettled((task) => settled.push(task));

      const taskId = await launchBackgroundReview(sdk);
      const task = await sdk.tasks.wait(taskId);
      expect(task.status).toBe('failed');
      await vi.waitFor(() => {
        expect(settled.some((entry) => entry.id === taskId && entry.status === 'failed')).toBe(true);
      });
    } finally {
      await sdk.close();
    }
  });

  it('stops notifying after unsubscribe and isolates listener errors', async () => {
    const { homeDir, sessionDirectory } = await fakeHome();
    const sdk = await createAgentSdk({
      model: 'test-model',
      homeDir,
      sessionDirectory,
      modelApi: makeModelApi(),
      agents: [{
        name: 'reviewer',
        description: 'Review changes and call out risks.',
        systemPrompt: 'Review code carefully and focus on risks.',
      }],
    });
    try {
      const unsubscribed: HadamardBackgroundTaskRecord[] = [];
      const good: HadamardBackgroundTaskRecord[] = [];
      const unsubscribe = sdk.onBackgroundTaskSettled((task) => unsubscribed.push(task));
      unsubscribe();
      // A throwing listener must not break the settle path or other listeners.
      sdk.onBackgroundTaskSettled(() => {
        throw new Error('listener exploded');
      });
      sdk.onBackgroundTaskSettled((task) => good.push(task));

      const taskId = await launchBackgroundReview(sdk);
      const task = await sdk.tasks.wait(taskId);
      expect(task.status).toBe('completed');
      await vi.waitFor(() => {
        expect(good.some((entry) => entry.id === taskId)).toBe(true);
      });
      expect(unsubscribed).toHaveLength(0);
    } finally {
      await sdk.close();
    }
  });
});
