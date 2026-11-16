import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_FRAME_BYTES,
  JSON_RPC_ERROR_CODES,
  JsonRpcError,
  JsonRpcFrameDecoder,
  encodeJsonRpcFrame,
  errorResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  notificationMessage,
  parseJsonRpcMessage,
  requestMessage,
  successResponse,
  toJsonRpcErrorObject,
  type JsonRpcMessage,
} from '../src/hcanvas/sidecar/jsonrpc.js';

const INIT_REQUEST = requestMessage(1, 'initialize', { protocolVersion: '1.0', client: { name: 'hcanvas', version: '0.2.0' }, capabilities: {} });

function decodeAll(chunks: Buffer[]): { messages: JsonRpcMessage[]; errors: JsonRpcError[]; decoder: JsonRpcFrameDecoder } {
  const decoder = new JsonRpcFrameDecoder();
  const messages: JsonRpcMessage[] = [];
  const errors: JsonRpcError[] = [];
  for (const chunk of chunks) {
    for (const frame of decoder.push(chunk)) {
      if (frame.kind === 'message') messages.push(frame.message);
      else errors.push(new JsonRpcError(frame.error.code, frame.error.message));
    }
  }
  return { messages, errors, decoder };
}

describe('jsonrpc framing', () => {
  it('encodes UTF-8 content length in bytes', () => {
    const message = notificationMessage('log', { level: 'info', message: '中文日志' });
    const frame = encodeJsonRpcFrame(message);
    const headerEnd = frame.indexOf('\r\n\r\n');
    expect(headerEnd).toBeGreaterThan(0);
    const header = frame.subarray(0, headerEnd).toString('ascii');
    const body = frame.subarray(headerEnd + 4);
    const declared = Number(/content-length:\s*(\d+)/i.exec(header)![1]);
    const json = JSON.stringify(message);
    expect(declared).toBe(Buffer.byteLength(json, 'utf8'));
    expect(body.toString('utf8')).toBe(json);
  });

  it('decodes a whole frame in one chunk', () => {
    const { messages, errors } = decodeAll([encodeJsonRpcFrame(INIT_REQUEST)]);
    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(INIT_REQUEST);
    expect(isJsonRpcRequest(messages[0]!)).toBe(true);
  });

  it('decodes every possible single split point', () => {
    const frame = encodeJsonRpcFrame(INIT_REQUEST);
    for (let split = 1; split < frame.length; split += 1) {
      const { messages, errors } = decodeAll([frame.subarray(0, split), frame.subarray(split)]);
      expect(errors, 'split=' + split).toHaveLength(0);
      expect(messages, 'split=' + split).toHaveLength(1);
      expect(messages[0]).toEqual(INIT_REQUEST);
    }
  });

  it('decodes byte-by-byte chunks including split UTF-8 code points', () => {
    const message = requestMessage('id-中文', 'echo', { text: 'héllo ✓ 世界' });
    const frame = encodeJsonRpcFrame(message);
    const chunks: Buffer[] = [];
    for (let index = 0; index < frame.length; index += 1) chunks.push(frame.subarray(index, index + 1));
    const { messages, errors } = decodeAll(chunks);
    expect(errors).toHaveLength(0);
    expect(messages).toEqual([message]);
  });

  it('waits for partial headers and partial bodies', () => {
    const decoder = new JsonRpcFrameDecoder();
    const frame = encodeJsonRpcFrame(INIT_REQUEST);
    const headerEnd = frame.indexOf('\r\n\r\n');
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.awaitingBody).toBe(false);
    expect(decoder.push(frame.subarray(3, headerEnd))).toEqual([]);
    expect(decoder.awaitingBody).toBe(false);
    const afterHeader = decoder.push(frame.subarray(headerEnd, headerEnd + 4));
    expect(afterHeader).toEqual([]);
    expect(decoder.awaitingBody).toBe(true);
    const partialBody = decoder.push(frame.subarray(headerEnd + 4, frame.length - 2));
    expect(partialBody).toEqual([]);
    expect(decoder.pendingBytes).toBeGreaterThan(0);
    const rest = decoder.push(frame.subarray(frame.length - 2));
    expect(rest).toHaveLength(1);
    expect(rest[0]).toEqual({ kind: 'message', message: INIT_REQUEST });
    expect(decoder.pendingBytes).toBe(0);
  });

  it('decodes multiple frames in one chunk and keeps a partial tail', () => {
    const first = encodeJsonRpcFrame(requestMessage(1, 'echo', { n: 1 }));
    const second = encodeJsonRpcFrame(notificationMessage('log', { message: 'two' }));
    const third = encodeJsonRpcFrame(requestMessage(3, 'echo', { n: 3 }));
    const combined = Buffer.concat([first, second, third]);
    const split = combined.length - 5;
    const { messages, errors } = decodeAll([combined.subarray(0, split), combined.subarray(split)]);
    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(3);
    expect(isJsonRpcRequest(messages[0]!)).toBe(true);
    expect(isJsonRpcNotification(messages[1]!)).toBe(true);
    expect(isJsonRpcRequest(messages[2]!)).toBe(true);
  });

  it('accepts string chunks', () => {
    const frame = encodeJsonRpcFrame(INIT_REQUEST).toString('utf8');
    const decoder = new JsonRpcFrameDecoder();
    const frames = decoder.push(frame);
    expect(frames).toHaveLength(1);
  });

  it('reports invalid JSON as a parse error frame (-32700)', () => {
    const body = '{not json';
    const frame = Buffer.concat([Buffer.from('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n', 'ascii'), Buffer.from(body, 'utf8')]);
    const { messages, errors } = decodeAll([frame]);
    expect(messages).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe(JSON_RPC_ERROR_CODES.parseError);
  });

  it('rejects invalid requests with -32600', () => {
    const { errors } = decodeAll([encodeJsonRpcFrame({ jsonrpc: '1.0', id: 1, method: 'x' } as unknown as JsonRpcMessage)]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe(JSON_RPC_ERROR_CODES.invalidRequest);
  });

  it('rejects missing Content-Length', () => {
    const body = Buffer.from('{}', 'utf8');
    const frame = Buffer.concat([Buffer.from('X-Test: 1\r\n\r\n', 'ascii'), body]);
    const { errors } = decodeAll([frame]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Content-Length');
  });

  it('rejects oversized frames and recovers', () => {
    const decoder = new JsonRpcFrameDecoder({ maxFrameBytes: 100 });
    const oversized = encodeJsonRpcFrame(requestMessage(1, 'echo', { payload: 'x'.repeat(300) }));
    const bad = decoder.push(oversized);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.kind).toBe('error');
    const goodFrame = encodeJsonRpcFrame(requestMessage(2, 'echo'));
    const frames = decoder.push(goodFrame);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ kind: 'message', message: requestMessage(2, 'echo') });
  });

  it('rejects oversized headers', () => {
    const decoder = new JsonRpcFrameDecoder({ maxHeaderBytes: 16 });
    const frames = decoder.push(Buffer.from('X-Padding: ' + 'a'.repeat(100) + '\r\n\r\n', 'ascii'));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.kind).toBe('error');
  });

  it('rejects a UTF-8 BOM', () => {
    const frame = encodeJsonRpcFrame(requestMessage(1, 'echo'));
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), frame]);
    const { messages, errors } = decodeAll([withBom]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('BOM');
    expect(messages).toHaveLength(1);
  });

  it('tolerates LF-only header terminators', () => {
    const body = Buffer.from(JSON.stringify(requestMessage(9, 'echo')), 'utf8');
    const frame = Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\n\n', 'ascii'), body]);
    const { messages, errors } = decodeAll([frame]);
    expect(errors).toHaveLength(0);
    expect(messages).toEqual([requestMessage(9, 'echo')]);
  });

  it('exposes defaults suitable for kernel chunks', () => {
    expect(DEFAULT_MAX_FRAME_BYTES).toBeGreaterThanOrEqual(16 * 1024 * 1024);
  });
});

describe('jsonrpc message helpers', () => {
  it('builds requests, notifications, results and errors', () => {
    expect(requestMessage(1, 'echo', { a: 1 })).toEqual({ jsonrpc: '2.0', id: 1, method: 'echo', params: { a: 1 } });
    expect(notificationMessage('log')).toEqual({ jsonrpc: '2.0', method: 'log' });
    expect(successResponse(2, { ok: true })).toEqual({ jsonrpc: '2.0', id: 2, result: { ok: true } });
    const error = errorResponse(3, new JsonRpcError(JSON_RPC_ERROR_CODES.invalidParams, 'bad input'));
    expect(error).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'bad input' } });
  });

  it('round-trips every message shape through the frame decoder', () => {
    const messages: JsonRpcMessage[] = [
      requestMessage('a', 'echo', { a: 1 }),
      notificationMessage('$/progress', { token: 1, value: { kind: 'begin' } }),
      successResponse(5, { ok: true }),
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'nope' } },
    ];
    for (const message of messages) {
      const { messages: decoded, errors } = decodeAll([encodeJsonRpcFrame(message)]);
      expect(errors).toHaveLength(0);
      expect(decoded).toEqual([message]);
    }
    expect(isJsonRpcResponse(messages[2]!)).toBe(true);
  });

  it('validates response shape', () => {
    expect(() => parseJsonRpcMessage({ jsonrpc: '2.0', id: 1 })).toThrow(JsonRpcError);
    expect(() => parseJsonRpcMessage({ jsonrpc: '2.0', id: 1, result: 1, error: { code: 1, message: 'x' } })).toThrow(JsonRpcError);
    expect(parseJsonRpcMessage({ jsonrpc: '2.0', id: 1, result: null })).toEqual({ jsonrpc: '2.0', id: 1, result: null });
  });

  it('never throws while normalizing unknown errors', () => {
    expect(toJsonRpcErrorObject(new Error('boom'))).toEqual({ code: -32603, message: 'boom' });
    expect(toJsonRpcErrorObject('nope')).toEqual({ code: -32603, message: 'nope' });
    expect(toJsonRpcErrorObject(new JsonRpcError(-32000, 'server error', { a: 1 }))).toEqual({ code: -32000, message: 'server error', data: { a: 1 } });
  });
});
