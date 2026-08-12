import type { SurfaceSemanticEvent } from '../surfaces/index.js';

/** Keep the mode-line context figure tied to the current request payload. */
export function nextTuiContextTokenEstimate(
  current: number | undefined,
  event: Pick<SurfaceSemanticEvent, 'type' | 'data'>,
): number | undefined {
  if (event.type === 'request.started') {
    return typeof event.data.requestTokenEstimate === 'number'
      ? event.data.requestTokenEstimate
      : undefined;
  }
  if (
    event.type === 'compaction.completed'
    && typeof event.data.tokenEstimateAfter === 'number'
  ) {
    return event.data.tokenEstimateAfter;
  }
  return current;
}
