/**
 * Worker-thread code runtime: a fresh worker runs each host-type-stripped
 * TypeScript program and bridges bindings over its message port. This is
 * containment, not a security boundary: model code has bash-equivalent trust
 * despite an empty environment, a heap cap, measured event-loop busy-time and
 * wall-time budgets, a hard outer-output ledger, and termination that also
 * stops synchronous loops (dsh code-runtime-worker-thread shape, Hadamard-owned).
 *
 * @module src/codeact/workerThreadCodeRuntime
 */
import { stripTypeScriptTypes } from 'node:module';
import { Worker } from 'node:worker_threads';

import {
  snapshotCodeJsonValue,
  validateCodeBindingNamespace,
  type CodeBindingNamespace,
  type CodeJsonValue,
  type CodeRunFailure,
  type CodeRunRequest,
  type CodeRunResult,
  type CodeRuntime,
} from './codeRuntime.js';

export interface WorkerThreadCodeRuntimeOptions {
  /** Busy-time budget: the run fails once measured event-loop active time exceeds this. */
  computeMs?: number;
  /** Wall-clock ceiling; the backstop for promises nobody resolves. */
  maxWallMs?: number;
  /** Hard cap for the serialized logs/completion/failure payloads. */
  maxOutputBytes?: number;
  /** Worker max old-generation heap in MiB; overflow surfaces as worker-exit. */
  maxOldGenerationSizeMb?: number;
}

const DEFAULT_COMPUTE_MS = 60_000;
const DEFAULT_MAX_WALL_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 67_108_864;
const DEFAULT_MAX_OLD_GENERATION_SIZE_MB = 512;
const ELU_POLL_INTERVAL_MS = 25;
const STRIP_WRAP = { prefix: 'async function __hadamard_program__() {\n', suffix: '\n}' } as const;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface LiveRun {
  worker: Worker;
  settle(failure: CodeRunFailure): void;
  finished: Promise<void>;
}

/** The runtime's own outer-output ledger; binding values never enter it. */
class OutputLedger {
  private bytes = 2; // JSON serialization of the empty logs array: []
  private readonly entries: string[] = [];

  constructor(private readonly maxBytes: number) {}

  admit(text: string): boolean {
    const separatorBytes = this.entries.length > 0 ? 1 : 0;
    const stringBytes = Buffer.byteLength(JSON.stringify(text), 'utf8');
    if (this.bytes + stringBytes + separatorBytes > this.maxBytes) return false;
    this.bytes += stringBytes + separatorBytes;
    this.entries.push(text);
    return true;
  }

  success(logs: string[], value?: CodeJsonValue): CodeRunResult {
    const valueBytes = value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (this.bytes + valueBytes > this.maxBytes) return this.limit(logs);
    return { logs, ...(value !== undefined ? { value } : {}) };
  }

  failure(logs: string[], error: CodeRunFailure): CodeRunResult {
    const messageBytes = Buffer.byteLength(JSON.stringify(error.message), 'utf8');
    if (this.bytes + messageBytes > this.maxBytes) return this.limit(logs);
    return { logs, error };
  }

  limit(logs: string[]): CodeRunResult {
    return { logs, error: { kind: 'output-limit', message: `outer output exceeded ${this.maxBytes} bytes` } };
  }
}

/**
 * The shipped TypeScript backend. Every cap comes from validated options;
 * each run executes in a fresh worker with an empty environment.
 */
export class WorkerThreadCodeRuntime implements CodeRuntime {
  readonly language = 'typescript';
  readonly isolation = 'worker-thread';

  private readonly config: Required<WorkerThreadCodeRuntimeOptions>;
  private readonly live = new Set<LiveRun>();
  private disposed = false;

  constructor(options: WorkerThreadCodeRuntimeOptions = {}) {
    this.config = {
      computeMs: options.computeMs ?? DEFAULT_COMPUTE_MS,
      maxWallMs: options.maxWallMs ?? DEFAULT_MAX_WALL_MS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      maxOldGenerationSizeMb: options.maxOldGenerationSizeMb ?? DEFAULT_MAX_OLD_GENERATION_SIZE_MB,
    };
    for (const [key, value] of Object.entries(this.config)) {
      if (!(Number.isFinite(value) && value > 0)) {
        throw new Error(`worker-thread code runtime: config.${key} must be a positive number, got ${String(value)}`);
      }
    }
  }

  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (this.disposed) {
      throw new Error('worker-thread code runtime: run() after disposal');
    }
    const seenGlobals = new Set<string>();
    for (const namespace of request.bindings) {
      validateCodeBindingNamespace(namespace);
      if (seenGlobals.has(namespace.global)) {
        throw new Error(`worker-thread code runtime: duplicate binding global ${JSON.stringify(namespace.global)}`);
      }
      seenGlobals.add(namespace.global);
    }
    if (request.signal?.aborted) {
      return { logs: [], error: { kind: 'abort', message: String(request.signal.reason) } };
    }
    let code: string;
    try {
      // Strip host-side so a syntax error never spawns a worker; the wrap
      // makes top-level await/return legal (strip is position-preserving).
      const stripped = stripTypeScriptTypes(STRIP_WRAP.prefix + request.program + STRIP_WRAP.suffix);
      code = stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length);
    } catch (error) {
      return { logs: [], error: { kind: 'exception', message: messageOf(error) } };
    }
    return this.execute(code, request.bindings, request.signal);
  }

  /** Dispose to quiescence: fail every in-flight run as aborted and await each worker exit. */
  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const runs = [...this.live];
    for (const run of runs) run.settle({ kind: 'abort', message: 'runtime disposed' });
    await Promise.all(runs.map((run) => run.finished));
  }

  private execute(code: string, bindings: CodeBindingNamespace[], signal?: AbortSignal): Promise<CodeRunResult> {
    const worker = new Worker(WORKER_THREAD_CODE_PROGRAM, {
      eval: true,
      workerData: {
        code,
        namespaces: bindings.map((namespace) => ({
          global: namespace.global,
          names: Object.keys(namespace.functions),
          ...(namespace.errorClass ? { errorClass: namespace.errorClass } : {}),
        })),
        maxOutputBytes: this.config.maxOutputBytes,
      },
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: this.config.maxOldGenerationSizeMb },
    });

    return new Promise<CodeRunResult>((resolve) => {
      let settled = false;
      const output = new OutputLedger(this.config.maxOutputBytes);
      const logs: string[] = [];
      const answered = new Set<number>();
      let terminalOverride: CodeRunResult | undefined;

      let finishResolve!: () => void;
      const finished = new Promise<void>((done) => { finishResolve = done; });
      const finish = (finalize: CodeRunResult | (() => CodeRunResult)): void => {
        if (settled) return;
        settled = true;
        clearInterval(eluTimer);
        clearTimeout(wallTimer);
        signal?.removeEventListener('abort', onAbort);
        this.live.delete(live);
        void worker.terminate().then(() => {
          const result = terminalOverride ?? (typeof finalize === 'function' ? finalize() : finalize);
          finishResolve();
          resolve(result);
        });
      };

      const onMessage = (raw: unknown): void => {
        if (!raw || typeof raw !== 'object') return;
        const message = raw as Record<string, unknown>;
        if (message.type === 'log') {
          if (settled || typeof message.text !== 'string') return;
          if (!output.admit(message.text)) {
            const limited = output.limit([...logs, message.text]);
            terminalOverride = limited;
            finish(limited);
          } else {
            logs.push(message.text);
          }
          return;
        }
        if (message.type === 'output-limit') {
          if (settled) return;
          const limited = output.limit(logs);
          terminalOverride = limited;
          finish(limited);
          return;
        }
        if (message.type === 'call') {
          if (settled) return;
          const id = message.id;
          if (typeof id !== 'number' || answered.has(id)) return;
          answered.add(id);
          const globalName = typeof message.global === 'string' ? message.global : '';
          const memberName = typeof message.name === 'string' ? message.name : '';
          const namespace = bindings.find((entry) => entry.global === globalName);
          const fn = namespace && Object.hasOwn(namespace.functions, memberName)
            ? namespace.functions[memberName]
            : undefined;
          if (typeof fn !== 'function') {
            void worker.postMessage({ type: 'reply', id, ok: false, message: `unknown binding ${JSON.stringify(`${globalName}.${memberName}`)}` });
            return;
          }
          const args = snapshotCodeJsonValue(message.args);
          if (args === undefined) {
            void worker.postMessage({ type: 'reply', id, ok: false, message: 'binding arguments must be lossless JSON' });
            return;
          }
          void (async () => {
            try {
              const resolved = await fn(args);
              const value = snapshotCodeJsonValue(resolved);
              if (value === undefined) {
                void worker.postMessage({ type: 'reply', id, ok: false, message: 'binding resolution must be lossless JSON' });
              } else {
                void worker.postMessage({ type: 'reply', id, ok: true, value });
              }
            } catch (error) {
              void worker.postMessage({ type: 'reply', id, ok: false, message: messageOf(error) });
            }
          })();
          return;
        }
        if (message.type === 'done') {
          if (settled) return;
          const doneLogs = Array.isArray(message.logs)
            ? message.logs.filter((entry): entry is string => typeof entry === 'string')
            : [];
          if (message.error) {
            const failure = message.error as Record<string, unknown>;
            const kind = failure.kind === 'exception' || failure.kind === 'invalid-output' || failure.kind === 'output-limit'
              ? failure.kind
              : 'exception';
            finish(() => output.failure([...logs, ...doneLogs], { kind, message: typeof failure.message === 'string' ? failure.message : 'program failed' }));
            return;
          }
          const value = snapshotCodeJsonValue(message.value);
          if (value === undefined) {
            finish(() => output.failure([...logs, ...doneLogs], { kind: 'invalid-output', message: 'program completion must be lossless JSON' }));
          } else {
            finish(() => output.success([...logs, ...doneLogs], value));
          }
        }
      };
      worker.on('message', onMessage);
      worker.on('error', (error) => {
        finish(() => output.failure(logs, { kind: 'worker-exit', message: `worker error: ${error.message}` }));
      });
      worker.on('exit', (exitCode) => {
        if (!settled) {
          finish(() => output.failure(logs, { kind: 'worker-exit', message: `worker exited with code ${exitCode} before completing` }));
        }
      });

      // Compute budget: the worker's own measured busy time, so a hot loop
      // expires it while a program awaiting a slow binding accrues nothing.
      const eluTimer = setInterval(() => {
        const elu = worker.performance.eventLoopUtilization();
        if (elu.active > this.config.computeMs) {
          finish(() => output.failure(logs, { kind: 'timeout', message: `compute budget exhausted (${this.config.computeMs}ms busy)` }));
        }
      }, ELU_POLL_INTERVAL_MS);
      const wallTimer = setTimeout(() => {
        finish(() => output.failure(logs, { kind: 'timeout', message: `wall-clock ceiling reached (${this.config.maxWallMs}ms)` }));
      }, this.config.maxWallMs);
      const onAbort = (): void => {
        finish(() => output.failure(logs, { kind: 'abort', message: String(signal?.reason) }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const live: LiveRun = {
        worker,
        settle: (failure) => { finish(() => output.failure(logs, failure)); },
        finished,
      };
      this.live.add(live);
    });
  }
}

/** Inline worker entry (plain JS, no imports): executes one program against bridged bindings. */
export const WORKER_THREAD_CODE_PROGRAM = "'use strict';\nconst { parentPort, workerData } = require('node:worker_threads');\nconst { inspect } = require('node:util');\nconst code = workerData.code;\nconst namespaceSpecs = workerData.namespaces;\nconst maxOutputBytes = workerData.maxOutputBytes;\n\nlet logsBytes = 2;\nconst logs = [];\nlet limitHit = false;\nfunction jsonBytes(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }\nfunction pushLog(text) {\n  if (limitHit) return;\n  const separator = logs.length > 0 ? 1 : 0;\n  if (logsBytes + jsonBytes(text) + separator > maxOutputBytes) {\n    limitHit = true;\n    parentPort.postMessage({ type: 'output-limit' });\n    return;\n  }\n  logsBytes += jsonBytes(text) + separator;\n  logs.push(text);\n}\nconst consoleShim = Object.create(null);\nfor (const level of ['log', 'info', 'warn', 'error', 'debug']) {\n  consoleShim[level] = function () {\n    pushLog(Array.prototype.map.call(arguments, function (arg) {\n      return typeof arg === 'string' ? arg : inspect(arg);\n    }).join(' '));\n  };\n}\n\nlet nextId = 0;\nconst pending = new Map();\nconst globals = Object.create(null);\nfunction makeNamespace(spec) {\n  const target = Object.create(null);\n  for (const name of spec.names) {\n    target[name] = async function (args) {\n      const id = ++nextId;\n      return new Promise(function (resolve, reject) {\n        pending.set(id, { spec: spec, name: name, resolve: resolve, reject: reject });\n        parentPort.postMessage({ type: 'call', id: id, global: spec.global, name: name, args: args });\n      });\n    };\n  }\n  return target;\n}\nfor (const spec of namespaceSpecs) {\n  globals[spec.global] = makeNamespace(spec);\n}\nfor (const spec of namespaceSpecs) {\n  if (!spec.errorClass) continue;\n  const errorClass = class extends Error {\n    constructor(message) {\n      super(message);\n      this.name = spec.errorClass.name;\n    }\n  };\n  globals[spec.errorClass.name] = errorClass;\n}\n\nparentPort.on('message', function (raw) {\n  if (!raw || typeof raw !== 'object' || raw.type !== 'reply') return;\n  const entry = pending.get(raw.id);\n  if (!entry) return;\n  pending.delete(raw.id);\n  if (raw.ok) {\n    entry.resolve(raw.value);\n    return;\n  }\n  const spec = entry.spec;\n  let error;\n  if (spec.errorClass && globals[spec.errorClass.name]) {\n    error = new globals[spec.errorClass.name](raw.message);\n    error[spec.errorClass.memberNameProperty] = entry.name;\n  } else {\n    error = new Error(raw.message);\n  }\n  entry.reject(error);\n});\n\nconst globalsList = Object.keys(globals);\nconst globalsValues = globalsList.map(function (name) { return globals[name]; });\nconst programFactory = new Function('console', globalsList.join(','),\n  'return (async function () {\\n' + code + '\\n})();');\nprogramFactory.apply(null, [consoleShim].concat(globalsValues))\n  .then(function (value) {\n    let wire;\n    try {\n      const serialized = JSON.stringify(value);\n      if (serialized === undefined) throw new Error('undefined');\n      wire = JSON.parse(serialized);\n    } catch (error) {\n      parentPort.postMessage({ type: 'done', logs: logs, error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } });\n      return;\n    }\n    if (jsonBytes(wire) + logsBytes > maxOutputBytes) {\n      limitHit = true;\n      parentPort.postMessage({ type: 'output-limit' });\n      return;\n    }\n    parentPort.postMessage({ type: 'done', value: wire, logs: logs });\n  })\n  .catch(function (error) {\n    if (limitHit) {\n      parentPort.postMessage({ type: 'output-limit' });\n      return;\n    }\n    parentPort.postMessage({\n      type: 'done',\n      logs: logs,\n      error: { kind: 'exception', message: error && error.stack ? String(error.stack) : String(error) },\n    });\n  });";

export default WorkerThreadCodeRuntime;
