import { createReadStream } from 'node:fs';
import path from 'node:path';

import type {
  ExternalCliSessionCodec,
  ExternalCliSessionFileMetadata,
  ExternalCliSessionParseBounds as ParseBounds,
} from './externalCliSessionCodec.js';
import type {
  ExternalCliSession,
  ExternalCliSessionMessage,
  ExternalCliSessionRole,
  ExternalCliSessionSummary,
  ExternalCliToolMetadata,
} from './externalCliSessionTypes.js';

interface ExtractedContent {
  text: string;
  tools: ExternalCliToolMetadata[];
  toolResultOnly: boolean;
}

interface CodewhaleSavedSessionPrefix {
  source: string;
  savedSession?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  bytesToRead: number;
}

export const codewhaleExternalCliSessionCodec: ExternalCliSessionCodec<'codewhale'> = {
  runtime: 'codewhale',
  parse: parseCodewhaleSessionFile,
};

export async function readCodewhaleSessionMetadata(
  filePath: string,
  fileInfo: ExternalCliSessionFileMetadata,
  maxBytes: number,
): Promise<Record<string, unknown> | undefined> {
  return (await readCodewhaleSavedSessionPrefix(filePath, fileInfo, maxBytes))?.metadata;
}

async function parseCodewhaleSessionFile(
  filePath: string,
  bounds: ParseBounds,
  fileInfo: ExternalCliSessionFileMetadata,
): Promise<ExternalCliSession | undefined> {
  const savedSessionPrefix = await readCodewhaleSavedSessionPrefix(
    filePath,
    fileInfo,
    bounds.maxBytes,
  );
  if (!savedSessionPrefix) {
    return undefined;
  }
  const { bytesToRead, metadata, savedSession, source } = savedSessionPrefix;

  const rawMessages = savedSession && Array.isArray(savedSession.messages)
    ? savedSession.messages.slice(0, bounds.maxMessages + 1)
    : extractCodewhaleMessages(source, bounds.maxMessages + 1);
  const stoppedForMessageLimit = rawMessages.length > bounds.maxMessages;
  const messages: ExternalCliSessionMessage[] = [];
  const model = stringValue(metadata.model);
  for (const rawMessage of rawMessages.slice(0, bounds.maxMessages)) {
    if (isRecord(rawMessage)) {
      consumeCodewhaleMessage(rawMessage, model, messages);
    }
  }

  const nativeSessionId = stringValue(metadata.id) ?? sessionIdFromFileName(filePath);
  const firstUserText = messages.find(message => message.role === 'user' && message.text)?.text;
  const firstAssistantText = messages.find(
    message => message.role === 'assistant' && message.text,
  )?.text;
  const fallbackCreated = fileInfo.birthtimeMs > 0 ? fileInfo.birthtimeMs : fileInfo.mtimeMs;
  const createdAt = normalizeTimestamp(metadata.created_at)
    ?? new Date(fallbackCreated).toISOString();
  const updatedAt = normalizeTimestamp(metadata.updated_at)
    ?? new Date(fileInfo.mtimeMs).toISOString();
  const truncated = fileInfo.size > bytesToRead || stoppedForMessageLimit;
  const summary: ExternalCliSessionSummary = {
    runtime: 'codewhale',
    nativeSessionId,
    title: normalizeTitle(
      stringValue(metadata.title) ?? firstUserText ?? firstAssistantText ?? nativeSessionId,
    ),
    cwd: stringValue(metadata.workspace),
    createdAt,
    updatedAt,
    messageCount: nonNegativeIntegerValue(metadata.message_count) ?? messages.length,
    path: filePath,
    ...(truncated ? { truncated: true } : {}),
  };
  return { summary, messages, ...(truncated ? { truncated: true } : {}) };
}

async function readCodewhaleSavedSessionPrefix(
  filePath: string,
  fileInfo: ExternalCliSessionFileMetadata,
  maxBytes: number,
): Promise<CodewhaleSavedSessionPrefix | undefined> {
  if (fileInfo.size === 0) {
    return undefined;
  }

  const bytesToRead = Math.min(fileInfo.size, maxBytes);
  let source: string;
  try {
    source = await readBoundedUtf8File(filePath, bytesToRead);
  } catch {
    return undefined;
  }

  let savedSession: Record<string, unknown> | undefined;
  if (fileInfo.size <= bytesToRead) {
    try {
      const parsed = JSON.parse(source) as unknown;
      if (!isRecord(parsed)) {
        return undefined;
      }
      savedSession = parsed;
    } catch {
      return undefined;
    }
  }

  const metadata = savedSession && isRecord(savedSession.metadata)
    ? savedSession.metadata
    : extractCodewhaleMetadata(source);
  return metadata ? { source, savedSession, metadata, bytesToRead } : undefined;
}

async function readBoundedUtf8File(filePath: string, maxBytes: number): Promise<string> {
  const stream = createReadStream(filePath, {
    encoding: 'utf8',
    start: 0,
    end: maxBytes - 1,
    highWaterMark: 64 * 1024,
  });
  let source = '';
  try {
    for await (const chunk of stream) {
      source += chunk;
    }
    return source;
  } finally {
    stream.destroy();
  }
}

function extractCodewhaleMetadata(source: string): Record<string, unknown> | undefined {
  const valueStart = findTopLevelJsonPropertyValueStart(source, 'metadata');
  if (valueStart == null || source[valueStart] !== '{') {
    return undefined;
  }
  const valueEnd = findJsonCompositeEnd(source, valueStart);
  if (valueEnd == null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(source.slice(valueStart, valueEnd)) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractCodewhaleMessages(source: string, limit: number): unknown[] {
  const arrayStart = findTopLevelJsonPropertyValueStart(source, 'messages');
  if (arrayStart == null || source[arrayStart] !== '[') {
    return [];
  }

  const messages: unknown[] = [];
  let cursor = arrayStart + 1;
  while (messages.length < limit) {
    while (cursor < source.length && /[\s,]/u.test(source[cursor]!)) {
      cursor += 1;
    }
    if (source[cursor] === ']' || source[cursor] !== '{') {
      break;
    }
    const valueEnd = findJsonCompositeEnd(source, cursor);
    if (valueEnd == null) {
      break;
    }
    try {
      messages.push(JSON.parse(source.slice(cursor, valueEnd)) as unknown);
    } catch {
      break;
    }
    cursor = valueEnd;
  }
  return messages;
}

function findTopLevelJsonPropertyValueStart(
  source: string,
  propertyName: string,
): number | undefined {
  let depth = 0;
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '"') {
      const stringEnd = findJsonStringEnd(source, cursor);
      if (stringEnd == null) {
        return undefined;
      }
      if (depth === 1) {
        let separator = stringEnd + 1;
        while (separator < source.length && /\s/u.test(source[separator]!)) {
          separator += 1;
        }
        if (source[separator] === ':') {
          try {
            const key = JSON.parse(source.slice(cursor, stringEnd + 1)) as unknown;
            if (key === propertyName) {
              separator += 1;
              while (separator < source.length && /\s/u.test(source[separator]!)) {
                separator += 1;
              }
              return separator;
            }
          } catch {
            return undefined;
          }
        }
      }
      cursor = stringEnd + 1;
      continue;
    }
    if (character === '{' || character === '[') {
      depth += 1;
    } else if (character === '}' || character === ']') {
      depth -= 1;
    }
    cursor += 1;
  }
  return undefined;
}

function findJsonCompositeEnd(source: string, start: number): number | undefined {
  const opening = source[start];
  if (opening !== '{' && opening !== '[') {
    return undefined;
  }
  const stack: string[] = [opening];
  let cursor = start + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '"') {
      const stringEnd = findJsonStringEnd(source, cursor);
      if (stringEnd == null) {
        return undefined;
      }
      cursor = stringEnd + 1;
      continue;
    }
    if (character === '{' || character === '[') {
      stack.push(character);
    } else if (character === '}' || character === ']') {
      const expectedOpening = character === '}' ? '{' : '[';
      if (stack.pop() !== expectedOpening) {
        return undefined;
      }
      if (stack.length === 0) {
        return cursor + 1;
      }
    }
    cursor += 1;
  }
  return undefined;
}

function findJsonStringEnd(source: string, start: number): number | undefined {
  let cursor = start + 1;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === '"') {
      return cursor;
    }
    cursor += 1;
  }
  return undefined;
}

function consumeCodewhaleMessage(
  message: Record<string, unknown>,
  model: string | undefined,
  messages: ExternalCliSessionMessage[],
): void {
  const role = normalizeRole(message.role);
  if (!role) {
    return;
  }
  const content = extractCodewhaleContent(message.content);
  pushMessage(messages, {
    role: content.toolResultOnly ? 'tool' : role,
    text: content.text,
    model,
    tools: content.tools,
  });
}

function extractCodewhaleContent(content: unknown): ExtractedContent {
  if (typeof content === 'string') {
    return { text: content.trim(), tools: [], toolResultOnly: false };
  }
  if (!Array.isArray(content)) {
    return { text: '', tools: [], toolResultOnly: false };
  }

  const textParts: string[] = [];
  const tools: ExternalCliToolMetadata[] = [];
  let hasPlainText = false;
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    const type = stringValue(block.type);
    if (type === 'text' || type === 'thinking') {
      const text = stringValue(type === 'thinking' ? block.thinking : block.text);
      if (text) {
        textParts.push(text);
        hasPlainText = true;
      }
      continue;
    }
    if (type === 'tool_use' || type === 'server_tool_use') {
      tools.push({
        kind: 'call',
        id: stringValue(block.id),
        name: stringValue(block.name),
        input: block.input,
      });
      continue;
    }
    if (type === 'tool_result') {
      const output = visibleText(block.content) || visibleText(block.content_blocks);
      tools.push({
        kind: 'result',
        id: stringValue(block.tool_use_id),
        output,
        isError: booleanValue(block.is_error),
      });
      if (output) {
        textParts.push(output);
      }
    }
  }

  return {
    text: textParts.join('\n').trim(),
    tools,
    toolResultOnly: tools.some(tool => tool.kind === 'result') && !hasPlainText,
  };
}

function nonNegativeIntegerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function visibleText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(visibleText).filter(Boolean).join('\n').trim();
  }
  if (!isRecord(value)) {
    return '';
  }
  if (
    (value.type === 'text' || value.type === 'input_text' || value.type === 'output_text') &&
    typeof value.text === 'string'
  ) {
    return value.text.trim();
  }
  return visibleText(value.content);
}

function pushMessage(
  messages: ExternalCliSessionMessage[],
  message: ExternalCliSessionMessage,
): void {
  const tools = message.tools?.filter(Boolean);
  if (!message.text && !tools?.length) {
    return;
  }
  messages.push({
    ...message,
    ...(tools?.length ? { tools } : { tools: undefined }),
  });
}

function normalizeTimestamp(value: unknown): string | undefined {
  let milliseconds: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === 'string' && value.trim()) {
    milliseconds = Date.parse(value);
  } else {
    return undefined;
  }
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

