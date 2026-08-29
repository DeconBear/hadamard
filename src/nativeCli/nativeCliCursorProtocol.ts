import { HadamardBridgeProcessError } from '../errors.js';
import { isRecord } from '../runtime/helpers.js';
import type {
  HadamardBridgeJsonEvent,
  HadamardBridgeRunOptions,
} from '../types.js';

export interface CursorCliNormalizer {
  translate(raw: Record<string, unknown>): HadamardBridgeJsonEvent[];
}

export function buildCursorArgs(prompt: string, options: HadamardBridgeRunOptions): string[] {
  const args = ['--trust', '--output-format', 'stream-json', '--stream-partial-output'];
  const permissionMode = options.permissionMode ?? 'default';
  if (permissionMode === 'plan') {
    args.push('--mode', 'plan');
  } else if (
    permissionMode === 'acceptEdits'
    || permissionMode === 'bypassPermissions'
    || options.dangerouslySkipPermissions === true
  ) {
    args.push('--force');
  }
  if (options.model) args.push('--model', validateCursorValue(options.model, 'model'));
  if (typeof options.resume === 'string') {
    args.push('--resume', validateCursorValue(options.resume, 'session id'));
  } else if (options.resume === true || options.continueMostRecent === true) {
    args.push('--continue');
  }
  args.push('-p', prompt);
  return args;
}

export function createCursorNormalizer(): CursorCliNormalizer {
  return new CursorNormalizer();
}

function validateCursorValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new HadamardBridgeProcessError(
      `Cursor ${label} must be a non-option value without control characters.`,
    );
  }
  return normalized;
}

function cursorToolCallName(key: string): string {
  return key.replace(/ToolCall$/u, '') || key;
}

function cursorToolResultContent(call: Record<string, unknown>): string {
  const value = call.result ?? call.error;
  if (typeof value === 'string') return value;
  return value == null ? '' : (JSON.stringify(value, null, 2) ?? '');
}

class CursorNormalizer implements CursorCliNormalizer {
  private sessionId: string | undefined;
  private model: string | undefined;
  private cwd: string | undefined;
  private initEmitted = false;
  private sawDelta = false;
  private toolCallSeq = 0;
  private readonly pendingToolCalls = new Map<string, string>();

  translate(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    const type = typeof raw.type === 'string' ? raw.type : '';
    if (type === 'system') {
      if (raw.subtype !== 'init' || this.initEmitted) return [];
      this.initEmitted = true;
      this.sessionId = typeof raw.session_id === 'string' ? raw.session_id : this.sessionId;
      this.model = typeof raw.model === 'string' ? raw.model : this.model;
      this.cwd = typeof raw.cwd === 'string' ? raw.cwd : this.cwd;
      const init = event('system', {
        subtype: 'init',
        session_id: this.sessionId ?? '',
        tools: [],
        mcp_servers: [],
        slash_commands: [],
        agents: [],
        skills: [],
        plugins: [],
      });
      if (this.model) init.model = this.model;
      if (this.cwd) init.cwd = this.cwd;
      return [init];
    }
    if (type === 'assistant') return this.translateAssistant(raw);
    if (type === 'thinking') return this.translateThinking(raw);
    if (type === 'tool_call') return this.translateToolCall(raw);
    if (type === 'result') return [this.translateResult(raw)];
    return [];
  }

  private translateAssistant(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    const message = isRecord(raw.message) ? raw.message : undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const text = content
      .filter((block): block is Record<string, unknown> & { text: string } =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('');
    if (!text) return [];
    const isDelta = typeof raw.timestamp_ms === 'number' && typeof raw.model_call_id !== 'string';
    if (!isDelta) {
      const useRecap = !this.sawDelta;
      this.sawDelta = false;
      if (!useRecap) return [];
      return [event('assistant', {
        session_id: this.sessionId ?? '',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      })];
    }
    this.sawDelta = true;
    return [event('stream_event', {
      session_id: this.sessionId ?? '',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
    })];
  }

  private translateThinking(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    if (raw.subtype !== 'delta' || typeof raw.text !== 'string' || !raw.text) return [];
    return [event('stream_event', {
      session_id: this.sessionId ?? '',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: raw.text },
      },
    })];
  }

  private translateToolCall(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    const toolCall = isRecord(raw.tool_call) ? raw.tool_call : undefined;
    if (!toolCall) return [];
    const key = Object.keys(toolCall)[0];
    const call = key !== undefined && isRecord(toolCall[key])
      ? toolCall[key] as Record<string, unknown>
      : undefined;
    if (key === undefined || !call) return [];
    const name = cursorToolCallName(key);
    const callId = typeof raw.call_id === 'string' && raw.call_id
      ? raw.call_id
      : typeof raw.toolCallId === 'string' && raw.toolCallId
        ? raw.toolCallId
        : undefined;
    if (raw.subtype === 'started') {
      this.toolCallSeq += 1;
      const id = callId ?? `cursor-tool-${this.toolCallSeq}`;
      this.pendingToolCalls.set(callId ?? name, id);
      return [event('assistant', {
        session_id: this.sessionId ?? '',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id, name, input: isRecord(call.args) ? call.args : {} }],
        },
      })];
    }
    if (raw.subtype === 'completed') {
      const mapKey = callId ?? name;
      const id = this.pendingToolCalls.get(mapKey) ?? `cursor-tool-${this.toolCallSeq}`;
      this.pendingToolCalls.delete(mapKey);
      const result = isRecord(call.result) ? call.result : undefined;
      return [event('user', {
        session_id: this.sessionId ?? '',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: id,
            content: cursorToolResultContent(call),
            is_error: call.error != null || result?.error != null,
          }],
        },
      })];
    }
    return [];
  }

  private translateResult(raw: Record<string, unknown>): HadamardBridgeJsonEvent {
    this.sessionId = typeof raw.session_id === 'string' ? raw.session_id : this.sessionId;
    const isError = raw.is_error === true || raw.subtype !== 'success';
    const result = event('result', {
      subtype: isError ? 'error' : 'success',
      session_id: this.sessionId ?? '',
      is_error: isError,
      result: typeof raw.result === 'string' ? raw.result : '',
      stop_reason: isError ? 'error' : 'end_turn',
      num_turns: 1,
    });
    if (typeof raw.duration_ms === 'number' && Number.isFinite(raw.duration_ms)) {
      result.duration_ms = raw.duration_ms;
    }
    const usage = isRecord(raw.usage) ? raw.usage : undefined;
    if (usage) {
      if (typeof usage.inputTokens === 'number') result.input_tokens = usage.inputTokens;
      if (typeof usage.outputTokens === 'number') result.output_tokens = usage.outputTokens;
      if (typeof usage.cacheReadTokens === 'number') result.cache_read_tokens = usage.cacheReadTokens;
      if (typeof usage.cacheWriteTokens === 'number') result.cache_write_tokens = usage.cacheWriteTokens;
    }
    if (this.model) result.model = this.model;
    return result;
  }
}

function event(type: string, fields: Record<string, unknown>): HadamardBridgeJsonEvent {
  return { type, ...fields } as HadamardBridgeJsonEvent;
}
