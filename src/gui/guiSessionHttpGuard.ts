import type { ServerResponse } from 'node:http';
import { json } from './guiHttpRouter.js';

export function rejectMismatchedGuiSession(
  res: ServerResponse,
  expectedSessionId: string | undefined,
  activeSessionId: string,
): boolean {
  if (!expectedSessionId || expectedSessionId === activeSessionId) return false;
  json(res, 409, {
    error: 'Conversation switched. Refresh and try again.',
    activeSessionId,
  });
  return true;
}
