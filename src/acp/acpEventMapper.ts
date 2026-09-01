import type { AgentEvent, AgentRunResult } from '../types.js';
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
