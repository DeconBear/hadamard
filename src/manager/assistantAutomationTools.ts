import path from 'node:path';
import { z } from 'zod';

import {
  listScheduledAutomationTasks,
  setScheduledAutomationEnabled,
  upsertScheduledAutomationTask,
} from '../scheduling/taskPersistence.js';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition, ScheduledAutomationTaskInput } from '../types.js';

export interface AssistantAutomationToolContext {
  currentWorkDir: string;
  assertKnownProject(projectPath: string): Promise<string>;
}

export function createAssistantAutomationTools(
  context: AssistantAutomationToolContext,
): AgentToolDefinition[] {
  const resolveProject = (projectPath?: string) => projectPath
    ? context.assertKnownProject(projectPath)
    : Promise.resolve(path.resolve(context.currentWorkDir));

  const list = tool(
    {
      name: 'ListScheduledTasks',
      description: 'List automation tasks for the current workspace.',
      inputSchema: z.strictObject({
        projectPath: z.string().optional().describe('Defaults to current workDir'),
      }),
      isReadOnly: () => true,
    },
    async input => {
      const projectPath = await resolveProject(input.projectPath);
      const tasks = await listScheduledAutomationTasks(projectPath);
      return {
        projectPath,
        tasks: tasks.map(task => ({
          id: task.id,
          name: task.name,
          kind: task.kind,
          trigger: task.trigger ?? 'schedule',
          cron: task.cron,
          enabled: task.enabled,
          workflowName: task.workflowName,
          nextRunAt: task.nextRunAt,
          lastRunAt: task.lastRunAt,
          lastResult: task.lastResult,
        })),
      };
    },
  );

  const upsert = tool(
    {
      name: 'UpsertScheduledTask',
      description: 'Create or update an automation task for a project workspace.',
      inputSchema: z.strictObject({
        projectPath: z.string().optional(),
        id: z.string().optional(),
        name: z.string().optional(),
        kind: z.enum(['workflow', 'prompt', 'manager']),
        cron: z.string().optional(),
        enabled: z.boolean().optional(),
        workflowName: z.string().optional(),
        workflowSource: z.enum(['agent', 'script']).optional(),
        input: z.string().optional(),
        prompt: z.string().optional(),
        trigger: z.enum(['schedule', 'webhook']).optional(),
      }),
    },
    async input => {
      const projectPath = await resolveProject(input.projectPath);
      const body: ScheduledAutomationTaskInput = {
        id: input.id,
        name: input.name,
        kind: input.kind,
        cron: input.cron,
        enabled: input.enabled,
        workflowName: input.workflowName,
        workflowSource: input.workflowSource,
        input: input.input,
        prompt: input.prompt,
        trigger: input.trigger,
      };
      const task = await upsertScheduledAutomationTask(projectPath, body);
      return {
        ok: true,
        projectPath,
        task: { id: task.id, name: task.name, kind: task.kind, cron: task.cron, enabled: task.enabled },
      };
    },
  );

  const toggle = tool(
    {
      name: 'ToggleScheduledTask',
      description: 'Enable or pause an automation task.',
      inputSchema: z.strictObject({
        projectPath: z.string().optional(),
        id: z.string(),
        enabled: z.boolean(),
      }),
    },
    async input => {
      const projectPath = await resolveProject(input.projectPath);
      const task = await setScheduledAutomationEnabled(projectPath, input.id, input.enabled);
      if (!task) throw new Error(`Scheduled task not found: ${input.id}`);
      return { ok: true, projectPath, task: { id: task.id, name: task.name, enabled: task.enabled } };
    },
  );

  return [list, upsert, toggle];
}
