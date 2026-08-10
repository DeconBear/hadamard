import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { listTeamDefinitions } from '../team/teamDefinitions.js';
import {
  listScheduledAutomationTasks,
  upsertScheduledAutomationTask,
} from '../scheduling/taskPersistence.js';
import {
  deleteWorkflow,
  listWorkflows,
  loadWorkflow,
  saveWorkflow,
} from '../workflow/workflowPersistence.js';
import { A } from './ansi.js';
import { formatErrorLine, formatInfoLine } from './transcript.js';
import type { TuiSelectionItem } from './selection.js';

export interface TuiWorkflowEvent {
  type: string;
  title?: string;
  label?: string;
  agentId?: string;
  cached?: boolean;
  durationMs?: number;
  message?: string;
  agentCount?: number;
  totalTokens?: number;
}

export interface TuiWorkflowCommandPort {
  workDir: string;
  homeDir: string;
  selectItem(options: {
    title: string;
    subtitle?: string;
    items: TuiSelectionItem[];
  }): Promise<string | undefined>;
  promptText(options: {
    title: string;
    label: string;
    description?: string;
    initial?: string;
  }): Promise<string | undefined>;
  runWorkflowScript(
    script: string,
    args: string | undefined,
    onEvent: (event: TuiWorkflowEvent) => void,
  ): Promise<{ result?: unknown; errors: unknown[] }>;
  renderRichText(text: string): string[];
  appendStatic(lines: readonly string[]): void;
}

async function runSavedWorkflow(
  name: string,
  task: string | undefined,
  port: TuiWorkflowCommandPort,
): Promise<void> {
  const workflow = loadWorkflow(name, port.workDir);
  if (!workflow) {
    port.appendStatic([...formatErrorLine(`workflow not found: ${name}`), '']);
    return;
  }
  port.appendStatic([
    ...formatInfoLine(`running workflow: ${name}`),
    ...formatInfoLine(`phases: ${workflow.meta?.phases?.map(phase => phase.title).join(', ') ?? 'none'}`),
    '',
  ]);
  try {
    const output = await port.runWorkflowScript(workflow.script, task, event => {
      if (event.type === 'workflow.phase.start') {
        port.appendStatic([`${A.bold}${A.magenta}▶ ${event.title}${A.reset}`]);
      } else if (event.type === 'workflow.agent.start') {
        port.appendStatic([`${A.dim}  ⚡ ${event.label ?? event.agentId}${event.cached ? ' (cached)' : ''}${A.reset}`]);
      } else if (event.type === 'workflow.agent.done') {
        const seconds = event.durationMs ? ` · ${Math.round(event.durationMs / 1000)}s` : '';
        port.appendStatic([`${A.dim}  ✓ ${event.label ?? event.agentId}${seconds}${A.reset}`]);
      } else if (event.type === 'workflow.log') {
        port.appendStatic([`${A.dim}  │ ${event.message}${A.reset}`]);
      } else if (event.type === 'workflow.script.done') {
        const seconds = event.durationMs ? ` · ${Math.round(event.durationMs / 1000)}s` : '';
        port.appendStatic([
          `${A.green}✓ workflow done${A.reset}${A.dim} · ${event.agentCount} agents · ${event.totalTokens} tokens${seconds}${A.reset}`,
          '',
        ]);
      }
    });
    if (typeof output.result === 'string' && output.result.trim()) {
      port.appendStatic([...formatInfoLine('workflow result:'), ...port.renderRichText(output.result), '']);
    }
    if (output.errors.length > 0) {
      port.appendStatic([...formatErrorLine(`${output.errors.length} errors during workflow execution`), '']);
    }
  } catch (error) {
    port.appendStatic([...formatErrorLine(`workflow error: ${error instanceof Error ? error.message : String(error)}`), '']);
  }
}

export async function runTuiWorkflowCommand(
  name: string,
  args: string,
  port: TuiWorkflowCommandPort,
): Promise<boolean> {
  switch (name) {
    case 'automation': {
      if (!args || args === 'list') {
        const tasks = await listScheduledAutomationTasks(port.workDir);
        port.appendStatic([
          ...formatInfoLine(tasks.length ? `Automation tasks (${tasks.length})` : 'No automation tasks configured.'),
          ...tasks.map(task => `  ${A.bold}${task.name}${A.reset} ${A.dim}· ${task.kind} · ${task.trigger ?? 'schedule'} · ${task.enabled ? 'enabled' : 'paused'}${A.reset}`),
          '',
        ]);
        return true;
      }
      if (args !== 'new') {
        port.appendStatic([...formatErrorLine('usage: /automation [list|new]'), '']);
        return true;
      }
      const kind = await port.selectItem({
        title: 'New automation task',
        subtitle: 'Choose what the task runs',
        items: [
          { id: 'workflow', label: 'Agent Workflow', description: 'Run a Workflow saved on the Agent page' },
          { id: 'prompt', label: 'Prompt', description: 'Run one background prompt' },
          { id: 'manager', label: 'Manager update', description: 'Update project progress' },
        ],
      });
      if (kind !== 'workflow' && kind !== 'prompt' && kind !== 'manager') return true;

      let workflowName: string | undefined;
      let workflowSource: 'agent' | undefined;
      let input: string | undefined;
      let prompt: string | undefined;
      if (kind === 'workflow') {
        const workflows = listTeamDefinitions(port.workDir, port.homeDir)
          .filter(team => team.definition.squadType === 'workflow');
        if (!workflows.length) {
          port.appendStatic([...formatErrorLine('Create and save a Workflow on the Agent page first.'), '']);
          return true;
        }
        workflowName = await port.selectItem({
          title: 'Agent Workflow',
          items: workflows.map(workflow => ({
            id: workflow.name,
            label: workflow.name,
            description: `${workflow.source} · ${workflow.definition.description ?? ''}`,
          })),
        });
        if (!workflowName) return true;
        workflowSource = 'agent';
        input = (await port.promptText({ title: workflowName, label: 'Input (optional)' }))?.trim() || undefined;
      } else if (kind === 'prompt') {
        prompt = (await port.promptText({ title: 'Prompt automation', label: 'Prompt' }))?.trim();
        if (!prompt) return true;
      } else {
        input = (await port.promptText({ title: 'Manager update', label: 'Instruction (optional)' }))?.trim() || undefined;
      }
      const trigger = await port.selectItem({
        title: 'Trigger',
        items: [
          { id: 'schedule', label: 'Schedule', description: 'Run from a cron expression' },
          { id: 'webhook', label: 'Webhook', description: 'Run when its local webhook URL is called' },
        ],
      });
      if (trigger !== 'schedule' && trigger !== 'webhook') return true;
      const cron = trigger === 'schedule'
        ? (await port.promptText({ title: 'Schedule', label: 'Cron', initial: '0 9 * * *', description: 'min hour day month weekday' }))?.trim()
        : '';
      if (trigger === 'schedule' && !cron) return true;
      const defaultName = workflowName ?? (prompt ? prompt.slice(0, 48) : 'Manager progress update');
      const taskName = (await port.promptText({ title: 'Automation task', label: 'Name', initial: defaultName }))?.trim();
      if (!taskName) return true;
      try {
        const task = await upsertScheduledAutomationTask(port.workDir, {
          name: taskName,
          kind,
          trigger,
          cron,
          enabled: true,
          workflowName,
          workflowSource,
          input,
          prompt,
          ...(trigger === 'webhook' ? { webhookId: `wh-${randomUUID().slice(0, 8)}` } : {}),
        });
        port.appendStatic([...formatInfoLine(`Automation task saved: ${task.name}`), '']);
      } catch (error) {
        port.appendStatic([...formatErrorLine(error instanceof Error ? error.message : String(error)), '']);
      }
      return true;
    }
    case 'workflows': {
      if (args.startsWith('run ')) {
        const rest = args.slice(4).trim();
        const split = rest.indexOf(' ');
        await runSavedWorkflow(
          split === -1 ? rest : rest.slice(0, split),
          split === -1 ? undefined : rest.slice(split + 1).trim(),
          port,
        );
        return true;
      }
      if (args.startsWith('delete ')) {
        const workflowName = args.slice(7).trim();
        if (!workflowName) {
          port.appendStatic([...formatErrorLine('usage: /workflows delete <name>'), '']);
          return true;
        }
        const removed = await deleteWorkflow(workflowName, port.workDir);
        port.appendStatic([...formatInfoLine(removed ? `deleted workflow: ${workflowName}` : `workflow not found: ${workflowName}`), '']);
        return true;
      }
      if (args.startsWith('save ')) {
        const rest = args.slice(5).trim();
        const split = rest.indexOf(' ');
        if (split === -1) {
          port.appendStatic([...formatErrorLine('usage: /workflows save <name> <script-path> [--overwrite]'), '']);
          return true;
        }
        const workflowName = rest.slice(0, split).trim();
        const pathParts = rest.slice(split + 1).trim().split(/\s+/u);
        const overwrite = pathParts.includes('--overwrite');
        const scriptPath = pathParts.filter(part => part !== '--overwrite').join(' ');
        try {
          const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(port.workDir, scriptPath);
          const script = fs.readFileSync(resolved, 'utf8');
          const filePath = await saveWorkflow(workflowName, script, { projectDir: port.workDir, overwrite });
          port.appendStatic([...formatInfoLine(`saved workflow: ${workflowName} -> ${filePath}`), '']);
        } catch (error) {
          port.appendStatic([...formatErrorLine(error instanceof Error ? error.message : String(error)), '']);
        }
        return true;
      }
      if (args && args !== 'list') {
        port.appendStatic([...formatErrorLine('usage: /workflows [list|run <name> [task]|save <name> <script-path>|delete <name>]'), '']);
        return true;
      }
      const saved = listWorkflows(port.workDir);
      const choice = await port.selectItem({
        title: 'Workflows',
        subtitle: 'run a saved workflow, or have the agent build a new one',
        items: [
          ...saved.map(workflow => ({
            id: `run:${workflow.name}`,
            label: workflow.name,
            description: `${workflow.source} · ${workflow.description}`.slice(0, 80),
          })),
          {
            id: '__orchestrate__',
            label: '+ ask the agent to orchestrate a new workflow',
            description: 'describe a task in the prompt box; the agent designs & runs a workflow, then you can save it',
          },
        ],
      });
      if (!choice) return true;
      if (choice.startsWith('run:')) {
        const workflowName = choice.slice('run:'.length);
        const task = await port.promptText({
          title: `Run /${workflowName}`,
          label: 'Task / input (optional — Enter to skip)',
        });
        await runSavedWorkflow(workflowName, task?.trim() || undefined, port);
      } else if (choice === '__orchestrate__') {
        port.appendStatic([
          ...formatInfoLine('Type your task in the prompt box and ask: "orchestrate a workflow to <task>".'),
          `${A.dim}After it runs and works, ask me to save it as a reusable workflow.${A.reset}`,
          '',
        ]);
      }
      return true;
    }
    default:
      return false;
  }
}
