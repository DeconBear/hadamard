export type ActiveInputMode = 'follow-up' | 'steer';

export interface PendingInputPort {
  followUp(input: string): void;
  steer(input: string): void;
  cancelLatestFollowUp(): string | undefined;
}

/** TUI policy adapter; the runtime queue remains owned by AgentSession. */
export function submitActiveInput(
  port: PendingInputPort,
  input: string,
  mode: ActiveInputMode,
): void {
  if (mode === 'steer') port.steer(input);
  else port.followUp(input);
}

/**
 * Pull the newest queued follow-up into the editor for editing.
 * Callers must restore it via {@link restoreAbandonedFollowUp} if the user
 * clears the editor without resubmitting.
 */
export function recallLatestFollowUp(port: PendingInputPort): string | undefined {
  return port.cancelLatestFollowUp();
}

/** Re-queue a follow-up that was recalled into the editor but abandoned. */
export function restoreAbandonedFollowUp(
  port: PendingInputPort,
  recalled: string | null | undefined,
): void {
  const text = recalled?.trim();
  if (!text) return;
  port.followUp(text);
}
