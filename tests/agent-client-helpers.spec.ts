import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  formatTaskNotification,
  resolveTaskId,
  serializeBackgroundTaskOutput,
} from '../src/runtime/agentClientBackgroundHelpers.js';
import {
  createHadamardDreamClassifier,
  extractHadamardDreamTouchedFiles,
} from '../src/runtime/agentClientDreamHelpers.js';
import {
  combineAbortSignals,
  filterAgentTools,
  joinPromptParts,
  mergeUniqueByName,
  sanitizeWorkspaceName,
} from '../src/runtime/agentClientRunHelpers.js';
import type { AgentRunResult, HadamardBackgroundTaskRecord } from '../src/types.js';

describe('agent client helper collaborators', () => {
  it('preserves background task ids, output, and escaped notification text', () => {
    const task = {
      id: 'task<&>',
      status: 'completed',
      subagentType: 'reviewer',
      agentName: 'reviewer',
      description: 'Review',
      text: 'safe <result>',
    } as HadamardBackgroundTaskRecord;

    expect(resolveTaskId({ task_id: ' task-1 ' })).toBe('task-1');
    expect(serializeBackgroundTaskOutput(task)).toContain('Output:\nsafe <result>');
    expect(formatTaskNotification(task)).toContain('<task_id>task&lt;&amp;&gt;</task_id>');
    expect(formatTaskNotification(task)).toContain('<result>safe &lt;result&gt;</result>');
  });

  it('preserves prompt, signal, tool-filter, merge, and workspace-name policies', () => {
    expect(joinPromptParts(undefined, 'one', 'two')).toBe('one\n\ntwo');
    expect(sanitizeWorkspaceName(' Review / Agent ')).toBe('Review-Agent');
    expect(mergeUniqueByName([{ name: 'a', value: 1 }], [{ name: 'a', value: 2 }]))
      .toEqual([{ name: 'a', value: 2 }]);

    const controller = new AbortController();
    expect(combineAbortSignals(undefined, controller.signal)).toBe(controller.signal);
    const tools = [
      { name: 'Read', aliases: ['read_file'] },
      { name: 'Write' },
    ] as never;
    expect(filterAgentTools(tools, ['read_file'], ['Write']).map(tool => tool.name)).toEqual(['Read']);
  });

  it('keeps Dream reads and writes inside the memory policy roots', () => {
    const memoryDir = path.resolve('memory');
    const transcriptDir = path.resolve('transcripts');
    const memoryEntrypoint = path.join(memoryDir, 'MEMORY.md');
    const memorySummaryPath = path.join(memoryDir, 'memory_summary.md');
    const classify = createHadamardDreamClassifier({
      memoryDir,
      teamMemoryDir: path.join(memoryDir, 'team'),
      transcriptDir,
      memoryEntrypoint,
      memorySummaryPath,
    });

    expect(classify({ publicName: 'Read', input: { file_path: memoryEntrypoint } } as never))
      .toMatchObject({ behavior: 'allow' });
    expect(classify({ publicName: 'Write', input: { file_path: path.join(memoryDir, 'topic.md') } } as never))
      .toMatchObject({ behavior: 'deny' });
    expect(extractHadamardDreamTouchedFiles({
      toolCalls: [
        { publicName: 'Write', input: { file_path: memoryEntrypoint } },
        { publicName: 'Read', input: { file_path: memorySummaryPath } },
      ],
    } as AgentRunResult)).toEqual([memoryEntrypoint]);
  });
});
