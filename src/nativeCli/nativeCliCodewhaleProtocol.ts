import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { HadamardBridgeProcessError } from '../errors.js';
import { isRecord } from '../runtime/helpers.js';
import type {
  HadamardBridgeJsonEvent,
  HadamardBridgeRunOptions,
  HadamardBridgeToolsOption,
} from '../types.js';

export const CODEWHALE_READ_ONLY_TOOLS = [
  'file_search', 'git_diff', 'git_status', 'grep_files', 'list_dir', 'read_file',
] as const;

const READ_ONLY_TOOL_SET = new Set<string>(CODEWHALE_READ_ONLY_TOOLS);
const CORRELATION_HINT = /^<redacted:[0-9a-f]{16}>$/u;
const FAILED_STATUSES = new Set(['canceled', 'cancelled', 'error', 'failed', 'interrupted']);
const SESSION_FILE = /^[A-Za-z0-9_-]+\.json$/u;
const SESSION_PREFIX_BYTES = 128 * 1024;
const CLOCK_SKEW_MS = 5_000;
const FINGERPRINT_OFFSET = 0xcbf2_9ce4_8422_2325n;
const FINGERPRINT_PRIME = 0x0000_0100_0000_01b3n;

export interface CodewhaleCliNormalizer {
  translate(raw: Record<string, unknown>): HadamardBridgeJsonEvent[];
}

export interface CodewhaleSessionCorrelationOptions {
  correlationHint: string;
  cwd: string;
  startedAtMs: number;
  finishedAtMs: number;
  workDir: string;
  environment: Record<string, string>;
  homeDir?: string;
}

export function buildCodewhaleArgs(prompt: string, options: HadamardBridgeRunOptions): string[] {
  const permissionMode = options.permissionMode ?? 'default';
  if (permissionMode === 'acceptEdits') {
    throw new HadamardBridgeProcessError(
      'acceptEdits is not supported safely by CodeWhale headless exec; use default/plan for read-only access or explicitly select bypassPermissions.',
    );
  }
  const bypass = permissionMode === 'bypassPermissions'
    || options.dangerouslySkipPermissions === true;
  if (!['default', 'plan', 'dontAsk', 'bypassPermissions'].includes(permissionMode)) {
    throw new HadamardBridgeProcessError(
      `Unsupported CodeWhale permission mode: ${String(permissionMode)}`,
    );
  }

  const selection = codewhaleModelSelection(options);
  const args = selection.provider
    ? ['--provider', selection.provider, 'exec', '--output-format', 'stream-json']
    : ['exec', '--output-format', 'stream-json'];
  const requested = requestedAllowedTools(options.tools, options.allowedTools);
  if (bypass) {
    args.push('--auto');
    if (requested !== undefined) args.push('--allowed-tools', requested.join(','));
  } else {
    const readOnly = (requested ?? [...CODEWHALE_READ_ONLY_TOOLS])
      .filter(tool => READ_ONLY_TOOL_SET.has(tool));
    args.push('--allowed-tools', readOnly.join(','));
  }
  const disallowed = normalizeToolNames(options.disallowedTools ?? []);
  if (disallowed.length > 0) args.push('--disallowed-tools', disallowed.join(','));
  if (selection.model != null) args.push('--model', validateModel(selection.model));
  if (options.maxTurns != null) {
    if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1 || options.maxTurns > 0xffff_ffff) {
      throw new HadamardBridgeProcessError('CodeWhale maxTurns must be a positive safe integer.');
    }
    args.push('--max-turns', String(options.maxTurns));
  }
  const systemPrompt = [options.systemPrompt, options.appendSystemPrompt]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n\n');
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  const resumeId = typeof options.resume === 'string'
    ? validateSessionId(options.resume)
    : options.resume === true && options.sessionId
      ? validateSessionId(options.sessionId)
      : undefined;
  if (resumeId) args.push(`--resume=${resumeId}`);
  else if (options.resume === true || options.continueMostRecent === true) args.push('--continue');
  args.push('--', prompt);
  return args;
}

export function createCodewhaleNormalizer(): CodewhaleCliNormalizer {
  return new CodewhaleNormalizer();
}

export async function resolveCodewhaleSessionId(
  options: CodewhaleSessionCorrelationOptions,
): Promise<string | undefined> {
  if (!CORRELATION_HINT.test(options.correlationHint) || !options.cwd.trim()
    || !Number.isFinite(options.startedAtMs) || !Number.isFinite(options.finishedAtMs)
    || options.finishedAtMs < options.startedAtMs) return undefined;
  const roots = codewhaleSessionRoots(options);
  const matches = new Set<string>();
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile() || !SESSION_FILE.test(entry.name)) continue;
      const filePath = path.join(root, entry.name);
      let fileInfo;
      try {
        fileInfo = await stat(filePath);
      } catch {
        continue;
      }
      if (fileInfo.mtimeMs < options.startedAtMs - CLOCK_SKEW_MS
        || fileInfo.mtimeMs > options.finishedAtMs + CLOCK_SKEW_MS) continue;
      const metadata = await readSessionMetadata(filePath, fileInfo.size);
      if (!metadata) continue;
      const id = nonEmptyString(metadata.id);
      const workspace = nonEmptyString(metadata.workspace);
      if (id && workspace && samePath(workspace, options.cwd)
        && redactedIdentifierForLog(id) === options.correlationHint) matches.add(id);
    }
  }
  return matches.size === 1 ? matches.values().next().value : undefined;
}

function codewhaleModelSelection(
  options: HadamardBridgeRunOptions,
): { provider?: string; model?: string } {
  const model = options.model?.trim();
  const separator = model?.indexOf('/') ?? -1;
  if (model && separator > 0 && separator < model.length - 1) {
    return { provider: validateProvider(model.slice(0, separator)), model: model.slice(separator + 1) };
  }
  return {
    provider: options.credentialProvider ? validateProvider(options.credentialProvider) : undefined,
    model,
  };
}

function validateProvider(value: string): string {
  const provider = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(provider)) {
    throw new HadamardBridgeProcessError(
      'CodeWhale provider must contain only letters, numbers, dots, underscores, or hyphens.',
    );
  }
  return provider;
}

function requestedAllowedTools(
  tools: HadamardBridgeToolsOption | undefined,
  allowedTools: string[] | undefined,
): string[] | undefined {
  if (tools === 'none') return [];
  if (!Array.isArray(tools) && allowedTools === undefined) return undefined;
  return normalizeToolNames([...(Array.isArray(tools) ? tools : []), ...(allowedTools ?? [])]);
}

function normalizeToolNames(values: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    const tool = value.trim();
    if (!tool || tool.includes(',') || /[\u0000-\u001f\u007f]/u.test(tool)) {
      throw new HadamardBridgeProcessError(
        'CodeWhale tool names must be non-empty values without commas or control characters.',
      );
    }
    normalized.add(tool);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function validateModel(value: string): string {
  const model = value.trim();
  if (!model || model.length > 512 || model.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(model)) {
    throw new HadamardBridgeProcessError(
      'CodeWhale model must be a non-option value without control characters.',
    );
  }
  return model;
}

function validateSessionId(value: string): string {
  const sessionId = value.trim();
  if (!sessionId || sessionId.length > 256 || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/u.test(sessionId)) {
    throw new HadamardBridgeProcessError(
      'CodeWhale session id must be a non-option identifier containing only letters, numbers, underscores, and hyphens.',
    );
  }
  return sessionId;
}

class CodewhaleNormalizer implements CodewhaleCliNormalizer {
  private assistantText = '';
  private initEmitted = false;
  private terminal = false;
  private model: string | undefined;
  private cwd: string | undefined;
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;
  private messageCount: number | undefined;
  private status: string | undefined;
  private correlationHint: string | undefined;

  translate(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    if (this.terminal) return [];
    if (raw.type === 'content') return this.translateContent(raw);
    if (raw.type === 'tool_use') return this.translateToolUse(raw);
    if (raw.type === 'tool_result') return this.translateToolResult(raw);
    if (raw.type === 'metadata') return this.translateMetadata(raw);
    if (raw.type === 'done') return this.translateDone();
    if (raw.type === 'error') return this.translateError(raw);
    return [];
  }

  private translateContent(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    if (typeof raw.content !== 'string' || raw.content.length === 0) return [];
    this.assistantText += raw.content;
    return [event('stream_event', { session_id: '', event: {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: raw.content },
    } })];
  }

  private translateToolUse(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return [];
    return [event('assistant', { session_id: '', message: { role: 'assistant', content: [{
      type: 'tool_use', id: raw.id, name: raw.name, input: raw.input ?? {},
    }] } })];
  }

  private translateToolResult(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    if (typeof raw.id !== 'string' || typeof raw.output !== 'string') return [];
    return [event('user', { session_id: '', message: { role: 'user', content: [{
      type: 'tool_result', tool_use_id: raw.id, content: raw.output, is_error: raw.status !== 'success',
    }] } })];
  }

  private translateMetadata(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    if (!isRecord(raw.meta)) return [];
    this.model = nonEmptyString(raw.meta.model) ?? this.model;
    this.cwd = nonEmptyString(raw.meta.workspace) ?? this.cwd;
    this.inputTokens = finiteNumber(raw.meta.input_tokens) ?? this.inputTokens;
    this.outputTokens = finiteNumber(raw.meta.output_tokens) ?? this.outputTokens;
    this.messageCount = finiteNumber(raw.meta.message_count) ?? this.messageCount;
    this.status = nonEmptyString(raw.meta.status) ?? this.status;
    const hint = nonEmptyString(raw.meta.session_id);
    if (hint && CORRELATION_HINT.test(hint)) this.correlationHint = hint;
    return this.emitInit();
  }

  private translateDone(): HadamardBridgeJsonEvent[] {
    this.terminal = true;
    const failed = this.status != null && FAILED_STATUSES.has(this.status.toLowerCase());
    const events = this.emitInit();
    if (this.assistantText) events.push(event('assistant', {
      session_id: '', message: { role: 'assistant', content: [{ type: 'text', text: this.assistantText }] },
    }));
    events.push(this.result(failed, this.assistantText, failed ? this.status ?? 'error' : 'end_turn'));
    return events;
  }

  private translateError(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    if (typeof raw.error !== 'string') return [];
    this.terminal = true;
    return [...this.emitInit(), this.result(true, raw.error, 'error')];
  }

  private emitInit(): HadamardBridgeJsonEvent[] {
    if (this.initEmitted) return [];
    this.initEmitted = true;
    const init = event('system', {
      subtype: 'init', session_id: '', tools: [], mcp_servers: [], slash_commands: [],
      agents: [], skills: [], plugins: [],
    });
    if (this.cwd) init.cwd = this.cwd;
    if (this.model) init.model = this.model;
    if (this.correlationHint) init.correlationHint = this.correlationHint;
    return [init];
  }

  private result(isError: boolean, result: string, stopReason: string): HadamardBridgeJsonEvent {
    const terminal = event('result', {
      subtype: isError ? 'error' : 'success', session_id: '', is_error: isError,
      result, stop_reason: stopReason, num_turns: 1,
    });
    if (this.model) terminal.model = this.model;
    if (this.inputTokens != null) terminal.input_tokens = this.inputTokens;
    if (this.outputTokens != null) terminal.output_tokens = this.outputTokens;
    if (this.messageCount != null) terminal.message_count = this.messageCount;
    if (this.correlationHint) terminal.correlationHint = this.correlationHint;
    return terminal;
  }
}

function codewhaleSessionRoots(options: CodewhaleSessionCorrelationOptions): string[] {
  const roots = new Set<string>();
  const configuredHome = options.environment.CODEWHALE_HOME;
  if (configuredHome) roots.add(path.join(path.resolve(options.workDir, configuredHome), 'sessions'));
  const home = options.homeDir || options.environment.HOME || options.environment.USERPROFILE;
  if (home) roots.add(path.join(path.resolve(home), '.codewhale', 'sessions'));
  return [...roots];
}

async function readSessionMetadata(
  filePath: string,
  size: number,
): Promise<Record<string, unknown> | undefined> {
  if (size <= 0) return undefined;
  const handle = await open(filePath, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(Math.min(size, SESSION_PREFIX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const source = buffer.subarray(0, bytesRead).toString('utf8');
    if (size <= bytesRead) {
      const parsed = JSON.parse(source) as unknown;
      return isRecord(parsed) && isRecord(parsed.metadata) ? parsed.metadata : undefined;
    }
    return extractObjectProperty(source, 'metadata');
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

function extractObjectProperty(source: string, property: string): Record<string, unknown> | undefined {
  const pattern = new RegExp(`"${property}"\\s*:\\s*\\{`, 'u');
  const match = pattern.exec(source);
  if (!match) return undefined;
  const start = match.index + match[0].lastIndexOf('{');
  const end = jsonObjectEnd(source, start);
  if (end == null) return undefined;
  try {
    const parsed = JSON.parse(source.slice(start, end)) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function jsonObjectEnd(source: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return index + 1;
  }
  return undefined;
}

function redactedIdentifierForLog(identifier: string): string {
  const bytes = Buffer.from(identifier, 'utf8');
  let hash = FINGERPRINT_OFFSET;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * FINGERPRINT_PRIME);
  hash = BigInt.asUintN(64, (hash ^ BigInt(bytes.length)) * FINGERPRINT_PRIME);
  return `<redacted:${hash.toString(16).padStart(16, '0')}>`;
}

function samePath(left: string, right: string): boolean {
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  return process.platform === 'win32'
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function event(type: string, fields: Record<string, unknown>): HadamardBridgeJsonEvent {
  return { type, ...fields } as HadamardBridgeJsonEvent;
}
