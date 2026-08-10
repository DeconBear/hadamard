import { createReadStream, realpath as realpathCallback } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

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
} from './externalCliSessionTypes.js';
import {
  parseReasonixSessionJsonl,
  type ReasonixSessionMessage,
} from './reasonixSessionParser.js';

const MAX_REASONIX_METADATA_BYTES = 256 * 1024;
const realpathNative = promisify(realpathCallback.native);

export const reasonixExternalCliSessionCodec: ExternalCliSessionCodec<'reasonix'> = {
  runtime: 'reasonix',
  parse: parseReasonixSessionFile,
};

async function parseReasonixSessionFile(
  filePath: string,
  bounds: ExternalCliSessionParseBounds,
  fileInfo: ExternalCliSessionFileMetadata,
): Promise<ExternalCliSession | undefined> {
  const metadata = await readReasonixMetadataSidecar(filePath);
  if (fileInfo.size === 0 && !metadata) return undefined;

  const bytesToRead = Math.min(fileInfo.size, bounds.maxBytes);
  let source = '';
  if (bytesToRead > 0) {
    try {
      source = await readBoundedUtf8File(filePath, bytesToRead);
    } catch {
      return undefined;
    }
  }

  const parsed = parseReasonixSessionJsonl(source, {
    filePath,
    metadata,
    fileCreatedAt: fileInfo.birthtimeMs > 0 ? fileInfo.birthtimeMs : fileInfo.mtimeMs,
    fileUpdatedAt: fileInfo.mtimeMs,
    maxRecords: bounds.maxMessages * 2,
    maxMessages: bounds.maxMessages,
    maxRecordChars: bounds.maxBytes,
    maxTextChars: bounds.maxBytes,
    maxToolPayloadChars: Math.min(bounds.maxBytes, 64 * 1024),
  });
  if (parsed.messageCount === 0 && !metadata) return undefined;

  const messages = parsed.messages.map(normalizeReasonixMessage);
  const nativeSessionId = parsed.nativeSessionId ?? sessionIdFromFileName(filePath);
  const fallbackCreated = fileInfo.birthtimeMs > 0 ? fileInfo.birthtimeMs : fileInfo.mtimeMs;
  const truncated = fileInfo.size > bytesToRead || parsed.truncated;
  const parsedUpdatedAt = parsed.updatedAt ? Date.parse(parsed.updatedAt) : Number.NaN;
  const updatedAt = truncated
    ? new Date(Math.max(
        Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : 0,
        fileInfo.mtimeMs,
      )).toISOString()
    : parsed.updatedAt ?? new Date(fileInfo.mtimeMs).toISOString();
  const summary: ExternalCliSessionSummary = {
    runtime: 'reasonix',
    nativeSessionId,
    title: normalizeTitle(parsed.title ?? nativeSessionId),
    cwd: parsed.cwd,
    createdAt: parsed.createdAt ?? new Date(fallbackCreated).toISOString(),
    updatedAt,
    messageCount: parsed.messageCount,
    path: filePath,
    ...(truncated ? { truncated: true } : {}),
  };
  return { summary, messages, ...(truncated ? { truncated: true } : {}) };
}

async function readReasonixMetadataSidecar(
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  const extension = path.extname(filePath);
  const stem = extension ? filePath.slice(0, -extension.length) : filePath;
  const parent = path.dirname(filePath);
  for (const sidecarPath of [`${stem}.acp.json`, `${stem}.meta.json`]) {
    const canonicalPath = await resolveRegularFile(sidecarPath);
    if (!canonicalPath) continue;
    const relative = path.relative(parent, canonicalPath);
    if (!relative || path.dirname(relative) !== '.' || path.isAbsolute(relative)) continue;

    let sidecarInfo: ExternalCliSessionFileMetadata;
    try {
      sidecarInfo = await stat(canonicalPath);
    } catch {
      continue;
    }
    if (sidecarInfo.size === 0 || sidecarInfo.size > MAX_REASONIX_METADATA_BYTES) continue;

    try {
      const parsed = JSON.parse(
        await readBoundedUtf8File(canonicalPath, sidecarInfo.size),
      ) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // A corrupt current sidecar may still have a usable legacy fallback.
    }
  }
  return undefined;
}

async function resolveRegularFile(filePath: string): Promise<string | undefined> {
  try {
    const requestedInfo = await lstat(filePath);
    if (requestedInfo.isSymbolicLink() || !requestedInfo.isFile()) return undefined;
    const canonicalPath = await realpathNative(filePath);
    const canonicalInfo = await lstat(canonicalPath);
    return !canonicalInfo.isSymbolicLink() && canonicalInfo.isFile() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
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
    for await (const chunk of stream) source += chunk;
    return source;
  } finally {
    stream.destroy();
  }
}

function normalizeReasonixMessage(
  message: ReasonixSessionMessage,
): ExternalCliSessionMessage {
  const role: ExternalCliSessionRole = message.role === 'think' ? 'assistant' : message.role;
  return {
    role,
    text: message.text,
    ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    ...(message.model ? { model: message.model } : {}),
    ...(message.tools?.length ? { tools: message.tools.map(tool => ({ ...tool })) } : {}),
  };
}

function normalizeTitle(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function sessionIdFromFileName(filePath: string): string {
  const fileName = path.basename(filePath, path.extname(filePath));
  return fileName.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu)?.[1] ?? fileName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
