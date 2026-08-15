import { nowIso } from '../runtime/helpers.js';
import type { ToolCodeDispatchEvent } from '../events/codeActEvents.js';
import type { CodeActHostRpcRequest, CodeActHostRpcResponse } from './types.js';

/**
 * Per-cell host-RPC sub-dispatch scheduler: the same concurrency contract the
 * native tool loop applies to model tool calls, adapted for calls a code cell
 * makes against host tools (mirrors dsh code-mode's ordered driver lane).
 *
 * - Classification is re-read lazily right before each start: only an exact
 *   `true` from the classifier is parallel, everything else is exclusive
 *   (fail-closed).
 * - Ordered stages (dispatch-start event, settle event + response commit) run
 *   in submission order inside one driver lane; only the dispatch body
 *   overlaps.
 * - An exclusive call waits for the pool to drain, runs alone, and holds its
 *   barrier through commit.
 * - `drain()` stops new starts, abandons queued-unstarted calls, and waits
 *   for started calls to settle (the cell-run abort/settle semantics).
 *
 * @module src/codeact/subdispatchScheduler
 */

interface PendingEntry {
  request: CodeActHostRpcRequest;
  resolve: (response: CodeActHostRpcResponse) => void;
  reject: (error: Error) => void;
  exclusive?: boolean;
  settled?: boolean;
  parked?: { response?: CodeActHostRpcResponse; error?: Error };
  flight?: Promise<void>;
  start(): void;
  commit(): void;
  abandon(): void;
}

export interface CodeActSubdispatchOptions {
  /** Upper bound for in-flight parallel-classified sub-calls. */
  maxParallel: number;
  /** Strict-true = parallel; anything else (or a throw) is exclusive. */
  classify: (request: CodeActHostRpcRequest) => boolean;
  /** The full per-call path (permission cascade + tool body + post hooks). */
  dispatch: (request: CodeActHostRpcRequest) => Promise<CodeActHostRpcResponse>;
  /** Audit hook for structured sub-dispatch records. */
  onEvent?: (payload: ToolCodeDispatchEvent) => void | Promise<void>;
  /** Outer CodeCell tool-use id anchoring every sub-call id. */
  rootCallId: string;
}

export class CodeActSubdispatchScheduler {
  private readonly pendingQueue: PendingEntry[] = [];
  private readonly commitQueue: PendingEntry[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private exclusiveActive = false;
  private over = false;
  private driving = false;
  private driverPromise: Promise<void> = Promise.resolve();
  private wake: (() => void) | undefined;
  private readonly pendingEmits = new Set<Promise<void>>();

  constructor(private readonly options: CodeActSubdispatchOptions) {}

  /** Queue one host request; the returned promise settles at its ordered commit. */
  schedule(request: CodeActHostRpcRequest): Promise<CodeActHostRpcResponse> {
    if (this.over) {
      return Promise.reject(new Error('CodeAct run is over; host dispatch abandoned.'));
    }
    return new Promise<CodeActHostRpcResponse>((resolve, reject) => {
      const subCallId = `${this.options.rootCallId}:host:${request.id}`;
      const name = this.nameOf(request);
      const entry: PendingEntry = {
        request,
        resolve,
        reject,
        start: () => {
          this.trackEmit({
            phase: 'start',
            subCallId,
            rootCallId: this.options.rootCallId,
            name,
            ...summaryOf(request),
          });
          const body = Promise.resolve()
            .then(() => this.options.dispatch(request))
            .then(
              (response) => { entry.parked = { response }; },
              (error: unknown) => { entry.parked = { error: error instanceof Error ? error : new Error(String(error)) }; },
            )
            .then(() => {
              entry.settled = true;
              this.wakeup();
            });
          entry.flight = body;
        },
        commit: () => {
          const parked = entry.parked;
          if (parked === undefined) return;
          if (parked.error !== undefined) {
            this.trackEmit({
              phase: 'settle',
              subCallId,
              rootCallId: this.options.rootCallId,
              name,
              isError: true,
              summary: parked.error.message,
            });
            entry.reject(parked.error);
            return;
          }
          const response = parked.response;
          if (response === undefined) {
            entry.reject(new Error('CodeAct dispatch produced no response.'));
            return;
          }
          this.trackEmit({
            phase: 'settle',
            subCallId,
            rootCallId: this.options.rootCallId,
            name,
            isError: response.ok === false,
            summary: response.ok
              ? summarizeResult(response.result)
              : response.error,
          });
          entry.resolve(response);
        },
        abandon: () => {
          entry.reject(new Error('CodeAct run is over; host dispatch abandoned.'));
        },
      };
      this.pendingQueue.push(entry);
      this.wakeup();
      void this.drive();
    });
  }

  private wakeup(): void {
    const release = this.wake;
    this.wake = undefined;
    release?.();
  }

  /** Stop new starts, abandon queued-unstarted calls, and drain started ones plus their audit emissions. */
  async drain(): Promise<void> {
    this.over = true;
    this.wakeup();
    await this.drive();
    await Promise.allSettled([...this.pendingEmits]);
  }

  private nameOf(request: CodeActHostRpcRequest): string {
    if (request.method === 'tool.call') {
      const input = asRecord(request.input);
      return typeof input?.name === 'string' ? input.name : 'tool.call';
    }
    return request.method;
  }

  private classifySafe(request: CodeActHostRpcRequest): boolean {
    try {
      return this.options.classify(request) === true;
    } catch {
      return false;
    }
  }

  private async drive(): Promise<void> {
    // Re-enter the loop while work remains: a submission can race the
    // driver's quiescence exit, and a settled driver never restarts itself.
    while (true) {
      if (!this.driving) {
        this.driving = true;
        try {
          const promise = this.runDriver();
          this.driverPromise = promise;
          await promise;
        } finally {
          this.driving = false;
        }
      } else {
        await this.driverPromise;
      }
      if (this.pendingQueue.length === 0 && this.commitQueue.length === 0 && this.inFlight.size === 0) {
        return;
      }
    }
  }

  private async runDriver(): Promise<void> {
    for (;;) {
        // Commit settled head-of-line entries in submission order.
        const head = this.commitQueue[0];
        if (head !== undefined && head.settled === true) {
          this.commitQueue.shift();
          head.commit();
          if (head.exclusive) this.exclusiveActive = false;
          this.wakeup();
          continue;
        }
        const next = this.pendingQueue[0];
        if (next !== undefined) {
          if (this.over) {
            this.pendingQueue.shift();
            next.abandon();
            continue;
          }
          // Lazy fail-closed reclassification immediately before start.
          const exclusive = !this.classifySafe(next.request);
          const capacity = !this.exclusiveActive
            && (exclusive
              ? this.inFlight.size === 0 && this.commitQueue.length === 0
              : this.inFlight.size < Math.max(1, Math.trunc(this.options.maxParallel) || 1));
          if (capacity) {
            this.pendingQueue.shift();
            next.exclusive = exclusive;
            if (exclusive) this.exclusiveActive = true;
            this.commitQueue.push(next);
            next.start();
            if (next.flight) {
              const flight = next.flight.finally(() => {
                this.inFlight.delete(flight);
                this.wakeup();
              });
              this.inFlight.add(flight);
            }
            continue;
          }
        }
        if (this.pendingQueue.length === 0 && this.commitQueue.length === 0 && this.inFlight.size === 0) {
          return;
        }
        // Sleep on an explicit wake (settle, commit, submission, or drain)
        // instead of racing an in-flight set that can be empty while an
        // exclusive call waits for the commit lane to drain.
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }

  private trackEmit(
    payload: Omit<ToolCodeDispatchEvent, 'type' | 'runId' | 'iteration' | 'timestamp'>,
  ): void {
    const promise = this.emit(payload);
    this.pendingEmits.add(promise);
    void promise
      .catch(() => undefined)
      .finally(() => this.pendingEmits.delete(promise));
  }

  private async emit(
    payload: Omit<ToolCodeDispatchEvent, 'type' | 'runId' | 'iteration' | 'timestamp'>,
  ): Promise<void> {
    try {
      await this.options.onEvent?.({
        type: 'tool.code_dispatch',
        runId: '',
        iteration: 0,
        ...payload,
        timestamp: nowIso(),
      });
    } catch {
      // Audit observers can never break dispatch ordering.
    }
  }
}


function summaryOf(request: CodeActHostRpcRequest): { summary?: string } {
  if (request.method !== 'tool.call') return {};
  const input = asRecord(request.input);
  if (input === undefined) return {};
  const trimmed = summarizeResult(input);
  return trimmed === undefined ? {} : { summary: trimmed };
}

function summarizeResult(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}...` : value;
  try {
    const text = JSON.stringify(value);
    return text.length > 240 ? `${text.slice(0, 240)}...` : text;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
