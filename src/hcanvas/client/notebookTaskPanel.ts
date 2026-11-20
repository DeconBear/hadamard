import { notebookExecutionCenter } from './notebookExecutionCenter.js';
import type { KernelScope } from './kernelManager.js';
import { esc } from './utils.js';

export function renderNotebookTaskPanel(host: HTMLElement, panel: HTMLElement, scope: KernelScope, open: boolean): void {
  const tasks = notebookExecutionCenter.list();
  const active = tasks.filter(task => ['queued', 'running', 'disconnected'].includes(task.status)).length;
  const count = host.querySelector<HTMLElement>('[data-nb-task-count]');
  if (count) count.textContent = active ? String(active) : '';
  if (!open) return;
  panel.innerHTML = '<div class="nb-task-head"><strong>Execution center</strong><small>Background work continues when you switch pages.</small><button type="button" class="nb-icon-btn" data-nb-clear-tasks>Clear completed</button></div>' +
    (tasks.length ? tasks.map(task => {
      const activeTask = ['queued', 'running', 'disconnected'].includes(task.status);
      const currentScope = task.scope.kind === scope.kind && task.scope.key === scope.key;
      return '<div class="nb-task-row" data-nb-task-id="' + esc(task.id) + '"><span class="nb-task-status" data-tone="' + esc(task.status) + '"></span><div class="nb-task-copy"><strong>' + esc(task.notebookTitle) + '</strong><small>' + esc(task.kernelLabel) + ' · ' + esc(task.status) + (task.durationMs !== undefined ? ' · ' + (task.durationMs / 1000).toFixed(1) + 's' : '') + '</small></div>' +
        (currentScope ? '<button type="button" class="nb-icon-btn" data-nb-task-cell="' + esc(task.cellId) + '" title="Show cell">↗</button>' : '') +
        (activeTask ? '<button type="button" class="nb-icon-btn danger" data-nb-task-stop="' + esc(task.id) + '" title="Stop execution">×</button>' : '') + '</div>';
    }).join('') : '<p class="nb-variable-empty">No executions yet.</p>');
}
