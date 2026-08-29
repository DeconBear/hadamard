import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveHadamardHome } from '../config/hadamardHome.js';
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
  NativeCliClient,
  NativeCliRunStream,
} from './nativeCliContracts.js';
import { nativeChildEnvironment, nativeSensitiveValues } from './nativeCliEnvironment.js';
import { IS_WINDOWS, resolveExecutableInvocation } from './nativeCliExecResolver.js';
import { createReasonixManagedClient, type ReasonixManagedClient } from './reasonixManagedClient.js';

const MAX_EVENTS = 1_000;
const MAX_ASSISTANT_MESSAGES = 128;

interface ManagedEntry {
  client: ReasonixManagedClient;
  transcriptPath: string;
  transcriptCreatedAt: string;
  transcriptTitle?: string;
  cleanupPromise?: Promise<void>;
}

class ReasonixRunStream implements NativeCliRunStream {
  private readonly queue = new AsyncQueue<HadamardBridgeJsonEvent>({
    capacity: MAX_EVENTS,
    overflowStrategy: 'drop-oldest',
    isPriority: event => event.type === 'system' || event.type === 'result',
    priorityReserve: 2,
    canDrop: event => event.type !== 'system' && event.type !== 'result',
  });
  readonly result: Promise<HadamardBridgeRunResult>;

  constructor(execute: (emit: (event: HadamardBridgeJsonEvent) => void) => Promise<HadamardBridgeRunResult>) {
    this.result = execute(event => this.queue.push(event))
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

export class ReasonixNativeCliClient implements NativeCliClient {
  private readonly entries = new Map<string, ManagedEntry>();
  private readonly pendingEntries = new Map<string, Promise<ManagedEntry>>();
  private closed = false;

  constructor(private readonly defaults: HadamardNativeCliClientOptions & { runtime: 'reasonix' }) {}

  stream(prompt: string, options: HadamardBridgeRunOptions = {}): NativeCliRunStream {
    const merged: HadamardBridgeRunOptions = {
      ...options,
      model: options.model ?? this.defaults.model,
      workDir: options.workDir ?? this.defaults.workDir ?? process.cwd(),
      homeDir: options.homeDir ?? this.defaults.homeDir,
      profileName: options.profileName ?? this.defaults.profileName,
      credentialProvider: options.credentialProvider ?? this.defaults.credentialProvider,
      env: { ...this.defaults.env, ...options.env },
    };
    return new ReasonixRunStream(emit => this.execute(prompt, merged, emit));
  }

  async close(): Promise<void> {
    if (this.closed && this.entries.size === 0 && this.pendingEntries.size === 0) return;
    this.closed = true;
    const pending = await Promise.allSettled([...this.pendingEntries.values()]);
    const entries = new Set(this.entries.values());
    for (const result of pending) if (result.status === 'fulfilled') entries.add(result.value);
    await Promise.all([...entries].map(entry => this.release(entry)));
    this.entries.clear();
    this.pendingEntries.clear();
  }

  private async execute(
    prompt: string,
    options: HadamardBridgeRunOptions,
    emit: (event: HadamardBridgeJsonEvent) => void,
  ): Promise<HadamardBridgeRunResult> {
    if (this.closed) throw new HadamardBridgeProcessError('The native CLI client is closed.');
    assertSupportedOptions(options);
    if (options.forkSession) {
      throw new HadamardBridgeProcessError(
        'Reasonix managed mode does not expose a native session-fork operation.',
      );
    }
    if (options.resume === true || options.continueMostRecent) {
      throw new HadamardBridgeProcessError(
        'Reasonix managed mode requires an exact persisted session id.',
      );
    }
    const nativeSessionId = typeof options.resume === 'string'
      ? validateReasonixValue(options.resume, 'session id')
      : undefined;
    const cwd = path.resolve(options.workDir ?? process.cwd());
    const fingerprint = configFingerprint(options);
    const logicalSessionId = (nativeSessionId ?? options.sessionId?.trim()) || '__default__';
    const alias = entryKey(fingerprint, cwd, logicalSessionId);
    const entry = await this.getOrCreateEntry(alias, cwd, nativeSessionId, options);
    const events: HadamardBridgeJsonEvent[] = [];
    const assistantMessages: HadamardBridgeJsonEvent[] = [];
    let initEvent: HadamardBridgeJsonEvent | undefined;
    let resultEvent: HadamardBridgeJsonEvent | undefined;
    const onEvent = (event: HadamardBridgeJsonEvent): void => {
      retain(events, structuredClone(event), MAX_EVENTS);
      if (event.type === 'system' && event.subtype === 'init') initEvent = structuredClone(event);
      if (event.type === 'assistant') retain(assistantMessages, structuredClone(event), MAX_ASSISTANT_MESSAGES);
      if (event.type === 'result') resultEvent = structuredClone(event);
      emit(event);
    };

    try {
      const managed = await entry.client.run({
        prompt,
        model: options.model,
        effort: options.effort,
        maxBudgetUsd: options.maxBudgetUsd,
        permissionMode: options.dangerouslySkipPermissions
          ? 'bypassPermissions'
          : options.permissionMode ?? 'default',
        signal: options.signal,
        onEvent,
      });
      if (!resultEvent) {
        await this.release(entry);
        throw new HadamardBridgeProcessError(
          managed.stderr.trim()
            ? `Reasonix exited without a result event: ${managed.stderr.trim()}`
            : 'Reasonix exited without emitting a result event.',
          { stderr: managed.stderr, exitCode: managed.exitCode },
        );
      }
      if (managed.reusable && managed.sessionId) {
        await writeTranscriptMetadata(entry, {
          sessionId: managed.sessionId, cwd, model: options.model, prompt,
        }).catch(() => undefined);
        this.entries.set(entryKey(fingerprint, cwd, managed.sessionId), entry);
      } else if (!managed.reusable) await this.release(entry);
      return {
        text: resultText(resultEvent, assistantMessages),
        sessionId: nonEmptyString(resultEvent.session_id)
          ?? nonEmptyString(initEvent?.session_id)
          ?? managed.sessionId,
        isError: typeof resultEvent.is_error === 'boolean' ? resultEvent.is_error : false,
        subtype: stringValue(resultEvent.subtype),
        stopReason: stringValue(resultEvent.stop_reason),
        durationMs: numberValue(resultEvent.duration_ms),
        totalCostUsd: numberValue(resultEvent.total_cost_usd),
        numTurns: numberValue(resultEvent.num_turns),
        exitCode: managed.exitCode,
        stderr: managed.stderr,
        initEvent,
        resultEvent,
        assistantMessages,
        events,
      };
    } catch (error) {
      await this.release(entry);
      const normalized = asError(error);
      if (options.signal?.aborted || normalized.name === 'AbortError') {
        throw new RunAbortedError('The Reasonix managed run was aborted.', { cause: error });
      }
      if (error instanceof HadamardBridgeProcessError) throw error;
      throw new HadamardBridgeProcessError(normalized.message, { cause: error });
    }
  }

  private async getOrCreateEntry(
    alias: string,
    cwd: string,
    nativeSessionId: string | undefined,
    options: HadamardBridgeRunOptions,
  ): Promise<ManagedEntry> {
    const cached = this.entries.get(alias);
    if (cached) return cached;
    const pending = this.pendingEntries.get(alias);
    if (pending) return pending;
    const creation = (async () => {
      const environment = nativeChildEnvironment(options.env);
      const cliArgs = buildReasonixArgs(options);
      const transcriptRoot = path.join(await persistentProfile(options), '.reasonix', 'sessions');
      await ensurePrivateDirectory(transcriptRoot);
      const identity = nativeSessionId
        ? createHash('sha256').update(nativeSessionId).digest('hex').slice(0, 32)
        : randomUUID();
      const transcriptPath = path.join(transcriptRoot, `managed-${identity}.jsonl`);
      cliArgs.push('--dir', cwd, '--transcript', transcriptPath);
      const rawArgs = this.defaults.cliPath ? [this.defaults.cliPath, ...cliArgs] : cliArgs;
      const invocation = await resolveExecutableInvocation(this.defaults.executable!, rawArgs);
      if (this.closed) throw new HadamardBridgeProcessError('The native CLI client is closed.');
      const client = createReasonixManagedClient({
        executable: invocation.file,
        args: invocation.args,
        cwd,
        env: environment,
        nativeSessionId,
        secrets: nativeSensitiveValues(environment),
      });
      const entry: ManagedEntry = {
        client,
        transcriptPath,
        transcriptCreatedAt: new Date().toISOString(),
      };
      this.entries.set(alias, entry);
      return entry;
    })();
    this.pendingEntries.set(alias, creation);
    try {
      return await creation;
    } finally {
      if (this.pendingEntries.get(alias) === creation) this.pendingEntries.delete(alias);
    }
  }

  private async release(entry: ManagedEntry): Promise<void> {
    for (const [key, candidate] of this.entries) if (candidate === entry) this.entries.delete(key);
    entry.cleanupPromise ??= entry.client.close().catch(() => undefined);
    await entry.cleanupPromise;
  }
}

export async function createReasonixNativeCliClient(
  options: HadamardNativeCliClientOptions & { runtime: 'reasonix' },
): Promise<ReasonixNativeCliClient> {
  return new ReasonixNativeCliClient(options);
}

function buildReasonixArgs(options: HadamardBridgeRunOptions): string[] {
  const args = ['acp'];
  if (options.model) args.push('--model', validateReasonixValue(options.model, 'model'));
  return args;
}

function validateReasonixValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || normalized.startsWith('-')
    || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new HadamardBridgeProcessError(
      `Reasonix ${label} must be a non-option value without control characters.`,
    );
  }
  return normalized;
}

const UNSUPPORTED_OPTIONS = [
  'fallbackModel', 'systemPrompt', 'appendSystemPrompt', 'maxTurns', 'agent', 'agents',
  'tools', 'allowedTools', 'disallowedTools', 'addDirs', 'mcpConfigs', 'strictMcpConfig',
  'settings', 'settingSources', 'jsonSchema', 'files', 'bare', 'disableSlashCommands',
  'includeHookEvents', 'pluginDirs', 'cliArgs',
] as const satisfies readonly (keyof HadamardBridgeRunOptions)[];

function assertSupportedOptions(options: HadamardBridgeRunOptions): void {
  const unsupported = UNSUPPORTED_OPTIONS.filter(key => optionWasRequested(options, key));
  if (unsupported.length) throw new HadamardBridgeProcessError(
    `Reasonix managed mode cannot enforce bridge option${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}.`,
  );
}

function optionWasRequested(options: HadamardBridgeRunOptions, key: keyof HadamardBridgeRunOptions): boolean {
  const value = options[key];
  if (value == null) return false;
  if (key === 'tools') return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'boolean') return value;
  return true;
}

function configFingerprint(options: HadamardBridgeRunOptions): string {
  return createHash('sha256').update(JSON.stringify({
    homeDir: options.homeDir ?? '',
    model: options.model ?? '',
    profileName: options.profileName ?? '',
    credentialProvider: options.credentialProvider ?? '',
    env: Object.entries(options.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  })).digest('hex');
}

function entryKey(fingerprint: string, cwd: string, sessionId: string): string {
  return `${fingerprint}\0${cwd}\0${sessionId}`;
}

async function persistentProfile(options: HadamardBridgeRunOptions): Promise<string> {
  const name = options.profileName?.trim();
  const identity = name ? `name:${name}` : `anonymous:${options.credentialProvider ?? ''}`;
  const profileId = createHash('sha256').update(`reasonix\0${identity}`).digest('hex');
  const root = path.join(resolveHadamardHome(options.homeDir), 'external-cli-profiles', 'reasonix', profileId);
  await ensurePrivateDirectory(root);
  return root;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!IS_WINDOWS) await chmod(directory, 0o700);
}

async function writeTranscriptMetadata(
  entry: ManagedEntry,
  options: { sessionId: string; cwd: string; model?: string; prompt: string },
): Promise<void> {
  entry.transcriptTitle ??= options.prompt.replace(/\s+/gu, ' ').trim().slice(0, 160);
  const stem = entry.transcriptPath.slice(0, -path.extname(entry.transcriptPath).length);
  await writeFile(`${stem}.acp.json`, `${JSON.stringify({
    sessionId: options.sessionId,
    title: entry.transcriptTitle || options.sessionId,
    cwd: options.cwd,
    model: options.model,
    createdAt: entry.transcriptCreatedAt,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function resultText(result: HadamardBridgeJsonEvent, messages: readonly HadamardBridgeJsonEvent[]): string {
  if (typeof result.result === 'string') return result.result;
  const parts: string[] = [];
  for (const event of messages) {
    const message = isRecord(event.message) ? event.message : undefined;
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
  return stringValue(value)?.trim() || undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
