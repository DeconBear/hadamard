import { HadamardSdkError } from '../errors.js';
import type { CodeActHostRpcRequest, CodeCellStructuredResult } from './types.js';

export const CODEACT_PROTOCOL_VERSION = 1;
export const DEFAULT_MAX_PROTOCOL_LINE_BYTES = 1_048_576;

export type KernelInboundMessage =
  | { v: 1; type: 'ready'; pid: number }
  | { v: 1; type: 'stream'; executionId: string; stream: 'stdout' | 'stderr'; delta: string }
  | { v: 1; type: 'host_rpc'; executionId: string; request: CodeActHostRpcRequest }
  | {
      v: 1;
      type: 'result';
      executionId: string;
      ok: boolean;
      result?: CodeCellStructuredResult;
      error?: string;
      durationMs: number;
      resourceUsage?: Record<string, number>;
    };

export type KernelOutboundMessage =
  | {
      v: 1;
      type: 'execute';
      executionId: string;
      code: string;
      /** Sanitized method name → real host tool name, for typed `hadamard.<name>` dispatch. */
      toolNameMap?: Record<string, string>;
    }
  | { v: 1; type: 'host_rpc_result'; executionId: string; response: unknown }
  | { v: 1; type: 'shutdown' };

export class KernelProtocolError extends HadamardSdkError {
  constructor(message: string) {
    super(message, 'CODEACT_PROTOCOL_ERROR');
  }
}

export class KernelLineDecoder {
  private pending = Buffer.alloc(0);

  constructor(private readonly maxLineBytes = DEFAULT_MAX_PROTOCOL_LINE_BYTES) {}

  push(chunk: Buffer | string): KernelInboundMessage[] {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.pending = Buffer.concat([this.pending, bytes]);
    if (this.pending.length > this.maxLineBytes && this.pending.indexOf(0x0a) < 0) {
      throw new KernelProtocolError(`Kernel protocol line exceeded ${this.maxLineBytes} bytes.`);
    }
    const messages: KernelInboundMessage[] = [];
    let newline = this.pending.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      if (line.length > this.maxLineBytes) {
        throw new KernelProtocolError(`Kernel protocol line exceeded ${this.maxLineBytes} bytes.`);
      }
      if (line.length > 0) messages.push(parseKernelInboundMessage(line.toString('utf8')));
      newline = this.pending.indexOf(0x0a);
    }
    return messages;
  }
}

export function encodeKernelMessage(message: KernelOutboundMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseKernelInboundMessage(line: string): KernelInboundMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new KernelProtocolError(`Kernel emitted invalid JSON: ${asMessage(error)}`);
  }
  if (!isRecord(value) || value.v !== CODEACT_PROTOCOL_VERSION || typeof value.type !== 'string') {
    throw new KernelProtocolError('Kernel message has an invalid version or shape.');
  }
  if (value.type === 'ready' && isFiniteNumber(value.pid)) return value as KernelInboundMessage;
  if (value.type === 'stream'
    && typeof value.executionId === 'string'
    && (value.stream === 'stdout' || value.stream === 'stderr')
    && typeof value.delta === 'string') return value as KernelInboundMessage;
  if (value.type === 'host_rpc'
    && typeof value.executionId === 'string'
    && isHostRpcRequest(value.request)) return value as KernelInboundMessage;
  if (value.type === 'result'
    && typeof value.executionId === 'string'
    && typeof value.ok === 'boolean'
    && isFiniteNumber(value.durationMs)
    && (value.error === undefined || typeof value.error === 'string')) return value as KernelInboundMessage;
  throw new KernelProtocolError(`Unsupported kernel message type or payload: ${value.type}.`);
}

function isHostRpcRequest(value: unknown): value is CodeActHostRpcRequest {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.method === 'string'
    && 'input' in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
