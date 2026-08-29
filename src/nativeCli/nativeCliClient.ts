import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

import { HadamardBridgeProcessError, RunAbortedError } from '../errors.js';
import { AsyncQueue } from '../runtime/asyncQueue.js';
import { asError, isRecord } from '../runtime/helpers.js';
import type {
  HadamardBridgeJsonEvent,
  HadamardBridgeRunOptions,
  HadamardBridgeRunResult,
} from '../types.js';
import type {
  HadamardNativeCliClientOptions,
  HadamardOwnedNativeCliRuntime,
  NativeCliClient,
  NativeCliRunStream,
} from './nativeCliContracts.js';
import { resolveNativeCliExecutable } from './nativeCliAuth.js';
import {
  buildCodewhaleArgs,
  createCodewhaleNormalizer,
  resolveCodewhaleSessionId,
} from './nativeCliCodewhaleProtocol.js';
import { buildCursorArgs, createCursorNormalizer } from './nativeCliCursorProtocol.js';
import { buildPiArgs, createPiNormalizer } from './nativeCliPiProtocol.js';
import { nativeChildEnvironment, nativeSensitiveValues } from './nativeCliEnvironment.js';
import {
  IS_WINDOWS,
  resolveExecutableInvocation,
} from './nativeCliExecResolver.js';
import { terminateManagedProcessTree } from './nativeCliProcessTree.js';
import { createReasonixNativeCliClient } from './reasonixNativeCliClient.js';

const MAX_RETAINED_EVENTS = 1_000;
const MAX_RETAINED_ASSISTANT_MESSAGES = 128;
const MAX_STDERR_BYTES = 1024 * 1024;
const OUTPUT_TRUNCATION_MARKER = '[Hadamard output truncated]\n';
export type {
  HadamardNativeCliClientOptions,
  HadamardOwnedNativeCliRuntime,
  NativeCliClient,
  NativeCliRunStream,
} from './nativeCliContracts.js';

interface NativeCliNormalizer {
  translate(record: Record<string, unknown>, control?: NativeCliProcessControl): HadamardBridgeJsonEvent[];
  interactive?: true;
  start?(control: NativeCliProcessControl): void;
  abort?(control: NativeCliProcessControl): void;
  abortGraceMs?: number;
}

interface NativeCliProcessControl {
  write(record: Record<string, unknown>): void;
  endInput(): void;
}

class NativeCliRunStreamImpl implements NativeCliRunStream {
  private readonly queue = new AsyncQueue<HadamardBridgeJsonEvent>({
    capacity: MAX_RETAINED_EVENTS,
    overflowStrategy: 'drop-oldest',
    isPriority: event => event.type === 'system' || event.type === 'result',
    priorityReserve: 2,
    canDrop: event => event.type !== 'system' && event.type !== 'result',
  });
  readonly result: Promise<HadamardBridgeRunResult>;

  constructor(
    executor: (emit: (event: HadamardBridgeJsonEvent) => void) => Promise<HadamardBridgeRunResult>,
  ) {
    this.result = executor(event => this.queue.push(event))
      .catch(error => {
        this.queue.fail(error);
        throw error;
      })
      .finally(() => this.queue.close());
  }

  [Symbol.asyncIterator](): AsyncIterator<HadamardBridgeJsonEvent> {
    return this.queue[Symbol.asyncIterator]();
  }
}

export class HadamardNativeCliClient implements NativeCliClient {
  private readonly children = new Set<ReturnType<typeof spawn>>();
  private readonly reclaims = new Map<ReturnType<typeof spawn>, () => Promise<void>>();
  private closed = false;

  private constructor(private readonly defaults: HadamardNativeCliClientOptions) {}

  static async create(options: HadamardNativeCliClientOptions): Promise<HadamardNativeCliClient> {
    const executable = options.executable ?? await resolveNativeCliExecutable(options.runtime);
    return new HadamardNativeCliClient({ ...options, executable });
  }

  stream(prompt: string, options: HadamardBridgeRunOptions = {}): NativeCliRunStream {
    const merged: HadamardBridgeRunOptions = {
      ...options,
      model: options.model ?? this.defaults.model,
      workDir: options.workDir ?? this.defaults.workDir ?? process.cwd(),
      env: { ...this.defaults.env, ...options.env },
      credentialProvider: options.credentialProvider ?? this.defaults.credentialProvider,
      trustProjectResources: options.trustProjectResources ?? this.defaults.trustProjectResources,
    };
    return new NativeCliRunStreamImpl(emit => this.execute(prompt, merged, emit));
  }

  async close(): Promise<void> {
    if (this.closed && this.children.size === 0) return;
    this.closed = true;
    await Promise.all([...this.reclaims.values()].map(reclaim => reclaim().catch(() => undefined)));
    await Promise.all([...this.children].map(child => terminateManagedProcessTree(child)));
    this.children.clear();
    this.reclaims.clear();
  }

  private async execute(
    prompt: string,
    options: HadamardBridgeRunOptions,
    emit: (event: HadamardBridgeJsonEvent) => void,
  ): Promise<HadamardBridgeRunResult> {
    if (this.closed) throw new HadamardBridgeProcessError('The native CLI client is closed.');
    if (options.signal?.aborted) throw new RunAbortedError('The native CLI run was aborted before it started.');

    const cliArgs = buildRuntimeArgs(this.defaults.runtime, prompt, options);
    const args = this.defaults.cliPath ? [this.defaults.cliPath, ...cliArgs] : cliArgs;
    const invocation = await resolveExecutableInvocation(this.defaults.executable!, args);
    if (this.closed) throw new HadamardBridgeProcessError('The native CLI client is closed.');
    if (options.signal?.aborted) {
      throw new RunAbortedError('The native CLI run was aborted before it started.');
    }
    const environment = nativeChildEnvironment(options.env);
    const secrets = nativeSensitiveValues(environment);
    const normalizer = createRuntimeNormalizer(this.defaults.runtime, prompt, options);
    const effectiveWorkDir = path.resolve(options.workDir ?? process.cwd());
    const runStartedAtMs = Date.now();
    const child = spawn(invocation.file, invocation.args, {
      cwd: effectiveWorkDir,
      env: environment,
      stdio: [normalizer.interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      detached: !IS_WINDOWS,
    });
    this.children.add(child);
    child.once('close', () => {
      this.children.delete(child);
      this.reclaims.delete(child);
    });

    let inputEnded = false;
    child.stdin?.on('error', () => {
      // Interactive CLIs may close stdin after their terminal response.
    });
    const processControl: NativeCliProcessControl = {
      write: record => {
        if (inputEnded || !child.stdin || child.stdin.destroyed) return;
        child.stdin.write(`${JSON.stringify(record)}\n`);
      },
      endInput: () => {
        if (inputEnded) return;
        inputEnded = true;
        child.stdin?.end();
      },
    };

    let aborted = false;
    let termination: Promise<void> | undefined;
    let protocolAbortRequested = false;
    const forceReclaim = async () => {
      termination ??= terminateManagedProcessTree(child);
      await termination;
    };
    const gracefulReclaim = async () => {
      if (normalizer.abort && !protocolAbortRequested) {
        protocolAbortRequested = true;
        normalizer.abort(processControl);
      }
      termination ??= normalizer.abort
        ? (async () => {
          await new Promise(resolve => setTimeout(resolve, normalizer.abortGraceMs ?? 250));
          await terminateManagedProcessTree(child);
        })()
        : terminateManagedProcessTree(child);
      await termination;
    };
    const abort = () => {
      aborted = true;
      void gracefulReclaim();
    };
    this.reclaims.set(child, gracefulReclaim);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    const events: HadamardBridgeJsonEvent[] = [];
    const assistantMessages: HadamardBridgeJsonEvent[] = [];
    let initEvent: HadamardBridgeJsonEvent | undefined;
    let resultEvent: HadamardBridgeJsonEvent | undefined;
    let correlatedSessionId: string | undefined;
    let stderr = '';
    let exitCode: number | null = null;

    try {
      normalizer.start?.(processControl);
      const stdoutTask = parseJsonLines(child, normalizer, processControl, event => {
        retain(events, structuredClone(event), MAX_RETAINED_EVENTS);
        if (event.type === 'system' && event.subtype === 'init') initEvent = structuredClone(event);
        if (event.type === 'assistant') retain(assistantMessages, structuredClone(event), MAX_RETAINED_ASSISTANT_MESSAGES);
        if (event.type === 'result') resultEvent = structuredClone(event);
        emit(redactEvent(event, secrets));
      }, secrets);
      const stderrTask = readBoundedText(child.stderr, MAX_STDERR_BYTES)
        .then(value => redactText(value, secrets));
      const exitTask = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => resolve(code));
      });
      [stderr, exitCode] = await Promise.all([stderrTask, exitTask, stdoutTask])
        .then(([nextStderr, nextExitCode]) => [nextStderr, nextExitCode]);
      if (this.defaults.runtime === 'codewhale' && resultEvent) {
        const correlationHint = nonEmptyString(resultEvent.correlationHint)
          ?? nonEmptyString(initEvent?.correlationHint);
        if (correlationHint) correlatedSessionId = await resolveCodewhaleSessionId({
          correlationHint,
          cwd: nonEmptyString(initEvent?.cwd) ?? effectiveWorkDir,
          startedAtMs: runStartedAtMs,
          finishedAtMs: Date.now(),
          workDir: effectiveWorkDir,
          environment,
          homeDir: this.defaults.homeDir,
        }).catch(() => undefined);
      }
    } catch (error) {
      await forceReclaim();
      const normalized = asError(error);
      if (aborted || normalized.name === 'AbortError') {
        throw new RunAbortedError('The native CLI run was aborted.', { cause: error });
      }
      throw new HadamardBridgeProcessError(redactText(normalized.message, secrets), {
        cause: error,
        stderr,
        exitCode,
      });
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (termination) await termination;
      this.children.delete(child);
      this.reclaims.delete(child);
    }

    if (aborted && !resultEvent) throw new RunAbortedError('The native CLI run was aborted.');
    if (!resultEvent) {
      throw new HadamardBridgeProcessError(
        stderr.trim()
          ? `Native CLI exited without a result event: ${stderr.trim()}`
          : 'Native CLI exited without emitting a result event.',
        { stderr, exitCode },
      );
    }

    return {
      text: resultText(resultEvent, assistantMessages),
      sessionId: nonEmptyString(resultEvent.session_id)
        ?? nonEmptyString(initEvent?.session_id)
        ?? correlatedSessionId
        ?? options.sessionId
        ?? (typeof options.resume === 'string' ? options.resume : ''),
      isError: typeof resultEvent.is_error === 'boolean' ? resultEvent.is_error : false,
      subtype: stringValue(resultEvent.subtype),
      stopReason: stringValue(resultEvent.stop_reason),
      durationMs: numberValue(resultEvent.duration_ms),
      totalCostUsd: numberValue(resultEvent.total_cost_usd),
      numTurns: numberValue(resultEvent.num_turns),
      exitCode,
      stderr,
      initEvent,
      resultEvent,
      assistantMessages,
      events,
    };
  }
}

export async function createNativeCliClient(
  options: HadamardNativeCliClientOptions,
): Promise<NativeCliClient> {
  if (options.runtime === 'reasonix') {
    const executable = options.executable ?? await resolveNativeCliExecutable('reasonix');
    return createReasonixNativeCliClient({ ...options, executable, runtime: 'reasonix' });
  }
  return HadamardNativeCliClient.create(options);
}

function buildRuntimeArgs(
  runtime: HadamardOwnedNativeCliRuntime,
  prompt: string,
  options: HadamardBridgeRunOptions,
): string[] {
  switch (runtime) {
    case 'claude': return buildClaudeArgs(prompt, options);
    case 'codewhale': return buildCodewhaleArgs(prompt, options);
    case 'codex': return buildCodexArgs(prompt, options);
    case 'cursor': return buildCursorArgs(prompt, options);
    case 'pi': return buildPiArgs(prompt, options);
    case 'reasonix': throw new HadamardBridgeProcessError('Reasonix uses its managed ACP runtime.');
  }
}

function createRuntimeNormalizer(
  runtime: HadamardOwnedNativeCliRuntime,
  prompt: string,
  options: HadamardBridgeRunOptions,
): NativeCliNormalizer {
  switch (runtime) {
    case 'claude': return { translate: record => [record as HadamardBridgeJsonEvent] };
    case 'codewhale': return createCodewhaleNormalizer();
    case 'codex': return new CodexNormalizer();
    case 'cursor': return createCursorNormalizer();
    case 'pi': return createPiNormalizer(prompt, options);
    case 'reasonix': throw new HadamardBridgeProcessError('Reasonix uses its managed ACP runtime.');
  }
}

function buildClaudeArgs(prompt: string, options: HadamardBridgeRunOptions): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (options.includePartialMessages ?? true) args.push('--include-partial-messages');
  if (options.includeHookEvents) args.push('--include-hook-events');
  if (options.bare) args.push('--bare');
  if (options.disableSlashCommands) args.push('--disable-slash-commands');
  if (options.strictMcpConfig) args.push('--strict-mcp-config');
  if (options.continueMostRecent) args.push('--continue');
  if (options.forkSession) args.push('--fork-session');
  if (options.dangerouslySkipPermissions || options.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  }
  addOptional(args, '--permission-mode', options.permissionMode ?? 'default');
  addOptional(args, '--model', options.model);
  addOptional(args, '--fallback-model', options.fallbackModel);
  addOptional(args, '--effort', options.effort);
  addOptional(args, '--system-prompt', options.systemPrompt);
  addOptional(args, '--append-system-prompt', options.appendSystemPrompt);
  addOptional(args, '--max-turns', options.maxTurns);
  addOptional(args, '--max-budget-usd', options.maxBudgetUsd);
  addOptional(args, '--agent', options.agent);
  addOptional(args, '-n', options.name);
  addOptional(args, '--setting-sources', options.settingSources);
  if (options.jsonSchema != null) args.push('--json-schema', stringifyCliValue(options.jsonSchema));
  if (options.settings != null) args.push('--settings', stringifyCliValue(options.settings));
  if (options.agents != null) args.push('--agents', JSON.stringify(options.agents));
  const tools = normalizeTools(options.tools);
  if (tools != null) args.push('--tools', tools);
  if (options.allowedTools?.length) args.push('--allowedTools', options.allowedTools.join(','));
  if (options.disallowedTools?.length) args.push('--disallowedTools', options.disallowedTools.join(','));
  addRepeatable(args, '--add-dir', options.addDirs);
  addRepeatable(args, '--plugin-dir', options.pluginDirs);
  addRepeatable(args, '--file', options.files);
  if (options.mcpConfigs?.length) {
    args.push('--mcp-config', ...options.mcpConfigs.map(config => stringifyCliValue(config)));
  }
  if (typeof options.resume === 'string') args.push(`--resume=${options.resume}`);
  else if (options.resume === true) args.push('--resume');
  else if (options.sessionId) args.push(`--session-id=${options.sessionId}`);
  if (options.cliArgs?.length) args.push(...options.cliArgs);
  args.push('--', prompt);
  return args;
}

function buildCodexArgs(prompt: string, options: HadamardBridgeRunOptions): string[] {
  const shouldResume = typeof options.resume === 'string'
    || options.resume === true
    || options.continueMostRecent === true;
  const args = shouldResume
    ? ['exec', 'resume', '--json', '--skip-git-repo-check']
    : ['exec', '--json', '--skip-git-repo-check', '--color', 'never'];
  if (options.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    const sandbox = options.permissionMode === 'acceptEdits' ? 'workspace-write' : 'read-only';
    args.push('-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"');
  }
  if (options.model) args.push('-m', options.model);
  if (options.systemPrompt) args.push('-c', `system_prompt="${options.systemPrompt.replace(/"/g, '\\"')}"`);
  if (typeof options.maxTurns === 'number') args.push('-c', `max_turns=${options.maxTurns}`);
  if (shouldResume && typeof options.resume !== 'string') args.push('--last');
  args.push('--');
  if (typeof options.resume === 'string') args.push(validateCodexSessionId(options.resume));
  args.push(prompt);
  return args;
}

function validateCodexSessionId(value: string): string {
  const sessionId = value.trim();
  if (!sessionId || sessionId.length > 256 || sessionId.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(sessionId)) {
    throw new HadamardBridgeProcessError(
      'Codex session id must be a non-option UUID or thread name without control characters.',
    );
  }
  return sessionId;
}

class CodexNormalizer implements NativeCliNormalizer {
  private threadId: string | undefined;
  private initEmitted = false;

  translate(raw: Record<string, unknown>): HadamardBridgeJsonEvent[] {
    const type = stringValue(raw.type) ?? '';
    const item = isRecord(raw.item) ? raw.item : undefined;
    if (type === 'thread.started') {
      this.threadId = stringValue(raw.thread_id) ?? this.threadId;
      if (this.initEmitted) return [];
      this.initEmitted = true;
      return [event('system', {
        subtype: 'init', session_id: this.threadId ?? '', tools: [], mcp_servers: [],
        slash_commands: [], agents: [], skills: [], plugins: [], model: undefined,
      })];
    }
    if ((type === 'item.started' || type === 'item.completed') && item && isCodexToolItem(item)) {
      const id = stringValue(item.id) ?? `${String(item.type)}-unknown`;
      if (type === 'item.started') {
        return [event('assistant', { session_id: this.threadId ?? '', message: {
          role: 'assistant', content: [{ type: 'tool_use', id, name: codexToolName(item), input: codexToolInput(item) }],
        } })];
      }
      return [event('user', { session_id: this.threadId ?? '', message: {
        role: 'user', content: [{ type: 'tool_result', tool_use_id: id,
          content: codexToolResultContent(item), is_error: codexToolResultIsError(item) }],
      } })];
    }
    if (type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
      return [event('assistant', { session_id: this.threadId ?? '', message: {
        role: 'assistant', content: [{ type: 'text', text: item.text }],
      } })];
    }
    if (type === 'turn.completed') {
      return [event('result', {
        subtype: 'success', session_id: this.threadId ?? '', is_error: false,
        stop_reason: 'end_turn', num_turns: 1, usage: normalizeCodexUsage(raw.usage),
      })];
    }
    if (type === 'turn.failed' || type === 'error') {
      const message = stringValue(raw.message)
        ?? (isRecord(raw.error) ? stringValue(raw.error.message) : undefined)
        ?? 'codex run failed';
      return [event('result', {
        subtype: 'error', session_id: this.threadId ?? '', is_error: true,
        result: message, stop_reason: 'error', num_turns: 1,
      })];
    }
    return [];
  }
}

async function parseJsonLines(
  child: ReturnType<typeof spawn>,
  normalizer: NativeCliNormalizer,
  processControl: NativeCliProcessControl,
  onEvent: (event: HadamardBridgeJsonEvent) => void,
  secrets: readonly string[],
): Promise<void> {
  if (!child.stdout) return;
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new HadamardBridgeProcessError(
        `Failed to parse native CLI stream line: ${redactText(trimmed, secrets)}`,
        { cause: error },
      );
    }
    if (!isRecord(parsed)) throw new HadamardBridgeProcessError('Native CLI emitted a malformed stream event.');
    for (const translated of normalizer.translate(parsed, processControl)) {
      onEvent(redactEvent(translated, secrets));
    }
  }
}

function event(type: string, fields: Record<string, unknown>): HadamardBridgeJsonEvent {
  return { type, ...fields } as HadamardBridgeJsonEvent;
}

function normalizeCodexUsage(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const input = numberValue(value.input_tokens);
  const cached = numberValue(value.cached_input_tokens);
  const output = numberValue(value.output_tokens);
  if (input == null && cached == null && output == null) return undefined;
  return {
    input_tokens: input ?? 0,
    cache_read_input_tokens: cached ?? 0,
    output_tokens: output ?? 0,
  };
}

function isCodexToolItem(item: Record<string, unknown>): boolean {
  return item.type === 'command_execution' || item.type === 'file_change' || item.type === 'mcp_tool_call';
}

function codexToolName(item: Record<string, unknown>): string {
  if (item.type !== 'mcp_tool_call') return String(item.type);
  return ['mcp', stringValue(item.server), stringValue(item.tool)].filter(Boolean).join('__') || 'mcp_tool_call';
}

function codexToolInput(item: Record<string, unknown>): Record<string, unknown> {
  if (item.type === 'command_execution') return typeof item.command === 'string' ? { command: item.command } : {};
  if (item.type === 'file_change') return { changes: Array.isArray(item.changes) ? item.changes : [] };
  if (isRecord(item.arguments)) return item.arguments;
  return item.arguments === undefined ? {} : { arguments: item.arguments };
}

function codexToolResultContent(item: Record<string, unknown>): string {
  const value = item.type === 'command_execution'
    ? item.aggregated_output ?? item.output ?? item.error
    : item.type === 'file_change'
      ? item.changes ?? item.result ?? item.error
      : item.error ?? item.result;
  return typeof value === 'string' ? value : value == null ? '' : (JSON.stringify(value, null, 2) ?? '');
}

function codexToolResultIsError(item: Record<string, unknown>): boolean {
  return item.status === 'failed'
    || (typeof item.exit_code === 'number' && item.exit_code !== 0)
    || (item.error !== undefined && item.error !== null);
}

function addOptional(args: string[], flag: string, value: string | number | undefined): void {
  if (value !== undefined && value !== '') args.push(flag, String(value));
}

function addRepeatable(args: string[], flag: string, values: string[] | undefined): void {
  if (values?.length) args.push(flag, ...values);
}

function stringifyCliValue(value: string | Record<string, unknown>): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function normalizeTools(tools: HadamardBridgeRunOptions['tools']): string | undefined {
  if (tools == null) return undefined;
  if (tools === 'default') return 'default';
  if (tools === 'none') return '';
  return tools.join(',');
}

function resultText(result: HadamardBridgeJsonEvent, assistantMessages: readonly HadamardBridgeJsonEvent[]): string {
  if (typeof result.result === 'string') return result.result;
  const parts: string[] = [];
  for (const messageEvent of assistantMessages) {
    const message = isRecord(messageEvent.message) ? messageEvent.message : undefined;
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('');
}

function retain<T>(items: T[], value: T, limit: number): void {
  if (items.length === limit) items.shift();
  items.push(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  const text = stringValue(value)?.trim();
  return text || undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function redactText(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) if (secret) result = result.split(secret).join('[REDACTED]');
  return result;
}

function redactEvent(value: HadamardBridgeJsonEvent, secrets: readonly string[]): HadamardBridgeJsonEvent {
  return redactValue(value, secrets) as HadamardBridgeJsonEvent;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]));
}

async function readBoundedText(stream: NodeJS.ReadableStream | null, maxBytes: number): Promise<string> {
  if (!stream) return '';
  const markerBytes = Buffer.byteLength(OUTPUT_TRUNCATION_MARKER);
  const payloadLimit = Math.max(0, maxBytes - markerBytes);
  let retained: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let truncated = false;
  for await (const chunk of stream) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const combined = retained.length === 0 ? next : Buffer.concat([retained, next]);
    if (combined.length > payloadLimit) {
      retained = Buffer.from(combined.subarray(combined.length - payloadLimit));
      truncated = true;
    } else retained = combined;
  }
  return `${truncated ? OUTPUT_TRUNCATION_MARKER : ''}${retained.toString('utf8')}`;
}
