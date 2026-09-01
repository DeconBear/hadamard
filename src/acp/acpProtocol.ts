/**
 * ACP (Agent Client Protocol) v1 wire types and parsing.
 *
 * Transport is JSON-RPC 2.0 over stdio framed as NDJSON: one message per
 * line, no embedded newlines. This module is the fail-closed boundary —
 * anything malformed raises {@link AcpProtocolError} and never reaches the
 * server logic. See plan/ACP_APP_SERVER_COMPAT_ADR_01Sep2026.md.
 */

export const ACP_PROTOCOL_VERSION = 1;

export const ACP_ERROR_PARSE = -32700;
export const ACP_ERROR_INVALID_REQUEST = -32600;
export const ACP_ERROR_METHOD_NOT_FOUND = -32601;
export const ACP_ERROR_INVALID_PARAMS = -32602;
export const ACP_ERROR_INTERNAL = -32603;

export type AcpId = number | string;

export class AcpProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AcpProtocolError';
  }
}

export interface AcpRequestMessage {
  kind: 'request';
  id: AcpId;
  method: string;
  params?: unknown;
}

export interface AcpNotificationMessage {
  kind: 'notification';
  method: string;
  params?: unknown;
}

export interface AcpResponseMessage {
  kind: 'response';
  id: AcpId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type AcpMessage = AcpRequestMessage | AcpNotificationMessage | AcpResponseMessage;

export interface AcpErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface AcpResultResponse {
  jsonrpc: '2.0';
  id: AcpId;
  result: unknown;
}

export interface AcpErrorResponse {
  jsonrpc: '2.0';
  id: AcpId | null;
  error: AcpErrorBody;
}

export type AcpServerResponse = AcpResultResponse | AcpErrorResponse;

/** Parse one decoded JSON value into a discriminated ACP message. Fails closed. */
export function parseAcpMessage(value: unknown): AcpMessage {
  if (!isRecord(value) || value.jsonrpc !== '2.0') {
    throw new AcpProtocolError(ACP_ERROR_INVALID_REQUEST, 'Message must be a JSON-RPC 2.0 object.');
  }
  const hasMethod = typeof value.method === 'string';
  const hasId = typeof value.id === 'string' || typeof value.id === 'number';
  if (hasMethod && hasId) {
    return { kind: 'request', id: value.id as AcpId, method: value.method as string, params: value.params };
  }
  if (hasMethod) {
    return { kind: 'notification', method: value.method as string, params: value.params };
  }
  if (hasId && ('result' in value || 'error' in value)) {
    const response: AcpResponseMessage = { kind: 'response', id: value.id as AcpId };
    if ('error' in value) {
      const error = value.error;
      if (!isRecord(error) || typeof error.code !== 'number' || typeof error.message !== 'string') {
        throw new AcpProtocolError(ACP_ERROR_INVALID_REQUEST, 'Response error must carry numeric code and message.');
      }
      response.error = { code: error.code, message: error.message, data: error.data };
    } else {
      response.result = value.result;
    }
    return response;
  }
  throw new AcpProtocolError(ACP_ERROR_INVALID_REQUEST, 'Message is neither request, notification, nor response.');
}

export function acpResult(id: AcpId, result: unknown): AcpResultResponse {
  return { jsonrpc: '2.0', id, result };
}

export function acpError(id: AcpId | null, code: number, message: string, data?: unknown): AcpErrorResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export function acpErrorFromException(id: AcpId | null, error: unknown): AcpErrorResponse {
  if (error instanceof AcpProtocolError) return acpError(id, error.code, error.message, error.data);
  return acpError(id, ACP_ERROR_INTERNAL, error instanceof Error ? error.message : String(error));
}

// ── initialize ─────────────────────────────────────────────────────

export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
  clientInfo?: { name: string; version: string; title?: string };
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean };
    loadSession: boolean;
  };
  agentInfo: { name: string; version: string; title?: string };
  authMethods: [];
  /** Extension metadata; ACP reserves _meta for implementation-specific data. */
  _meta?: Record<string, unknown>;
}

export function parseInitializeParams(value: unknown): AcpInitializeParams {
  const record = requireRecord(value, 'initialize');
  const protocolVersion = record.protocolVersion;
  if (typeof protocolVersion !== 'number' || !Number.isInteger(protocolVersion) || protocolVersion < 1) {
    throw new AcpProtocolError(ACP_ERROR_INVALID_PARAMS, 'initialize.protocolVersion must be a positive integer.');
  }
  const capabilities = record.clientCapabilities === undefined ? {} : requireRecord(record.clientCapabilities, 'initialize.clientCapabilities');
  const result: AcpInitializeParams = { protocolVersion, clientCapabilities: {} };
  if (capabilities.fs !== undefined) {
    const fs = requireRecord(capabilities.fs, 'initialize.clientCapabilities.fs');
    result.clientCapabilities.fs = {
      readTextFile: fs.readTextFile === true,
      writeTextFile: fs.writeTextFile === true,
    };
  }
  if (capabilities.terminal !== undefined) result.clientCapabilities.terminal = capabilities.terminal === true;
  if (isRecord(record.clientInfo) && typeof record.clientInfo.name === 'string') {
    result.clientInfo = {
      name: record.clientInfo.name,
      version: typeof record.clientInfo.version === 'string' ? record.clientInfo.version : '',
      ...(typeof record.clientInfo.title === 'string' ? { title: record.clientInfo.title } : {}),
    };
  }
  return result;
}

// ── session/new ────────────────────────────────────────────────────

export interface AcpNewSessionParams {
  cwd: string;
}

export interface AcpNewSessionResult {
  sessionId: string;
}

export function parseNewSessionParams(value: unknown): AcpNewSessionParams {
  const record = requireRecord(value, 'session/new');
  if (typeof record.cwd !== 'string' || !record.cwd.trim()) {
    throw new AcpProtocolError(ACP_ERROR_INVALID_PARAMS, 'session/new.cwd must be a non-empty absolute path.');
  }
  return { cwd: record.cwd.trim() };
}

// ── session/prompt ─────────────────────────────────────────────────

export interface AcpTextContentBlock {
  type: 'text';
  text: string;
}

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface AcpPromptParams {
  sessionId: string;
  prompt: AcpTextContentBlock[];
}

export interface AcpPromptResult {
  stopReason: AcpStopReason;
}

export function parsePromptParams(value: unknown): AcpPromptParams {
  const record = requireRecord(value, 'session/prompt');
  const sessionId = requireSessionId(record, 'session/prompt');
  if (!Array.isArray(record.prompt) || record.prompt.length === 0) {
    throw new AcpProtocolError(ACP_ERROR_INVALID_PARAMS, 'session/prompt.prompt must be a non-empty ContentBlock array.');
  }
  const prompt: AcpTextContentBlock[] = [];
  for (const block of record.prompt) {
    if (!isRecord(block) || typeof block.type !== 'string') {
      throw new AcpProtocolError(ACP_ERROR_INVALID_PARAMS, 'session/prompt.prompt entries must be ContentBlock objects.');
    }
    if (block.type !== 'text' || typeof block.text !== 'string') {
      throw new AcpProtocolError(
        ACP_ERROR_INVALID_PARAMS,
        `session/prompt supports text ContentBlocks only; got "${String(block.type)}".`,
      );
    }
    prompt.push({ type: 'text', text: block.text });
  }
  return { sessionId, prompt };
}

// ── session/cancel ─────────────────────────────────────────────────

export interface AcpCancelParams {
  sessionId: string;
}

export function parseCancelParams(value: unknown): AcpCancelParams {
  const record = requireRecord(value, 'session/cancel');
  return { sessionId: requireSessionId(record, 'session/cancel') };
}

// ── session/update (agent → client notifications) ──────────────────

export type AcpToolCallKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface AcpToolCallUpdate {
  toolCallId: string;
  title?: string;
  kind?: AcpToolCallKind;
  status?: AcpToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type AcpSessionUpdateBody =
  | { sessionUpdate: 'agent_message_chunk'; content: AcpTextContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: AcpTextContentBlock }
  | ({ sessionUpdate: 'tool_call'; toolCallId: string; title: string } & Omit<AcpToolCallUpdate, 'toolCallId'>)
  | ({ sessionUpdate: 'tool_call_update' } & AcpToolCallUpdate);

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: AcpSessionUpdateBody;
}

// ── session/request_permission (agent → client request) ────────────

export type AcpPermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
}

export type AcpPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

export interface AcpRequestPermissionResult {
  outcome: AcpPermissionOutcome;
}

export function parseRequestPermissionResult(value: unknown): AcpRequestPermissionResult {
  const record = requireRecord(value, 'session/request_permission result');
  const outcome = record.outcome;
  if (!isRecord(outcome) || typeof outcome.outcome !== 'string') {
    throw new AcpProtocolError(ACP_ERROR_INTERNAL, 'session/request_permission result must carry an outcome object.');
  }
  if (outcome.outcome === 'cancelled') return { outcome: { outcome: 'cancelled' } };
  if (outcome.outcome === 'selected' && typeof outcome.optionId === 'string') {
    return { outcome: { outcome: 'selected', optionId: outcome.optionId } };
  }
  throw new AcpProtocolError(ACP_ERROR_INTERNAL, `Unknown permission outcome: ${String(outcome.outcome)}.`);
}

// ── helpers ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AcpProtocolError(ACP_ERROR_INVALID_PARAMS, `${context} params must be an object.`);
  }
  return value;
}

function requireSessionId(record: Record<string, unknown>, context: string): string {
  if (typeof record.sessionId !== 'string' || !record.sessionId.trim()) {
    throw new AcpProtocolError(ACP_ERROR_INVALID_PARAMS, `${context}.sessionId must be a non-empty string.`);
  }
  return record.sessionId;
}
