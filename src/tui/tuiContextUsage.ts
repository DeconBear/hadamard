import type { MessageParam } from '../provider/types.js';
import { estimateHadamardConversationTokens } from '../memory/hadamardSessionMemoryState.js';
import type { SurfaceSemanticEvent } from '../surfaces/index.js';
import {
  estimateRequestTokenBreakdown,
  type RequestTokenEstimateBreakdown,
} from '../runtime/requestTokenEstimate.js';

export interface TuiContextEstimateInput {
  systemPrompt: string;
  tools: ReadonlyArray<{
    name: string;
    description?: string;
    inputJsonSchema?: Record<string, unknown>;
  }>;
  messages: readonly MessageParam[];
}

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

/**
 * Local estimate of the next request: system + tool schemas + stored messages.
 * Matches conversationEngine's chars/4 heuristic so the mode line is not 0%
 * before the first `request.started` event. Dynamic tool `prompt()` text is
 * folded into `tools[].description` at request time, so Skill/Agent catalogs
 * can still raise the live figure on the first turn.
 */
export function estimateTuiContextTokens(input: TuiContextEstimateInput): number {
  return estimateTuiContextTokenBreakdown(input).totalTokens;
}

export function estimateTuiContextTokenBreakdown(
  input: TuiContextEstimateInput,
): RequestTokenEstimateBreakdown {
  return estimateRequestTokenBreakdown({
    systemPrompt: input.systemPrompt,
    tools: input.tools.map(tool => ({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.inputJsonSchema ?? {},
    })),
    messageTokens: estimateHadamardConversationTokens(input.messages),
  });
}
