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
  applyResolvedToolDescriptions,
  buildCompactSkillToolPrompt,
  combineAbortSignals,
  filterAgentTools,
  joinPromptParts,
  mergeUniqueByName,
  sanitizeWorkspaceName,
} from '../src/runtime/agentClientRunHelpers.js';
import { createHadamardFileTools } from '../src/tools/hadamardFileTools.js';
import { createGoalTools, GOAL_TOOLS_PROMPT } from '../src/goal/goalTools.js';
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

  it('folds unique tool prompts into description and skips identical or shared blobs', async () => {
    const sharedSearch = '## File Search Tools (Glob & Grep)\nUse Glob and Grep.';
    const bash = {
      name: 'Bash',
      description: 'Run a shell command with timeout and sandbox notes.',
      prompt: () => 'Run a shell command with timeout and sandbox notes.',
    };
    const glob = {
      name: 'Glob',
      description: 'Fast file pattern matching.',
      prompt: () => sharedSearch,
    };
    const grep = {
      name: 'Grep',
      description: 'Search file contents with regex.',
      prompt: () => sharedSearch,
    };
    const todo = {
      name: 'TodoWrite',
      description: 'Update the task list.',
      prompt: () => 'Use TodoWrite to track multi-step work. Mark tasks in_progress before starting.',
    };
    const readOnly = {
      name: 'NotebookEdit',
      description: 'Edit a Jupyter notebook cell.',
    };

    const resolved = await applyResolvedToolDescriptions(
      [bash, glob, grep, todo, readOnly] as never,
      { workDir: process.cwd() },
    );

    expect(resolved[0]).toBe(bash);
    expect(resolved[0]!.description).toBe(bash.description);
    expect(resolved[1]!.description).toBe(sharedSearch);
    expect(resolved[2]!.description).toBe(grep.description);
    expect(resolved[3]).not.toBe(todo);
    expect(resolved[3]!.description).toContain('Mark tasks in_progress');
    expect(resolved[4]).toBe(readOnly);
    expect(todo.description).toBe('Update the task list.');
  });

  it('retains one copy of prompt guidance shared by several tools', async () => {
    const tools = createGoalTools({
      getGoalService: () => {
        throw new Error('not executed');
      },
    });
    const resolved = await applyResolvedToolDescriptions(tools, { workDir: process.cwd() });
    expect(resolved.filter(tool => tool.description === GOAL_TOOLS_PROMPT)).toHaveLength(1);
    expect(resolved.filter(tool => tool.description.includes('active project goal'))).toHaveLength(1);
  });

  it('retains shared guidance even when it is shorter than a static description', async () => {
    const shared = 'Always inspect both files.';
    const tools = [
      { name: 'One', description: 'A deliberately longer first static tool description.', prompt: () => shared },
      { name: 'Two', description: 'Another deliberately longer static tool description.', prompt: () => shared },
    ];
    const resolved = await applyResolvedToolDescriptions(tools as never, { workDir: process.cwd() });
    expect(resolved.filter(tool => tool.description.includes(shared))).toHaveLength(1);
  });

  it('keeps the skill discovery index compact and leaves full instructions lazy', () => {
    const prompt = buildCompactSkillToolPrompt(Array.from({ length: 100 }, (_, index) => ({
      name: `skill-${index}`,
      description: `Short purpose ${index}. ${'Full SKILL.md instructions must not be embedded here. '.repeat(20)}`,
    })));
    expect(prompt).toContain('Available skills');
    expect(prompt).toContain('skill-99');
    expect(prompt.length).toBeLessThanOrEqual(6_000);
    expect(prompt).not.toContain('Full SKILL.md instructions must not be embedded here. Full SKILL.md');
  });

  it('folds distinct Glob and Grep prompts into their own descriptions', async () => {
    const tools = createHadamardFileTools({ cwd: process.cwd() });
    const glob = tools.find(tool => tool.name === 'Glob');
    const grep = tools.find(tool => tool.name === 'Grep');
    expect(glob).toBeDefined();
    expect(grep).toBeDefined();
    const resolved = await applyResolvedToolDescriptions(
      [glob!, grep!] as never,
      { workDir: process.cwd() },
    );
    expect(resolved[0]!.description).toContain('Prefer Glob over Bash');
    expect(resolved[0]!.description).toContain('NEVER invoke find or ls');
    expect(resolved[0]!.description).not.toContain('## Grep');
    expect(resolved[1]!.description).toContain('NEVER invoke `grep` or `rg`');
    expect(resolved[1]!.description).not.toContain('## Glob');
    expect(resolved[0]!.description).not.toBe(resolved[1]!.description);
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
