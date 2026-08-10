import type { HadamardBackgroundTaskRecord } from '../types.js';

export function resolveTaskId(input: { task_id?: string; taskId?: string }): string | undefined {
  return [input.task_id, input.taskId]
    .map(value => value?.trim())
    .find((value): value is string => Boolean(value));
}

export function serializeBackgroundTaskOutput(task: HadamardBackgroundTaskRecord): string {
  return [
    `Task id: ${task.id}`,
    `Status: ${task.status}`,
    `Subagent: ${task.subagentType}`,
    task.agentName ? `Agent name: ${task.agentName}` : undefined,
    task.runId ? `Run id: ${task.runId}` : undefined,
    task.sessionId ? `Session id: ${task.sessionId}` : undefined,
    task.model ? `Model: ${task.model}` : undefined,
    typeof task.toolCallCount === 'number' ? `Tool calls: ${task.toolCallCount}` : undefined,
    typeof task.toolErrorCount === 'number' ? `Tool errors: ${task.toolErrorCount}` : undefined,
    typeof task.requestCount === 'number' ? `Requests: ${task.requestCount}` : undefined,
    task.currentToolName ? `Current tool: ${task.currentToolName}` : undefined,
    task.progressSummary ? `Progress: ${task.progressSummary}` : undefined,
    task.worktreePath ? `Worktree: ${task.worktreePath}` : undefined,
    task.worktreeBranch ? `Branch: ${task.worktreeBranch}` : undefined,
    task.error ? `Error:\n${task.error}` : undefined,
    task.text
      ? `Output:\n${task.text}`
      : task.partialText
        ? `Partial output:\n${task.partialText}`
        : 'Output: <not available yet>',
  ].filter(Boolean).join('\n');
}

export function formatTaskNotification(task: HadamardBackgroundTaskRecord): string {
  const result = task.status === 'completed' ? task.text ?? task.partialText ?? '' : task.partialText ?? '';
  const actor = task.subagentType === 'bash'
    ? `Background command "${task.description}"`
    : `Agent "${task.agentName ?? task.subagentType}"`;
  return [
    '<task_notification>',
    `<task_id>${escapeXml(task.id)}</task_id>`,
    task.sessionId ? `<agent_id>${escapeXml(task.sessionId)}</agent_id>` : undefined,
    task.agentName ? `<agent_name>${escapeXml(task.agentName)}</agent_name>` : undefined,
    `<status>${task.status}</status>`,
    `<summary>${escapeXml(task.status === 'completed' ? `${actor} completed.` : `${actor} ${task.status}.`)}</summary>`,
    result ? `<result>${escapeXml(result)}</result>` : undefined,
    task.error ? `<error>${escapeXml(task.error)}</error>` : undefined,
    `<usage><requests>${task.requestCount ?? 0}</requests><tool_uses>${task.toolCallCount ?? 0}</tool_uses><tool_errors>${task.toolErrorCount ?? 0}</tool_errors></usage>`,
    task.retainedWorktree && task.worktreePath
      ? `<worktree><path>${escapeXml(task.worktreePath)}</path>${task.worktreeBranch ? `<branch>${escapeXml(task.worktreeBranch)}</branch>` : ''}</worktree>`
      : undefined,
    '</task_notification>',
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}
