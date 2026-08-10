import { createReadStream } from 'node:fs';
import path from 'node:path';

import type {
  ExternalCliSessionCodec,
  ExternalCliSessionFileMetadata,
  ExternalCliSessionParseBounds,
} from './externalCliSessionCodec.js';
import type {
  ExternalCliSession,
  ExternalCliSessionMessage,
  ExternalCliSessionRole,
  ExternalCliSessionSummary,
  ExternalCliToolMetadata,
} from './externalCliSessionTypes.js';

type LegacyExternalCliRuntime = 'claude' | 'codex' | 'pi';

interface ParseState {
  nativeSessionId?: string;
  nativeTitle?: string;
  cwd?: string;
  model?: string;
  earliestTimestamp?: number;
  latestTimestamp?: number;
  messages: ExternalCliSessionMessage[];
  fallbackMessages: ExternalCliSessionMessage[];
  piEntries: PiSessionEntry[];
  piMessageCount: number;
}

interface PiSessionEntry {
  id: string;
  parentId: string | null;
  record: Record<string, unknown>;
}

interface ExtractedContent {
  text: string;
  tools: ExternalCliToolMetadata[];
  toolResultOnly: boolean;
}

export function createLegacyExternalCliSessionCodec(
  runtime: LegacyExternalCliRuntime,
): ExternalCliSessionCodec<LegacyExternalCliRuntime> {
  return {
    runtime,
    parse: (filePath, bounds, fileInfo) => parseLegacyExternalCliSession(
      runtime,
      filePath,
      bounds,
      fileInfo,
    ),
  };
}

async function parseLegacyExternalCliSession(
  runtime: LegacyExternalCliRuntime,
  filePath: string,
  bounds: ExternalCliSessionParseBounds,
  fileInfo: ExternalCliSessionFileMetadata,
): Promise<ExternalCliSession | undefined> {
  const state: ParseState = {
    messages: [],
    fallbackMessages: [],
    piEntries: [],
    piMessageCount: 0,
  };

  let truncated: boolean;
  try {
    truncated = await scanSessionFile(runtime, filePath, fileInfo, state, bounds);
  } catch {
    return undefined;
  }

  if (runtime === 'pi') {
    finalizePiState(state);
  }

  const messages = runtime === 'codex' && !hasConversationMessages(state.messages)
    ? state.fallbackMessages
    : state.messages;
  const nativeSessionId = state.nativeSessionId ?? sessionIdFromFileName(filePath);
  const firstUserText = messages.find(message => message.role === 'user' && message.text)?.text;
  const firstAssistantText = messages.find(
    message => message.role === 'assistant' && message.text,
  )?.text;
  const fallbackCreated = fileInfo.birthtimeMs > 0 ? fileInfo.birthtimeMs : fileInfo.mtimeMs;
  const created = state.earliestTimestamp ?? fallbackCreated;
  const updated = truncated
    ? Math.max(state.latestTimestamp ?? 0, fileInfo.mtimeMs)
    : state.latestTimestamp ?? fileInfo.mtimeMs;

  const summary: ExternalCliSessionSummary = {
    runtime,
    nativeSessionId,
    title: normalizeTitle(state.nativeTitle ?? firstUserText ?? firstAssistantText ?? nativeSessionId),
    cwd: state.cwd,
    createdAt: new Date(created).toISOString(),
    updatedAt: new Date(updated).toISOString(),
    messageCount: messages.length,
    path: filePath,
    ...(truncated ? { truncated: true } : {}),
  };

  return { summary, messages, ...(truncated ? { truncated: true } : {}) };
}

async function scanSessionFile(
  runtime: LegacyExternalCliRuntime,
  filePath: string,
  fileInfo: ExternalCliSessionFileMetadata,
  state: ParseState,
  bounds: ExternalCliSessionParseBounds,
): Promise<boolean> {
  if (fileInfo.size === 0) {
    return false;
  }

  const bytesToRead = Math.min(fileInfo.size, bounds.maxBytes);
  const stream = createReadStream(filePath, {
    encoding: 'utf8',
    start: 0,
    end: bytesToRead - 1,
    highWaterMark: 64 * 1024,
  });
  let pending = '';
  let stoppedForMessageLimit = false;

  try {
    scan: for await (const chunk of stream) {
      pending += chunk;
      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex).replace(/\r$/u, '');
        pending = pending.slice(newlineIndex + 1);
        consumeSessionLine(runtime, line, state);
        if (parsedMessageCount(runtime, state) >= bounds.maxMessages) {
          stoppedForMessageLimit = true;
          break scan;
        }
        newlineIndex = pending.indexOf('\n');
      }
    }

    const stoppedForByteLimit = fileInfo.size > bytesToRead;
    if (!stoppedForByteLimit && !stoppedForMessageLimit && pending.trim()) {
      consumeSessionLine(runtime, pending.replace(/\r$/u, ''), state);
    }
    return stoppedForByteLimit || stoppedForMessageLimit;
  } finally {
    stream.destroy();
  }
}

function consumeSessionLine(
  runtime: LegacyExternalCliRuntime,
  line: string,
  state: ParseState,
): void {
  if (!line.trim()) return;
  try {
    const record = JSON.parse(line) as unknown;
    if (!isRecord(record)) return;
    if (runtime === 'claude') consumeClaudeRecord(record, state);
    else if (runtime === 'codex') consumeCodexRecord(record, state);
    else consumePiRecord(record, state);
  } catch {
    // A CLI can be terminated while appending its final JSONL record.
  }
}

function parsedMessageCount(runtime: LegacyExternalCliRuntime, state: ParseState): number {
  if (runtime === 'pi') return state.piMessageCount;
  return hasConversationMessages(state.messages)
    ? state.messages.length
    : state.fallbackMessages.length;
}

function consumeClaudeRecord(record: Record<string, unknown>, state: ParseState): void {
  const timestamp = rememberTimestamp(state, record.timestamp);
  state.nativeSessionId ??= stringValue(record.sessionId);
  state.cwd ??= stringValue(record.cwd);

  if (record.type === 'summary') {
    state.nativeTitle ??= stringValue(record.summary);
    return;
  }
  if (record.type !== 'user' && record.type !== 'assistant' && record.type !== 'system') return;

  const message = isRecord(record.message) ? record.message : record;
  const role = normalizeRole(message.role) ?? normalizeRole(record.type);
  if (!role) return;
  const content = extractContent(message.content);
  pushMessage(state.messages, {
    role: content.toolResultOnly ? 'tool' : role,
    text: content.text,
    timestamp,
    model: stringValue(message.model),
    tools: content.tools,
  });
}

function consumeCodexRecord(record: Record<string, unknown>, state: ParseState): void {
  const timestamp = rememberTimestamp(state, record.timestamp);
  const payload = isRecord(record.payload) ? record.payload : undefined;
  if (!payload) return;

  if (record.type === 'session_meta') {
    state.nativeSessionId ??= stringValue(payload.id);
    state.cwd ??= stringValue(payload.cwd);
    rememberTimestamp(state, payload.timestamp);
    return;
  }
  if (record.type === 'turn_context') {
    state.cwd ??= stringValue(payload.cwd);
    state.model = stringValue(payload.model) ?? state.model;
    return;
  }
  if (record.type === 'response_item') {
    consumeCodexResponseItem(payload, state, timestamp);
    return;
  }
  if (record.type === 'event_msg') consumeCodexEventMessage(payload, state, timestamp);
}

function consumeCodexResponseItem(
  payload: Record<string, unknown>,
  state: ParseState,
  timestamp?: string,
): void {
  if (payload.type === 'message') {
    const role = normalizeRole(payload.role);
    if (!role) return;
    const content = extractContent(payload.content);
    pushMessage(state.messages, {
      role: content.toolResultOnly ? 'tool' : role,
      text: content.text,
      timestamp,
      model: stringValue(payload.model) ?? state.model,
      tools: content.tools,
    });
    return;
  }

  const tool = codexToolMetadata(payload);
  if (!tool) return;
  pushMessage(state.messages, {
    role: tool.kind === 'result' ? 'tool' : 'assistant',
    text: tool.output ?? '',
    timestamp,
    model: state.model,
    tools: [tool],
  });
}

function consumeCodexEventMessage(
  payload: Record<string, unknown>,
  state: ParseState,
  timestamp?: string,
): void {
  const role = payload.type === 'user_message'
    ? 'user'
    : payload.type === 'agent_message' ? 'assistant' : undefined;
  if (!role) return;
  pushMessage(state.fallbackMessages, {
    role,
    text: visibleText(payload.message),
    timestamp,
    model: stringValue(payload.model) ?? state.model,
  });
}

function consumePiRecord(record: Record<string, unknown>, state: ParseState): void {
  rememberTimestamp(state, record.timestamp);
  if (record.type === 'session') {
    state.nativeSessionId ??= stringValue(record.id);
    state.cwd ??= stringValue(record.cwd);
    return;
  }

  const id = stringValue(record.id);
  const parentId = record.parentId === null ? null : stringValue(record.parentId);
  if (!id || parentId === undefined) return;
  state.piEntries.push({ id, parentId, record });
  if (record.type === 'message' && isRecord(record.message)) {
    const role = record.message.role;
    if (role === 'user' || role === 'assistant' || role === 'toolResult') {
      state.piMessageCount += 1;
    }
  }
}

function finalizePiState(state: ParseState): void {
  state.messages = [];
  state.nativeTitle = undefined;
  state.model = undefined;

  const entriesById = new Map(state.piEntries.map(entry => [entry.id, entry]));
  const branch: PiSessionEntry[] = [];
  const visited = new Set<string>();
  let entry = state.piEntries.at(-1);
  while (entry && !visited.has(entry.id)) {
    visited.add(entry.id);
    branch.push(entry);
    entry = entry.parentId === null ? undefined : entriesById.get(entry.parentId);
  }

  branch.reverse();
  for (const branchEntry of branch) {
    const record = branchEntry.record;
    if (record.type === 'session_info') {
      state.nativeTitle = stringValue(record.name) ?? state.nativeTitle;
    } else if (record.type === 'model_change') {
      state.model = stringValue(record.modelId) ?? state.model;
    } else if (record.type === 'message' && isRecord(record.message)) {
      consumePiMessage(record.message, state, normalizeTimestamp(record.timestamp));
    }
  }
}

function consumePiMessage(
  message: Record<string, unknown>,
  state: ParseState,
  timestamp?: string,
): void {
  const content = extractContent(message.content);
  if (message.role === 'user' || message.role === 'assistant') {
    pushMessage(state.messages, {
      role: message.role,
      text: content.text,
      timestamp,
      model: stringValue(message.model) ?? state.model,
      tools: content.tools,
    });
    return;
  }
  if (message.role === 'toolResult') {
    pushMessage(state.messages, {
      role: 'tool',
      text: content.text,
      timestamp,
      model: state.model,
      tools: [{
        kind: 'result',
        id: stringValue(message.toolCallId ?? message.tool_call_id),
        name: stringValue(message.toolName ?? message.tool_name),
        output: content.text,
        isError: booleanValue(message.isError ?? message.is_error),
      }],
    });
  }
}

function codexToolMetadata(payload: Record<string, unknown>): ExternalCliToolMetadata | undefined {
  const type = stringValue(payload.type);
  if (!type) return undefined;
  if (type.endsWith('_output') || type.endsWith('_result')) {
    return {
      kind: 'result',
      id: stringValue(payload.call_id ?? payload.id),
      output: visibleText(payload.output ?? payload.result),
      isError: booleanValue(payload.is_error ?? payload.isError),
    };
  }
  if (type.endsWith('_call') || type === 'local_shell_call') {
    return {
      kind: 'call',
      id: stringValue(payload.call_id ?? payload.id),
      name: stringValue(payload.name) ?? type.replace(/_call$/u, ''),
      input: payload.arguments ?? payload.input ?? payload.command,
    };
  }
  return undefined;
}

function extractContent(content: unknown): ExtractedContent {
  if (typeof content === 'string') return { text: content.trim(), tools: [], toolResultOnly: false };
  if (!Array.isArray(content)) return { text: '', tools: [], toolResultOnly: false };

  const textParts: string[] = [];
  const tools: ExternalCliToolMetadata[] = [];
  let hasPlainText = false;
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = stringValue(block.type);
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = stringValue(block.text);
      if (text) {
        textParts.push(text);
        hasPlainText = true;
      }
    } else if (
      type === 'tool_use' || type === 'function_call' ||
      type === 'custom_tool_call' || type === 'toolCall'
    ) {
      tools.push({
        kind: 'call',
        id: stringValue(block.id ?? block.call_id),
        name: stringValue(block.name),
        input: block.input ?? block.arguments,
      });
    } else if (type === 'tool_result' || type === 'function_call_output') {
      const output = visibleText(block.content ?? block.output);
      tools.push({
        kind: 'result',
        id: stringValue(block.tool_use_id ?? block.call_id ?? block.id),
        output,
        isError: booleanValue(block.is_error ?? block.isError),
      });
      if (output) textParts.push(output);
    }
  }
  return {
    text: textParts.join('\n').trim(),
    tools,
    toolResultOnly: tools.some(tool => tool.kind === 'result') && !hasPlainText,
  };
}

function visibleText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(visibleText).filter(Boolean).join('\n').trim();
  if (!isRecord(value)) return '';
  if (
    (value.type === 'text' || value.type === 'input_text' || value.type === 'output_text') &&
    typeof value.text === 'string'
  ) return value.text.trim();
  return visibleText(value.content);
}

function pushMessage(
  messages: ExternalCliSessionMessage[],
  message: ExternalCliSessionMessage,
): void {
  const tools = message.tools?.filter(Boolean);
  if (!message.text && !tools?.length) return;
  messages.push({ ...message, ...(tools?.length ? { tools } : { tools: undefined }) });
}

function hasConversationMessages(messages: ExternalCliSessionMessage[]): boolean {
  return messages.some(message =>
    Boolean(message.text) && (message.role === 'user' || message.role === 'assistant')
  );
}

function rememberTimestamp(state: ParseState, value: unknown): string | undefined {
  const timestamp = normalizeTimestamp(value);
  if (timestamp) {
    const milliseconds = Date.parse(timestamp);
    state.earliestTimestamp = state.earliestTimestamp == null
      ? milliseconds : Math.min(state.earliestTimestamp, milliseconds);
    state.latestTimestamp = state.latestTimestamp == null
      ? milliseconds : Math.max(state.latestTimestamp, milliseconds);
  }
  return timestamp;
}

function normalizeTimestamp(value: unknown): string | undefined {
  let milliseconds: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === 'string' && value.trim()) {
    milliseconds = Date.parse(value);
  } else return undefined;
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function normalizeTitle(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function sessionIdFromFileName(filePath: string): string {
  const fileName = path.basename(filePath, path.extname(filePath));
  return fileName.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu)?.[1] ?? fileName;
}

function normalizeRole(value: unknown): ExternalCliSessionRole | undefined {
  if (value === 'user' || value === 'assistant' || value === 'system' || value === 'tool') {
    return value;
  }
  return value === 'developer' ? 'system' : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
