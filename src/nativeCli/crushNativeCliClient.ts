import { access } from 'node:fs/promises';
import path from 'node:path';

import { HadamardBridgeProcessError, RunAbortedError } from '../errors.js';
import { AsyncQueue } from '../runtime/asyncQueue.js';
import { asError, isRecord } from '../runtime/helpers.js';
import type {
  HadamardBridgeJsonEvent,
  HadamardBridgeRunOptions,
  HadamardBridgeRunResult,
} from '../types.js';
import { runCrushManaged } from './crushManagedClient.js';
import type {
  HadamardNativeCliClientOptions,
  NativeCliClient,
  NativeCliRunStream,
} from './nativeCliContracts.js';
import { nativeChildEnvironment } from './nativeCliEnvironment.js';

const MAX_EVENTS = 1_000;
const MAX_ASSISTANT_MESSAGES = 128;

class CrushRunStream implements NativeCliRunStream {
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

export class CrushNativeCliClient implements NativeCliClient {
  private readonly controllers = new Set<AbortController>();
  private readonly runs = new Set<Promise<HadamardBridgeRunResult>>();
  private closed = false;

  constructor(private readonly defaults: HadamardNativeCliClientOptions & { runtime: 'crush' }) {}

  stream(prompt: string, options: HadamardBridgeRunOptions = {}): NativeCliRunStream {
    const merged: HadamardBridgeRunOptions = {
      ...options,
      model: options.model ?? this.defaults.model,
      workDir: options.workDir ?? this.defaults.workDir ?? process.cwd(),
      homeDir: options.homeDir ?? this.defaults.homeDir,
      profileName: options.profileName ?? this.defaults.profileName,
      credentialProvider: options.credentialProvider ?? this.defaults.credentialProvider,
      trustProjectResources: options.trustProjectResources ?? this.defaults.trustProjectResources,
      env: { ...this.defaults.env, ...options.env },
    };
    return new CrushRunStream(emit => this.trackRun(prompt, merged, emit));
  }

  async close(): Promise<void> {
    if (this.closed && this.runs.size === 0) return;
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.runs]);
  }

  private trackRun(
    prompt: string,
    options: HadamardBridgeRunOptions,
    emit: (event: HadamardBridgeJsonEvent) => void,
  ): Promise<HadamardBridgeRunResult> {
    const run = this.execute(prompt, options, emit);
    this.runs.add(run);
    void run.finally(() => this.runs.delete(run)).catch(() => undefined);
    return run;
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
        'Crush managed mode does not expose a native session-fork operation.',
      );
    }
    if (options.resume === true || options.continueMostRecent) {
      throw new HadamardBridgeProcessError(
        'Crush managed mode requires an exact native session id to resume.',
      );
    }
    const cwd = path.resolve(options.workDir ?? process.cwd());
    if (options.trustProjectResources !== true) {
      const projectConfig = await findProjectConfig(cwd);
      if (projectConfig) throw new HadamardBridgeProcessError(
        `Crush project config requires trustProjectResources: ${projectConfig}`,
      );
    }

    const controller = new AbortController();
    this.controllers.add(controller);
    const forwardAbort = () => controller.abort();
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
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
      const environment = nativeChildEnvironment(options.env);
      const provider = credentialProvider(options);
      const managed = await runCrushManaged({
        executable: this.defaults.executable,
        executableArgs: this.defaults.cliPath ? [this.defaults.cliPath] : undefined,
        cwd,
        prompt,
        nativeSessionId: typeof options.resume === 'string' ? options.resume : undefined,
        model: managedModel(options.model, provider),
        credentialProvider: provider,
        permissionMode: options.dangerouslySkipPermissions
          ? 'bypassPermissions'
          : options.permissionMode,
        env: environment,
        inheritEnvironment: false,
        signal: controller.signal,
      }, onEvent);
      if (!resultEvent) throw new HadamardBridgeProcessError(
        managed.stderr.trim()
          ? `Crush exited without a result event: ${managed.stderr.trim()}`
          : 'Crush exited without emitting a result event.',
        { stderr: managed.stderr, exitCode: managed.exitCode },
      );
      return {
        text: resultText(resultEvent, assistantMessages),
        sessionId: stringValue(resultEvent.session_id)
          ?? stringValue(initEvent?.session_id)
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
      const normalized = asError(error);
      if (controller.signal.aborted || normalized.name === 'AbortError') {
        throw new RunAbortedError('The Crush managed run was aborted.', { cause: error });
      }
      if (error instanceof HadamardBridgeProcessError) throw error;
      throw new HadamardBridgeProcessError(normalized.message, { cause: error });
    } finally {
      options.signal?.removeEventListener('abort', forwardAbort);
      this.controllers.delete(controller);
    }
  }
}

export function createCrushNativeCliClient(
  options: HadamardNativeCliClientOptions & { runtime: 'crush' },
): CrushNativeCliClient {
  return new CrushNativeCliClient(options);
}

const UNSUPPORTED_OPTIONS = [
  'fallbackModel', 'systemPrompt', 'appendSystemPrompt', 'maxTurns', 'agent', 'agents',
  'tools', 'allowedTools', 'disallowedTools', 'addDirs', 'mcpConfigs', 'strictMcpConfig',
  'settings', 'settingSources', 'jsonSchema', 'files', 'bare', 'disableSlashCommands',
  'includeHookEvents', 'pluginDirs', 'cliArgs', 'effort', 'maxBudgetUsd',
] as const satisfies readonly (keyof HadamardBridgeRunOptions)[];

function assertSupportedOptions(options: HadamardBridgeRunOptions): void {
  const unsupported = UNSUPPORTED_OPTIONS.filter(key => optionWasRequested(options, key));
  if (unsupported.length) throw new HadamardBridgeProcessError(
    `Crush managed mode cannot enforce bridge option${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}.`,
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

async function findProjectConfig(workDir: string): Promise<string | undefined> {
  let directory = path.resolve(workDir);
  while (true) {
    for (const name of ['crush.json', '.crush.json']) {
      const candidate = path.join(directory, name);
      if (await access(candidate).then(() => true, () => false)) return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function credentialProvider(options: HadamardBridgeRunOptions): string | undefined {
  const explicit = options.credentialProvider?.trim().toLowerCase();
  if (explicit) return explicit;
  const model = options.model?.trim();
  const separator = model?.indexOf('/') ?? -1;
  return model && separator > 0 ? model.slice(0, separator).toLowerCase() : undefined;
}

function managedModel(modelValue: string | undefined, provider: string | undefined): string | undefined {
  const model = modelValue?.trim();
  if (!model) return undefined;
  const separator = model.indexOf('/');
  if (separator <= 0 || !provider) return model;
  return model.slice(0, separator).toLowerCase() === provider ? model.slice(separator + 1) : model;
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

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
