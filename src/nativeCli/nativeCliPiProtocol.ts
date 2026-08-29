import { HadamardBridgeProcessError } from '../errors.js';
import { isRecord } from '../runtime/helpers.js';
import type {
  HadamardBridgeJsonEvent,
  HadamardBridgeRunOptions,
} from '../types.js';

export interface PiProcessControl {
  write(record: Record<string, unknown>): void;
  endInput(): void;
}

export interface PiCliNormalizer {
  readonly interactive: true;
  readonly abortGraceMs: number;
  start(control: PiProcessControl): void;
  abort(control: PiProcessControl): void;
  translate(raw: Record<string, unknown>, control?: PiProcessControl): HadamardBridgeJsonEvent[];
}

export function buildPiArgs(_prompt: string, options: HadamardBridgeRunOptions): string[] {
  const args = ['--mode', 'rpc'];
  args.push(options.trustProjectResources ? '--approve' : '--no-approve');
  const model = splitPiModel(options.model);
  const provider = model.provider ?? normalizePiProvider(options.credentialProvider);
  if (provider) args.push('--provider', provider);
  if (model.model) args.push('--model', model.model);
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
  else if (options.systemPrompt) args.push('--system-prompt', options.systemPrompt);
  if (options.effort) args.push('--thinking', options.effort);
  args.push(...piToolArguments(options));

  if (typeof options.resume === 'string') args.push('--session', validatePiSessionId(options.resume));
  else if (options.resume === true) {
    throw new HadamardBridgeProcessError(
      'Pi managed mode requires an exact session id; the interactive --resume picker is unavailable.',
    );
  } else if (options.sessionId) args.push('--session-id', validatePiSessionId(options.sessionId));
  else if (options.continueMostRecent) args.push('--continue');
  return args;
}

export function createPiNormalizer(
  prompt: string,
  options: HadamardBridgeRunOptions,
): PiCliNormalizer {
  return new PiNormalizer(prompt, options);
}

const PI_READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;
const PI_EDIT_TOOLS = [...PI_READ_ONLY_TOOLS, 'edit', 'write'] as const;

function validatePiSessionId(value: string): string {
  const sessionId = value.trim();
  if (!sessionId || sessionId.length > 256 || sessionId.startsWith('-')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(sessionId)) {
    throw new HadamardBridgeProcessError(
      'Pi session id must contain only letters, numbers, dots, underscores, or hyphens.',
    );
  }
  return sessionId;
}

function splitPiModel(value: string | undefined): { provider?: string; model?: string } {
  const normalized = value?.trim();
  if (!normalized) return {};
  const separator = normalized.indexOf('/');
  if (separator <= 0 || separator === normalized.length - 1) return { model: normalized };
  return { provider: normalized.slice(0, separator), model: normalized.slice(separator + 1) };
}

function normalizePiProvider(value: string | undefined): string | undefined {
  const provider = value?.trim();
  if (!provider) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(provider)) {
    throw new HadamardBridgeProcessError(
      'Pi credential provider must contain only letters, numbers, dots, underscores, or hyphens.',
    );
  }
  return provider;
}

function piToolArguments(options: HadamardBridgeRunOptions): string[] {
  if (options.tools === 'none') return ['--no-tools'];
  const bypass = options.dangerouslySkipPermissions || options.permissionMode === 'bypassPermissions';
  const permissionUpperBound = bypass ? undefined : new Set<string>(
    options.permissionMode === 'acceptEdits' ? PI_EDIT_TOOLS : PI_READ_ONLY_TOOLS,
  );
  let permitted: string[] | undefined;
  if (Array.isArray(options.tools)) permitted = [...options.tools];
  else if (!bypass) permitted = options.permissionMode === 'acceptEdits'
    ? [...PI_EDIT_TOOLS]
    : [...PI_READ_ONLY_TOOLS];
  if (options.allowedTools?.length) {
    permitted = permitted
      ? permitted.filter(tool => options.allowedTools!.includes(tool))
      : [...options.allowedTools];
  }
  if (options.disallowedTools?.length && permitted) {
    permitted = permitted.filter(tool => !options.disallowedTools!.includes(tool));
  }
  if (permissionUpperBound && permitted) {
    permitted = permitted.filter(tool => permissionUpperBound.has(tool));
  }
  const args: string[] = [];
  if (permitted) {
    if (permitted.length === 0) return ['--no-tools'];
    args.push('--tools', [...new Set(permitted)].join(','));
  }
  if (options.disallowedTools?.length) {
    args.push('--exclude-tools', [...new Set(options.disallowedTools)].join(','));
  }
  return args;
}

class PiNormalizer implements PiCliNormalizer {
  readonly interactive = true as const;
  readonly abortGraceMs = 250;
  private sessionId: string | undefined;
  private cwd: string | undefined;
  private model: string | undefined;
  private initEmitted = false;
  private finalAssistantText = '';
  private streamedAssistantText = '';
  private lastError: string | undefined;
  private stopReason: string | undefined;
  private turns = 0;
  private finished = false;
  private totalCostUsd: number | undefined;

  constructor(
    private readonly prompt: string,
    private readonly options: HadamardBridgeRunOptions,
  ) {}

  start(control: PiProcessControl): void {
    control.write({ id: 'hadamard-state', type: 'get_state' });
    control.write({ id: 'hadamard-prompt', type: 'prompt', message: this.prompt });
  }

  abort(control: PiProcessControl): void {
    control.write({ id: 'hadamard-abort', type: 'abort' });
  }

  translate(raw: Record<string, unknown>, control?: PiProcessControl): HadamardBridgeJsonEvent[] {
    const type = typeof raw.type === 'string' ? raw.type : '';
    if (type === 'response' && raw.id === 'hadamard-state') {
      const state = piRpcPayload(raw);
      this.sessionId = stringField(state, 'sessionId', 'session_id', 'id') ?? this.sessionId;
      this.cwd = stringField(state, 'cwd') ?? this.cwd;
      this.model = stringField(state, 'model') ?? this.model;
      return this.emitInit();
    }
    if (type === 'response' && raw.id === 'hadamard-prompt' && raw.success === false) {
      this.lastError = rpcErrorMessage(raw) ?? 'Pi rejected the prompt request.';
      return this.finish(control, true);
    }
    if (type === 'session') {
      this.sessionId = typeof raw.id === 'string' ? raw.id : this.sessionId;
      this.cwd = typeof raw.cwd === 'string' ? raw.cwd : this.cwd;
      return [];
    }
    if (type === 'agent_start') return this.emitInit();
    if (type === 'message_update') return this.translateMessageUpdate(raw);
    if (type === 'tool_execution_start') return [event('assistant', {
      session_id: this.sessionId ?? '',
      message: { role: 'assistant', content: [{
        type: 'tool_use',
        id: stringField(raw, 'toolCallId', 'tool_call_id') ?? 'pi-tool-unknown',
        name: stringField(raw, 'toolName', 'tool_name') ?? 'tool',
        input: isRecord(raw.args) ? raw.args : {},
      }] },
    })];
    if (type === 'tool_execution_update') return [event('stream_event', {
      session_id: this.sessionId ?? '',
      event: {
        type: 'tool_progress',
        tool_call_id: stringField(raw, 'toolCallId', 'tool_call_id'),
        tool_name: stringField(raw, 'toolName', 'tool_name'),
        content: piResultText(raw.partialResult),
        cumulative: true,
      },
    })];
    if (type === 'tool_execution_end') return [event('user', {
      session_id: this.sessionId ?? '',
      message: { role: 'user', content: [{
        type: 'tool_result',
        tool_use_id: stringField(raw, 'toolCallId', 'tool_call_id') ?? 'pi-tool-unknown',
        content: piResultText(raw.result),
        is_error: raw.isError === true,
      }] },
    })];
    if (type === 'message_end') return this.translateMessageEnd(raw);
    if (type === 'turn_end') {
      this.turns += 1;
      return [];
    }
    if (type === 'auto_retry_start' || type === 'auto_retry_end'
      || type === 'compaction_start' || type === 'compaction_end'
      || type === 'queue_update' || type === 'extension_error') {
      return [event('system', { ...raw, subtype: type, session_id: this.sessionId ?? '' })];
    }
    if (type === 'agent_end' || type === 'agent_settled') return this.finish(control, false);
    return [];
  }

  private translateMessageUpdate(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    const update = raw.assistantMessageEvent;
    if (isRecord(update) && update.type === 'text_delta' && typeof update.delta === 'string') {
      this.streamedAssistantText += update.delta;
      return [event('stream_event', {
        session_id: this.sessionId ?? '',
        event: { type: 'content_block_delta', index: numberField(update.contentIndex) ?? 0,
          delta: { type: 'text_delta', text: update.delta } },
      })];
    }
    if (isRecord(update) && update.type === 'thinking_delta' && typeof update.delta === 'string') {
      return [event('stream_event', {
        session_id: this.sessionId ?? '',
        event: { type: 'content_block_delta', index: numberField(update.contentIndex) ?? 0,
          delta: { type: 'thinking_delta', thinking: update.delta } },
      })];
    }
    if (isRecord(update) && update.type === 'error') {
      this.lastError = stringField(update, 'error', 'message') ?? 'Pi assistant stream failed.';
    }
    return [];
  }

  private translateMessageEnd(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    const message = raw.message;
    if (!isRecord(message) || message.role !== 'assistant') return [];
    this.model = stringField(message, 'model') ?? this.model;
    const text = extractPiAssistantText(message);
    if (text) this.finalAssistantText = text;
    this.stopReason = stringField(message, 'stopReason', 'stop_reason') ?? this.stopReason;
    this.lastError = stringField(message, 'errorMessage', 'error_message') ?? this.lastError;
    const usage = isRecord(message.usage) ? message.usage : undefined;
    const cost = usage && typeof usage.cost === 'number'
      ? usage.cost
      : usage && isRecord(usage.cost) && typeof usage.cost.total === 'number'
        ? usage.cost.total
        : undefined;
    if (cost != null) this.totalCostUsd = (this.totalCostUsd ?? 0) + cost;
    return [event('assistant', {
      session_id: this.sessionId ?? '',
      message: { role: 'assistant', content: extractPiAssistantContent(message), model: this.model, usage },
    })];
  }

  private emitInit(): HadamardBridgeJsonEvent[] {
    if (this.initEmitted) return [];
    this.initEmitted = true;
    return [event('system', {
      subtype: 'init',
      session_id: this.sessionId ?? (this.options.sessionId ?? ''),
      cwd: this.cwd,
      tools: [], mcp_servers: [], slash_commands: [], agents: [], skills: [], plugins: [],
      model: this.model ?? this.options.model,
      permission_mode: this.options.permissionMode ?? 'default',
    })];
  }

  private finish(control: PiProcessControl | undefined, forcedError: boolean): HadamardBridgeJsonEvent[] {
    if (this.finished) return [];
    this.finished = true;
    control?.endInput();
    const isError = forcedError || Boolean(this.lastError) || this.stopReason === 'error';
    return [...this.emitInit(), event('result', {
      subtype: isError ? 'error' : 'success',
      session_id: this.sessionId ?? (this.options.sessionId ?? ''),
      is_error: isError,
      result: this.lastError || this.finalAssistantText || this.streamedAssistantText,
      stop_reason: isError ? 'error' : (this.stopReason ?? 'end_turn'),
      num_turns: Math.max(1, this.turns),
      total_cost_usd: this.totalCostUsd,
    })];
  }
}

function piRpcPayload(raw: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(raw.data)) return raw.data;
  if (isRecord(raw.result)) return raw.result;
  return raw;
}

function rpcErrorMessage(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.error === 'string') return raw.error;
  if (isRecord(raw.error)) return stringField(raw.error, 'message', 'error');
  return stringField(raw, 'message');
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === 'string' && value[key]) return value[key] as string;
  return undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function piResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return value == null ? '' : (JSON.stringify(value) ?? '');
  if (Array.isArray(value.content)) return value.content.map(block => {
    if (typeof block === 'string') return block;
    if (isRecord(block) && typeof block.text === 'string') return block.text;
    return isRecord(block) ? (JSON.stringify(block) ?? '') : '';
  }).join('\n');
  return JSON.stringify(value, null, 2) ?? '';
}

function extractPiAssistantText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return typeof message.content === 'string' ? message.content : '';
  return message.content.map(block => isRecord(block) && block.type === 'text'
    && typeof block.text === 'string' ? block.text : '').join('');
}

function extractPiAssistantContent(message: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!Array.isArray(message.content)) {
    const text = typeof message.content === 'string' ? message.content : '';
    return text ? [{ type: 'text', text }] : [];
  }
  const content: Array<Record<string, unknown>> = [];
  for (const block of message.content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text });
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      content.push({ type: 'thinking', thinking: block.thinking });
    }
  }
  return content;
}

function event(type: string, fields: Record<string, unknown>): HadamardBridgeJsonEvent {
  return { type, ...fields } as HadamardBridgeJsonEvent;
}
