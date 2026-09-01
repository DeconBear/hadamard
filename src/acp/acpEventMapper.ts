import type { AgentEvent, AgentRunResult, HadamardBridgeJsonEvent, HadamardBridgeRunResult } from '../types.js';
import type {
  AcpSessionUpdateBody,
  AcpStopReason,
  AcpToolCallKind,
} from './acpProtocol.js';

/** Map a Hadamard tool's public name onto the ACP tool-call kind vocabulary. */
export function acpToolKind(publicName: string): AcpToolCallKind {
  switch (publicName) {
    case 'Read':
    case 'NotebookRead':
      return 'read';
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit';
    case 'Glob':
    case 'Grep':
    case 'FindSymbol':
    case 'FindReferences':
      return 'search';
    case 'Bash':
    case 'BashOutput':
      return 'execute';
    case 'WebFetch':
    case 'WebSearch':
      return 'fetch';
    case 'ExitPlanMode':
      return 'switch_mode';
    default:
      return 'other';
  }
}

/**
 * Translate one Hadamard agent event into zero or more ACP session/update
 * bodies. Terminal run state (response.completed / error) is not forwarded —
 * ACP expresses it via the session/prompt stopReason.
 */
export function mapAgentEventToAcpUpdates(event: AgentEvent): AcpSessionUpdateBody[] {
  switch (event.type) {
    case 'response.text.delta':
      return [{
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: event.delta },
      }];
    case 'response.thinking.delta':
      return [{
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: event.delta },
      }];
    case 'tool.call':
      return [{
        sessionUpdate: 'tool_call',
        toolCallId: event.call.id,
        title: event.call.publicName,
        kind: acpToolKind(event.call.publicName),
        status: 'in_progress',
        rawInput: event.call.input,
      }];
    case 'tool.result':
      return [{
        sessionUpdate: 'tool_call_update',
        toolCallId: event.result.id,
        status: event.result.isError ? 'failed' : 'completed',
        rawOutput: event.result.outputText,
      }];
    default:
      return [];
  }
}

/** Map a settled run result onto the ACP stop-reason vocabulary. */
export function mapRunResultToStopReason(result: AgentRunResult): AcpStopReason {
  if (result.maxToolIterationsExceeded
    || (typeof result.incompleteReason === 'string' && result.incompleteReason.startsWith('max_tool_iterations_exceeded'))) {
    return 'max_turn_requests';
  }
  switch (result.stopReason) {
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      // end_turn / stop_sequence / tool_use turn-end / unknown values all
      // describe a completed turn from the client's perspective.
      return 'end_turn';
  }
}

/** True when a rejected run stream represents a client-requested cancel. */
export function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'RunAbortedError'
    || error.name === 'AbortError'
    || (error as { code?: string }).code === 'RUN_ABORTED';
}

// ── Bridge engine (external CLI stream-json) mapping ───────────────

/**
 * Translate one Hadamard bridge stream-json event (Claude Code / Codex /
 * compatible CLI wire format) into ACP session/update bodies. Only
 * assistant/user message events carry mappable content; system, result, and
 * bookkeeping events are dropped.
 */
export function mapBridgeJsonEventToAcpUpdates(event: HadamardBridgeJsonEvent): AcpSessionUpdateBody[] {
  const updates: AcpSessionUpdateBody[] = [];
  if (event.type !== 'assistant' && event.type !== 'user') return updates;
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return updates;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return updates;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (event.type === 'assistant') {
      if (record.type === 'text' && typeof record.text === 'string' && record.text) {
        updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: record.text } });
      } else if (record.type === 'thinking' && typeof record.thinking === 'string' && record.thinking) {
        updates.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: record.thinking } });
      } else if (record.type === 'tool_use' && typeof record.id === 'string' && typeof record.name === 'string') {
        updates.push({
          sessionUpdate: 'tool_call',
          toolCallId: record.id,
          title: record.name,
          kind: acpToolKind(record.name),
          status: 'in_progress',
          rawInput: record.input,
        });
      }
    } else if (record.type === 'tool_result' && typeof record.tool_use_id === 'string') {
      updates.push({
        sessionUpdate: 'tool_call_update',
        toolCallId: record.tool_use_id,
        status: record.is_error === true ? 'failed' : 'completed',
        rawOutput: bridgeToolResultText(record.content),
      });
    }
  }
  return updates;
}

/** Map a settled bridge run result onto the ACP stop-reason vocabulary. */
export function mapBridgeRunResultToStopReason(result: HadamardBridgeRunResult): AcpStopReason {
  switch (result.stopReason ?? result.subtype) {
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

function bridgeToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
    .map(block => String((block as { text?: unknown }).text ?? ''))
    .join('\n');
}
