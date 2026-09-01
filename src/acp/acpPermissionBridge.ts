import type { HadamardToolApprover } from '../types.js';
import {
  parseRequestPermissionResult,
  type AcpPermissionOption,
  type AcpPermissionOptionKind,
} from './acpProtocol.js';
import { acpToolKind } from './acpEventMapper.js';

/**
 * Outbound channel from the ACP server back to the connected client.
 * Implemented by the stdio transport (or a test double).
 */
export interface AcpClientChannel {
  /** Fire-and-forget notification, e.g. session/update. */
  notify(method: string, params: unknown): void;
  /** Outgoing request whose response the client sends later, e.g. session/request_permission. */
  request(method: string, params: unknown): Promise<unknown>;
}

const PERMISSION_OPTIONS: readonly AcpPermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
];

const OPTION_KIND_BY_ID = new Map(PERMISSION_OPTIONS.map(option => [option.optionId, option.kind]));

/**
 * Bridge Hadamard's per-run approver callback onto ACP
 * session/request_permission. Never hangs: transport errors, malformed
 * outcomes, and client-side cancellation all resolve to deny, so a client
 * configured with permission:reject simply denies every ask.
 *
 * allow_always currently grants this call only; durable rule persistence
 * stays with Hadamard's own approval policy layer.
 */
export function createAcpToolApprover(options: {
  channel: AcpClientChannel;
  sessionId: string;
}): HadamardToolApprover {
  return async context => {
    let outcomeKind: AcpPermissionOptionKind | 'cancelled';
    try {
      const raw = await options.channel.request('session/request_permission', {
        sessionId: options.sessionId,
        toolCall: {
          toolCallId: `${context.runId}:${context.iteration}:${context.toolName}`,
          title: context.publicName,
          kind: acpToolKind(context.publicName),
          status: 'pending',
          rawInput: context.input,
        },
        options: PERMISSION_OPTIONS.map(option => ({ ...option })),
      });
      const parsed = parseRequestPermissionResult(raw);
      if (parsed.outcome.outcome === 'cancelled') {
        outcomeKind = 'cancelled';
      } else {
        outcomeKind = OPTION_KIND_BY_ID.get(parsed.outcome.optionId) ?? 'cancelled';
      }
    } catch {
      outcomeKind = 'cancelled';
    }
    switch (outcomeKind) {
      case 'allow_once':
      case 'allow_always':
        return { behavior: 'allow', reason: `Approved via ACP (${outcomeKind}).` };
      case 'reject_once':
      case 'reject_always':
        return { behavior: 'deny', reason: `Rejected via ACP (${outcomeKind}).` };
      default:
        return { behavior: 'deny', reason: 'Permission request cancelled or unanswered by the ACP client.' };
    }
  };
}
