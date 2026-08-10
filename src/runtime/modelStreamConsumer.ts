import type { ContentBlockDeltaEvent, ContentBlockStartEvent } from '../provider/types.js';
import type { AgentEvent, ModelApi, ModelRequest } from '../types.js';
import { nowIso } from './helpers.js';

export async function consumeStream(
  request: ModelRequest,
  modelApi: ModelApi,
  iteration: number,
  emit: ((event: AgentEvent) => void) | undefined,
  runId: string,
) {
  const stream = modelApi.streamMessage(request);
  let textSnapshot = '';
  const thinkingSnapshots = new Map<number, string>();
  const toolInputSnapshots = new Map<number, string>();
  const toolBlocks = new Map<number, { id?: string; name?: string }>();
  for await (const event of stream) {
    if (isContentBlockStartEvent(event)) {
      const block = event.content_block;
      if (block.type === 'tool_use') {
        toolBlocks.set(event.index, {
          id: typeof block.id === 'string' ? block.id : undefined,
          name: typeof block.name === 'string' ? block.name : undefined,
        });
      }
    } else if (isTextDeltaEvent(event)) {
      textSnapshot += event.delta.text;
      emit?.({
        type: 'response.text.delta', runId, iteration,
        delta: event.delta.text, snapshot: textSnapshot, timestamp: nowIso(),
      });
    } else if (isThinkingDeltaEvent(event)) {
      const previous = thinkingSnapshots.get(event.index) ?? '';
      const snapshot = `${previous}${event.delta.thinking}`;
      thinkingSnapshots.set(event.index, snapshot);
      emit?.({
        type: 'response.thinking.delta', runId, iteration, index: event.index,
        delta: event.delta.thinking, snapshot,
        ...(typeof event.delta.signature === 'string' ? { signature: event.delta.signature } : {}),
        timestamp: nowIso(),
      });
    } else if (isInputJsonDeltaEvent(event)) {
      const previous = toolInputSnapshots.get(event.index) ?? '';
      const snapshot = `${previous}${event.delta.partial_json}`;
      toolInputSnapshots.set(event.index, snapshot);
      const toolBlock = toolBlocks.get(event.index);
      emit?.({
        type: 'response.tool_input.delta', runId, iteration, index: event.index,
        toolUseId: toolBlock?.id, toolName: toolBlock?.name,
        delta: event.delta.partial_json, snapshot, timestamp: nowIso(),
      });
    }
  }
  return stream.finalMessage();
}

function isContentBlockStartEvent(event: unknown): event is ContentBlockStartEvent {
  return typeof event === 'object' && event !== null
    && 'type' in event && event.type === 'content_block_start'
    && 'index' in event && typeof event.index === 'number'
    && 'content_block' in event && typeof event.content_block === 'object'
    && event.content_block !== null;
}

function isTextDeltaEvent(event: unknown): event is ContentBlockDeltaEvent & {
  delta: { type: 'text_delta'; text: string };
} {
  return typeof event === 'object' && event !== null
    && 'type' in event && event.type === 'content_block_delta'
    && 'delta' in event && typeof event.delta === 'object' && event.delta !== null
    && 'type' in event.delta && event.delta.type === 'text_delta'
    && 'text' in event.delta && typeof event.delta.text === 'string';
}

function isThinkingDeltaEvent(event: unknown): event is ContentBlockDeltaEvent & {
  delta: { type: 'thinking_delta'; thinking: string; signature?: string };
} {
  return typeof event === 'object' && event !== null
    && 'type' in event && event.type === 'content_block_delta'
    && 'index' in event && typeof event.index === 'number'
    && 'delta' in event && typeof event.delta === 'object' && event.delta !== null
    && 'type' in event.delta && event.delta.type === 'thinking_delta'
    && 'thinking' in event.delta && typeof event.delta.thinking === 'string';
}

function isInputJsonDeltaEvent(event: unknown): event is ContentBlockDeltaEvent & {
  delta: { type: 'input_json_delta'; partial_json: string };
} {
  return typeof event === 'object' && event !== null
    && 'type' in event && event.type === 'content_block_delta'
    && 'index' in event && typeof event.index === 'number'
    && 'delta' in event && typeof event.delta === 'object' && event.delta !== null
    && 'type' in event.delta && event.delta.type === 'input_json_delta'
    && 'partial_json' in event.delta && typeof event.delta.partial_json === 'string';
}
