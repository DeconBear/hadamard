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

/** Default deadline for a client to answer a permission request. */
export const ACP_PERMISSION_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

const PERMISSION_OPTIONS: readonly AcpPermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
];

const OPTION_KIND_BY_ID = new Map(PERMISSION_OPTIONS.map(option => [option.optionId, option.kind]));

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('ACP permission request timed out.')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
  /** Permission request deadline; defaults to {@link ACP_PERMISSION_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
}): HadamardToolApprover {
  return async context => {
    let outcomeKind: AcpPermissionOptionKind | 'cancelled';
    try {
      const raw = await withTimeout(
        options.channel.request('session/request_permission', {
          sessionId: options.sessionId,
          toolCall: {
            toolCallId: `${context.runId}:${context.iteration}:${context.toolName}`,
            title: context.publicName,
            kind: acpToolKind(context.publicName),
            status: 'pending',
            rawInput: context.input,
          },
          options: PERMISSION_OPTIONS.map(option => ({ ...option })),
        }),
        options.timeoutMs ?? ACP_PERMISSION_REQUEST_TIMEOUT_MS,
      );
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
