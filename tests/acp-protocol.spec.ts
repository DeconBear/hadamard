import { describe, expect, it } from 'vitest';

import {
  ACP_ERROR_INVALID_PARAMS,
  ACP_ERROR_INVALID_REQUEST,
  AcpProtocolError,
  acpToolKind,
  createAcpToolApprover,
  isAbortLikeError,
  mapAgentEventToAcpUpdates,
  mapRunResultToStopReason,
  parseAcpMessage,
  parseNewSessionParams,
  parsePromptParams,
  parseRequestPermissionResult,
} from '../src/acp/index.js';
import { parseAcpCliArgs } from '../src/acp/acpCli.js';
import type { AgentRunResult } from '../src/types.js';

describe('parseAcpMessage', () => {
  it('parses requests, notifications, and responses', () => {
    expect(parseAcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
      .toEqual({ kind: 'request', id: 1, method: 'initialize', params: {} });
    expect(parseAcpMessage({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } }))
      .toEqual({ kind: 'notification', method: 'session/cancel', params: { sessionId: 's' } });
    expect(parseAcpMessage({ jsonrpc: '2.0', id: 'x', result: { ok: true } }))
      .toEqual({ kind: 'response', id: 'x', result: { ok: true } });
    expect(parseAcpMessage({ jsonrpc: '2.0', id: 'x', error: { code: -32601, message: 'nope' } }))
      .toMatchObject({ kind: 'response', id: 'x', error: { code: -32601 } });
  });

  it('fails closed on malformed messages', () => {
    for (const bad of [null, 42, 'x', [], {}, { jsonrpc: '1.0', method: 'm' }, { jsonrpc: '2.0' }]) {
      expect(() => parseAcpMessage(bad), JSON.stringify(bad)).toThrowError(AcpProtocolError);
    }
    try {
      parseAcpMessage(null);
      expect.unreachable();
    } catch (error) {
      expect((error as AcpProtocolError).code).toBe(ACP_ERROR_INVALID_REQUEST);
    }
  });
});

describe('param validation', () => {
  it('requires a non-empty cwd for session/new', () => {
    expect(parseNewSessionParams({ cwd: '/workspace' })).toEqual({ cwd: '/workspace' });
    expect(() => parseNewSessionParams({})).toThrowError(AcpProtocolError);
    expect(() => parseNewSessionParams({ cwd: '  ' })).toThrowError(AcpProtocolError);
  });

  it('accepts text prompt blocks only', () => {
    expect(parsePromptParams({
      sessionId: 's',
      prompt: [{ type: 'text', text: 'hello' }],
    })).toEqual({ sessionId: 's', prompt: [{ type: 'text', text: 'hello' }] });
    for (const prompt of [[], [{ type: 'image', data: 'x' }], [{ type: 'text' }], 'nope']) {
      expect(() => parsePromptParams({ sessionId: 's', prompt }), JSON.stringify(prompt))
        .toThrowError(AcpProtocolError);
    }
    try {
      parsePromptParams({ sessionId: 's', prompt: [] });
      expect.unreachable();
    } catch (error) {
      expect((error as AcpProtocolError).code).toBe(ACP_ERROR_INVALID_PARAMS);
    }
  });

  it('parses permission outcomes and rejects unknown shapes', () => {
    expect(parseRequestPermissionResult({ outcome: { outcome: 'selected', optionId: 'allow-once' } }))
      .toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(parseRequestPermissionResult({ outcome: { outcome: 'cancelled' } }))
      .toEqual({ outcome: { outcome: 'cancelled' } });
    expect(() => parseRequestPermissionResult({ outcome: { outcome: 'maybe' } }))
      .toThrowError(AcpProtocolError);
    expect(() => parseRequestPermissionResult({})).toThrowError(AcpProtocolError);
  });
});

describe('mapAgentEventToAcpUpdates', () => {
  it('maps text and thinking deltas to message/thought chunks', () => {
    expect(mapAgentEventToAcpUpdates({
      type: 'response.text.delta', runId: 'r', iteration: 1, delta: 'Hi', snapshot: 'Hi', timestamp: 't',
    })).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } }]);
    expect(mapAgentEventToAcpUpdates({
      type: 'response.thinking.delta', runId: 'r', iteration: 1, index: 0, delta: 'hm', snapshot: 'hm', timestamp: 't',
    })).toEqual([{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } }]);
  });

  it('maps tool lifecycle events with kind and status', () => {
    expect(mapAgentEventToAcpUpdates({
      type: 'tool.call',
      runId: 'r',
      iteration: 1,
      call: { id: 'tc-1', name: 'bash', publicName: 'Bash', provider: 'local', input: { command: 'ls' }, startedAt: 't' },
      timestamp: 't',
    })).toEqual([{
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'Bash',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'ls' },
    }]);
    expect(mapAgentEventToAcpUpdates({
      type: 'tool.result',
      runId: 'r',
      iteration: 1,
      result: {
        id: 'tc-1', name: 'read', publicName: 'Read', provider: 'local', input: {},
        startedAt: 't', outputText: 'boom', isError: true, completedAt: 't', durationMs: 1,
      },
      timestamp: 't',
    })).toEqual([{
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'failed',
      rawOutput: 'boom',
    }]);
  });

  it('drops events that ACP expresses through the prompt stopReason', () => {
    expect(mapAgentEventToAcpUpdates({
      type: 'response.completed', runId: 'r', result: {} as AgentRunResult, timestamp: 't',
    })).toEqual([]);
    expect(mapAgentEventToAcpUpdates({
      type: 'error', runId: 'r', error: { message: 'x' }, timestamp: 't',
    })).toEqual([]);
  });

  it('maps tool kinds from public names', () => {
    expect(acpToolKind('Read')).toBe('read');
    expect(acpToolKind('Edit')).toBe('edit');
    expect(acpToolKind('Grep')).toBe('search');
    expect(acpToolKind('Bash')).toBe('execute');
    expect(acpToolKind('WebFetch')).toBe('fetch');
    expect(acpToolKind('SomethingElse')).toBe('other');
  });
});

describe('mapRunResultToStopReason', () => {
  const base = {} as AgentRunResult;
  it('maps Hadamard run outcomes onto the ACP vocabulary', () => {
    expect(mapRunResultToStopReason({ ...base, stopReason: 'end_turn' })).toBe('end_turn');
    expect(mapRunResultToStopReason({ ...base, stopReason: 'stop_sequence' })).toBe('end_turn');
    expect(mapRunResultToStopReason({ ...base, stopReason: 'max_tokens' })).toBe('max_tokens');
    expect(mapRunResultToStopReason({ ...base, stopReason: 'refusal' })).toBe('refusal');
    expect(mapRunResultToStopReason({ ...base, stopReason: null, maxToolIterationsExceeded: true }))
      .toBe('max_turn_requests');
    expect(mapRunResultToStopReason({ ...base, stopReason: null, incompleteReason: 'max_tool_iterations_exceeded:200' }))
      .toBe('max_turn_requests');
  });

  it('detects abort-like errors', () => {
    const aborted = new Error('cancelled');
    aborted.name = 'RunAbortedError';
    expect(isAbortLikeError(aborted)).toBe(true);
    expect(isAbortLikeError(new Error('boom'))).toBe(false);
    expect(isAbortLikeError('nope')).toBe(false);
  });
});

describe('createAcpToolApprover', () => {
  const context = {
    runId: 'r', sessionId: 's', workDir: '/w', toolName: 'bash', publicName: 'Bash',
    input: { command: 'ls' }, prompt: 'p', iteration: 1,
    mode: 'default' as const, proposedBehavior: 'ask' as const, reason: 'ask', source: 'rule' as const,
  };

  it('allows on allow_once / allow_always selections', async () => {
    for (const optionId of ['allow-once', 'allow-always']) {
      const approver = createAcpToolApprover({
        sessionId: 's',
        channel: { notify: () => undefined, request: async () => ({ outcome: { outcome: 'selected', optionId } }) },
      });
      await expect(approver(context)).resolves.toMatchObject({ behavior: 'allow' });
    }
  });

  it('denies on reject selections, cancelled outcomes, unknown option ids, and transport failures', async () => {
    const outcomes = [
      { outcome: { outcome: 'selected', optionId: 'reject-once' } },
      { outcome: { outcome: 'selected', optionId: 'reject-always' } },
      { outcome: { outcome: 'selected', optionId: 'surprise' } },
      { outcome: { outcome: 'cancelled' } },
    ];
    for (const outcome of outcomes) {
      const approver = createAcpToolApprover({
        sessionId: 's',
        channel: { notify: () => undefined, request: async () => outcome },
      });
      await expect(approver(context), JSON.stringify(outcome)).resolves.toMatchObject({ behavior: 'deny' });
    }
    const failing = createAcpToolApprover({
      sessionId: 's',
      channel: { notify: () => undefined, request: async () => { throw new Error('client gone'); } },
    });
    await expect(failing(context)).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('denies when the client never answers within the permission timeout', async () => {
    const approver = createAcpToolApprover({
      sessionId: 's',
      timeoutMs: 20,
      channel: { notify: () => undefined, request: () => new Promise(() => { /* never settles */ }) },
    });
    await expect(approver(context)).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('sends an ACP-shaped permission request with all four option kinds', async () => {
    let captured: unknown;
    const approver = createAcpToolApprover({
      sessionId: 'session-1',
      channel: {
        notify: () => undefined,
        request: async (method, params) => {
          expect(method).toBe('session/request_permission');
          captured = params;
          return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
        },
      },
    });
    await approver(context);
    expect(captured).toMatchObject({
      sessionId: 'session-1',
      toolCall: { title: 'Bash', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } },
    });
    const kinds = (captured as { options: { kind: string }[] }).options.map(option => option.kind);
    expect(kinds).toEqual(['allow_once', 'allow_always', 'reject_once', 'reject_always']);
  });
});

describe('parseAcpCliArgs', () => {
  it('defaults to the clean engine and default permission mode', () => {
    expect(parseAcpCliArgs([])).toEqual({
      engine: 'clean', runtime: undefined, model: undefined, permissionMode: 'default',
    });
    expect(parseAcpCliArgs(['--engine', 'clean', '--model=m1', '--permission-mode', 'plan']))
      .toEqual({ engine: 'clean', runtime: undefined, model: 'm1', permissionMode: 'plan' });
    expect(parseAcpCliArgs(['--engine', 'bridge', '--runtime', 'claude']))
      .toMatchObject({ engine: 'bridge', runtime: 'claude' });
  });

  it('fails fast on unsupported engines, modes, and unknown arguments', () => {
    expect(() => parseAcpCliArgs(['--engine', 'hybrid'])).toThrowError(/Unsupported --engine/);
    expect(() => parseAcpCliArgs(['--permission-mode', 'yolo'])).toThrowError(/Unsupported --permission-mode/);
    expect(() => parseAcpCliArgs(['--wat'])).toThrowError(/Unknown argument/);
    expect(() => parseAcpCliArgs(['--model'])).toThrowError(/requires a value/);
  });

  it('validates engine/runtime combinations', () => {
    expect(() => parseAcpCliArgs(['--engine', 'bridge'])).toThrowError(/requires --runtime/);
    expect(() => parseAcpCliArgs(['--engine', 'bridge', '--runtime', 'bogus']))
      .toThrowError(/Unsupported --runtime/);
    expect(() => parseAcpCliArgs(['--engine', 'clean', '--runtime', 'claude']))
      .toThrowError(/only applies to --engine bridge/);
    expect(() => parseAcpCliArgs(['--engine', 'team'])).toThrowError(/requires --team/);
    expect(parseAcpCliArgs(['--engine', 'team', '--team', 'reviewer']))
      .toMatchObject({ engine: 'team', team: 'reviewer' });
    expect(() => parseAcpCliArgs(['--engine', 'clean', '--team', 'reviewer']))
      .toThrowError(/--team only applies to --engine team/);
    expect(() => parseAcpCliArgs(['--engine', 'team', '--team', 'x', '--runtime', 'claude']))
      .toThrowError(/only applies to --engine bridge/);
  });
});
