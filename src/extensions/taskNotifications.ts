/**
 * Background-task settled notifications (built-in `notifications` extension):
 * formats a short title/body for a settled background task and builds terminal
 * notification sequences (bell, OSC 777, OSC 9) for interactive surfaces.
 *
 * Config shape under `extensions.notifications`:
 * `{ enabled: boolean, bell?: boolean (default true), osc?: boolean (default true) }`.
 *
 * @module src/extensions/taskNotifications
 */
import type { HadamardBackgroundTaskRecord } from '../types.js';

export interface TaskSettledNotification {
  title: string;
  body: string;
}

/** Notification preferences resolved from the `notifications` extension config. */
export interface TaskNotificationOptions {
  bell: boolean;
  osc: boolean;
}

const BODY_MAX_LENGTH = 200;

export function resolveTaskNotificationOptions(
  config: Record<string, unknown> | undefined,
): TaskNotificationOptions {
  return {
    bell: config?.bell !== false,
    osc: config?.osc !== false,
  };
}

export function formatTaskSettledNotification(
  task: HadamardBackgroundTaskRecord,
): TaskSettledNotification {
  const statusLabel = task.status === 'completed'
    ? 'completed'
    : task.status === 'failed'
      ? 'failed'
      : task.status === 'cancelled'
        ? 'cancelled'
        : task.status;
  const label = task.agentName ?? (task.description.trim() ? task.description.trim() : undefined);
  const title = `Background task ${statusLabel}${label ? `: ${label}` : ''}`;
  const summary = task.status === 'completed'
    ? task.text ?? task.partialText ?? ''
    : task.error ?? task.partialText ?? task.text ?? '';
  const normalized = (summary || task.description || '').replace(/\s+/g, ' ').trim();
  const body = normalized.length > BODY_MAX_LENGTH
    ? `${normalized.slice(0, BODY_MAX_LENGTH - 1)}…`
    : normalized;
  return { title, body };
}

/** Strip characters that would break out of OSC sequences or inject control codes. */
function sanitizeTerminalText(value: string): string {
  return value
    .replace(/[\x1b\x07\x9c\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Concatenate terminal notification sequences: a bell (`\x07`) when `bell`,
 * OSC 777 (`notify;title;body`) and OSC 9 (`body`) when `osc`.
 */
export function buildTerminalNotifySequence(
  notification: TaskSettledNotification,
  opts: { bell?: boolean; osc?: boolean },
): string {
  const title = sanitizeTerminalText(notification.title);
  const body = sanitizeTerminalText(notification.body);
  let sequence = '';
  if (opts.bell) sequence += '\x07';
  if (opts.osc) {
    sequence += `\x1b]777;notify;${title};${body}\x1b\\`;
    sequence += `\x1b]9;${body}\x1b\\`;
  }
  return sequence;
}
