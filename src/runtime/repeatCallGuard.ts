import { isRecord } from './helpers.js';

/**
 * Advisory repeat-call guard (dsh repeat-tool-reminder equivalent): tracks
 * consecutive identical ERROR tool calls by canonical arguments, injects
 * gentle-then-detailed reminders at configured thresholds, and only escalates
 * to a hard stop at the configured ceiling. A different call or a success
 * resets the chain.
 *
 * @module src/runtime/repeatCallGuard
 */

export interface RepeatCallGuardOptions {
  /** Consecutive-repeat counts that trigger a reminder. Defaults to [3, 5]. */
  thresholds?: number[];
  /** Consecutive-repeat count that triggers the hard-stop escalation. Defaults to 5. */
  hardStopAt?: number;
  /** Maximum characters of canonical arguments quoted in the detailed reminder. */
  argumentsPreviewChars?: number;
}

export interface RepeatCallRecord {
  /** Advisory reminder for injection into the next tool result. */
  reminder?: string;
  /** Escalate: the same identical error call repeated past the ceiling. */
  hardStop?: boolean;
}

const DEFAULT_THRESHOLDS = [3, 5] as const;
const DEFAULT_HARD_STOP_AT = 5;
const DEFAULT_ARGUMENTS_PREVIEW_CHARS = 500;

/** Deep key-sorted JSON snapshot so argument order never changes identity. */
export function canonicalizeToolArguments(input: unknown): string {
  try {
    return JSON.stringify(sortJsonValue(input));
  } catch {
    return JSON.stringify(input ?? {});
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue(value[key]);
    }
    return sorted;
  }
  return value;
}

export class RepeatCallGuard {
  private currentKey = '';
  private count = 0;

  constructor(private readonly options: RepeatCallGuardOptions = {}) {}

  /**
   * Record one settled tool result. Only error results extend the repeat
   * chain; a success or a different call identity resets it.
   */
  record(toolName: string, input: unknown, isError: boolean): RepeatCallRecord {
    if (!isError) {
      this.currentKey = '';
      this.count = 0;
      return {};
    }
    const key = `${toolName}\u0000${canonicalizeToolArguments(input)}`;
    if (key !== this.currentKey) {
      this.currentKey = key;
      this.count = 1;
    } else {
      this.count += 1;
    }
    const thresholds = this.options.thresholds ?? [...DEFAULT_THRESHOLDS];
    const hardStopAt = this.options.hardStopAt ?? DEFAULT_HARD_STOP_AT;
    const reminder = thresholds.includes(this.count)
      ? this.buildReminder(toolName, input, this.count)
      : undefined;
    const hardStop = this.count >= hardStopAt;
    return { ...(reminder !== undefined ? { reminder } : {}), ...(hardStop ? { hardStop } : {}) };
  }

  reset(): void {
    this.currentKey = '';
    this.count = 0;
  }

  private buildReminder(toolName: string, input: unknown, count: number): string {
    const thresholds = this.options.thresholds ?? [...DEFAULT_THRESHOLDS];
    if (count === thresholds[0]) {
      return [
        'You are repeating the exact same tool call with identical arguments.',
        'Carefully analyze the previous result before calling again: if the task',
        'is not complete, try a different approach or different arguments instead',
        'of repeating the call.',
      ].join(' ');
    }
    const previewChars = this.options.argumentsPreviewChars ?? DEFAULT_ARGUMENTS_PREVIEW_CHARS;
    const canonical = canonicalizeToolArguments(input);
    const preview = canonical.length > previewChars
      ? `${canonical.slice(0, previewChars)}...`
      : canonical;
    return [
      'Repeated tool call detected:',
      `- tool: ${toolName}`,
      `- consecutive_calls: ${count}`,
      `- arguments: ${preview}`,
      'The repeated calls are not making progress. Do not call this tool with',
      'these exact arguments again. Inspect the latest result and choose a',
      'different action, different arguments, or finish the task if enough',
      'evidence has been gathered.',
    ].join('\n');
  }
}
