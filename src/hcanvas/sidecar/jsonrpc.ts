// JSON-RPC 2.0 message types + helpers and LSP-style Content-Length framing
// for Hcanvas sidecar / kernel stdio transports (plan SPEC-7.1, SPEC-8.1).
//
// Transport rules encoded here:
//  - `Content-Length: <utf8 byte count>\r\n\r\n<json body>`, UTF-8, no BOM.
//  - stdout of a sidecar carries protocol frames only; this module never writes.
//  - The decoder is incremental: chunks may split headers, bodies and UTF-8
//    multi-byte sequences at arbitrary byte offsets.
import { Buffer } from 'node:buffer';

export type JsonRpcId = number | string;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** Standard JSON-RPC 2.0 error codes plus LSP's RequestCancelled. */
export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  requestCancelled: -32800,
} as const;

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && 'id' in message;
}

export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && !('id' in message);
}

export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !('method' in message) && 'id' in message;
}

/**
 * Validate an already-parsed JSON value as a JSON-RPC 2.0 message.
 * Throws JsonRpcError(-32600) for anything that is not a well-formed message.
 */
export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
  if (!isRecord(value)) throw new JsonRpcError(JSON_RPC_ERROR_CODES.invalidRequest, 'Message must be a JSON object');
  if (value.jsonrpc !== '2.0') throw new JsonRpcError(JSON_RPC_ERROR_CODES.invalidRequest, 'jsonrpc must be "2.0"');
  if (typeof value.method === 'string') {
    const method = value.method;
    if (!method) throw new JsonRpcError(JSON_RPC_ERROR_CODES.invalidRequest, 'method must not be empty');
    if ('id' in value) {
      if (!isJsonRpcId(value.id)) throw new JsonRpcError(JSON_RPC_ERROR_CODES.invalidRequest, 'Request id must be a string or number');
      return { jsonrpc: '2.0', id: value.id, method, ...(value.params === undefined ? {} : { params: value.params }) };
    }
    return { jsonrpc: '2.0', method, ...(value.params === undefined ? {} : { params: value.params }) };
  }
  if (!('id' in value)) throw new JsonRpcError(JSON_RPC_ERROR_CODES.invalidRequest, 'Message has neither method nor id');
  if (value.id !== null && !isJsonRpcId(value.id)) {
    throw new JsonRpcError(JSON_RPC_ERROR_CODES.invalidRequest, 'Response id must be a string, number or null');
  }
  const hasResult = Object.prototype.hasOwnProperty.call(value, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(value, 'error');
  if (hasResult === hasError) throw new JsonRpcError(JSON_RPC_ERROR_CODES.invalidRequest, 'Response must carry exactly one of result or error');
  if (hasError) {
    const error = value.error;
    if (!isRecord(error) || typeof error.code !== 'number' || typeof error.message !== 'string') {
      throw new JsonRpcError(JSON_RPC_ERROR_CODES.invalidRequest, 'Response error must be {code:number, message:string}');
    }
    return {
      jsonrpc: '2.0',
      id: value.id,
      error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) },
    };
  }
  return { jsonrpc: '2.0', id: value.id, result: value.result };
}

/** Normalize any thrown value into a JSON-RPC error object (never throws). */
export function toJsonRpcErrorObject(error: unknown, fallbackCode: number = JSON_RPC_ERROR_CODES.internalError): JsonRpcErrorObject {
  if (error instanceof JsonRpcError) {
    return { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) };
  }
  if (isRecord(error) && typeof error.code === 'number' && typeof error.message === 'string') {
    return { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: fallbackCode, message };
}

// ---------------------------------------------------------------------------
// Construction helpers (outbound messages)
// ---------------------------------------------------------------------------

export function requestMessage(id: JsonRpcId, method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

export function notificationMessage(method: string, params?: unknown): JsonRpcNotification {
  return { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) };
}

export function successResponse(id: JsonRpcId | null, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: '2.0', id, result };
}

export function errorResponse(id: JsonRpcId | null, error: unknown, fallbackCode: number = JSON_RPC_ERROR_CODES.internalError): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', id, error: toJsonRpcErrorObject(error, fallbackCode) };
}

// ---------------------------------------------------------------------------
// LSP Content-Length framing
// ---------------------------------------------------------------------------

export interface JsonRpcFrameDecoderOptions {
  /** Hard cap for a single frame body; oversized frames are rejected and dropped. */
  maxFrameBytes?: number;
  /** Hard cap for the header block before it is rejected as malformed. */
  maxHeaderBytes?: number;
}

export interface JsonRpcFrameError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcInboundFrame =
  | { kind: 'message'; message: JsonRpcMessage }
  | { kind: 'error'; error: JsonRpcErrorObject };

export const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_HEADER_BYTES = 8 * 1024;

/** Encode one JSON-RPC message as a Content-Length frame (UTF-8 byte length). */
export function encodeJsonRpcFrame(message: JsonRpcMessage | Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'),
    body,
  ]);
}

interface PlannedFrame {
  length: number;
  contentType?: string;
}

function parseHeaderBlock(raw: string): { contentLength: number; contentType?: string } | JsonRpcErrorObject {
  let contentLength: number | undefined;
  let contentType: string | undefined;
  for (const line of raw.split(/\r?\n/u)) {
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) return { code: JSON_RPC_ERROR_CODES.parseError, message: 'Malformed frame header line: ' + JSON.stringify(line) };
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === 'content-length') {
      if (!/^\d+$/u.test(value)) return { code: JSON_RPC_ERROR_CODES.parseError, message: 'Invalid Content-Length header' };
      contentLength = Number(value);
    } else if (name === 'content-type') {
      contentType = value;
    }
  }
  if (contentLength === undefined) return { code: JSON_RPC_ERROR_CODES.parseError, message: 'Missing Content-Length header' };
  if (contentLength <= 0) return { code: JSON_RPC_ERROR_CODES.parseError, message: 'Content-Length must be positive' };
  return { contentLength, ...(contentType === undefined ? {} : { contentType }) };
}

/**
 * Incremental LSP frame decoder. Feed arbitrary chunks; every completed frame is
 * returned as either a validated JSON-RPC message or a protocol error. Malformed
 * frames never throw: they surface as `{kind:'error'}` entries so the owner can
 * respond with -32700 / -32600 without crashing the stdout reader.
 */
export class JsonRpcFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private planned: PlannedFrame | null = null;
  private readonly maxFrameBytes: number;
  private readonly maxHeaderBytes: number;
  private bomChecked = false;

  constructor(options: JsonRpcFrameDecoderOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
  }

  /** Bytes buffered but not yet consumed by a complete frame. */
  get pendingBytes(): number {
    return this.buffer.length;
  }

  /** True when a header was parsed and the decoder is waiting for the body. */
  get awaitingBody(): boolean {
    return this.planned !== null;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.planned = null;
    this.bomChecked = true;
  }

  push(chunk: Buffer | Uint8Array | string): JsonRpcInboundFrame[] {
    const frames: JsonRpcInboundFrame[] = [];
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length === 0) return frames;
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);
    // SPEC-7.1: UTF-8, no BOM. Reject a leading BOM once, then keep parsing.
    if (!this.bomChecked && this.buffer.length >= 3 && this.buffer[0] === 0xef && this.buffer[1] === 0xbb && this.buffer[2] === 0xbf) {
      this.bomChecked = true;
      this.buffer = this.buffer.subarray(3);
      frames.push({ kind: 'error', error: { code: JSON_RPC_ERROR_CODES.parseError, message: 'UTF-8 BOM is not allowed on the sidecar protocol stream' } });
    } else if (this.buffer.length >= 3) {
      this.bomChecked = true;
    }
    while (this.buffer.length > 0) {
      if (this.planned === null) {
        const found = findHeaderBoundary(this.buffer);
        if (!found) {
          if (this.buffer.length > this.maxHeaderBytes) {
            frames.push({ kind: 'error', error: { code: JSON_RPC_ERROR_CODES.parseError, message: 'Frame header exceeds ' + this.maxHeaderBytes + ' bytes' } });
            this.buffer = Buffer.alloc(0);
          }
          break;
        }
        const { headerLength } = found;
        const rawHeader = this.buffer.subarray(0, headerLength).toString('utf8');
        this.buffer = this.buffer.subarray(headerLength);
        const header = parseHeaderBlock(rawHeader);
        if ('code' in header) {
          frames.push({ kind: 'error', error: header });
          continue;
        }
        if (header.contentLength > this.maxFrameBytes) {
          frames.push({
            kind: 'error',
            error: {
              code: JSON_RPC_ERROR_CODES.parseError,
              message: 'Frame body of ' + header.contentLength + ' bytes exceeds the ' + this.maxFrameBytes + ' byte limit',
            },
          });
          this.buffer = Buffer.alloc(0);
          break;
        }
        this.planned = { length: header.contentLength, ...(header.contentType === undefined ? {} : { contentType: header.contentType }) };
      }
      if (this.planned === null) break;
      if (this.buffer.length < this.planned.length) break;
      const body = this.buffer.subarray(0, this.planned.length);
      this.buffer = this.buffer.subarray(this.planned.length);
      this.planned = null;
      frames.push(decodeFrameBody(body));
    }
    return frames;
  }
}

function findHeaderBoundary(buffer: Buffer): { headerLength: number } | null {
  const crlf = buffer.indexOf('\r\n\r\n', 0, 'ascii');
  const lf = buffer.indexOf('\n\n', 0, 'ascii');
  if (crlf === -1 && lf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { headerLength: crlf + 4 };
  return { headerLength: lf + 2 };
}

function decodeFrameBody(body: Buffer): JsonRpcInboundFrame {
  const text = body.toString('utf8');
  if (text.includes('\u0000')) {
    return { kind: 'error', error: { code: JSON_RPC_ERROR_CODES.parseError, message: 'Frame body contains NUL bytes' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      kind: 'error',
      error: {
        code: JSON_RPC_ERROR_CODES.parseError,
        message: 'Invalid JSON frame body: ' + (error instanceof Error ? error.message : String(error)),
        data: text.slice(0, 200),
      },
    };
  }
  try {
    return { kind: 'message', message: parseJsonRpcMessage(parsed) };
  } catch (error) {
    return { kind: 'error', error: toJsonRpcErrorObject(error, JSON_RPC_ERROR_CODES.parseError) };
  }
}
