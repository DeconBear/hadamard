import {
  CredentialPool,
} from './credentialPool.js';
import type {
  BudgetDecision,
  BudgetReservation,
  ExecutionTarget,
  GatewayRoute,
  GatewayRouteCandidate,
  JsonValue,
  KeywayCore,
  KeywayCoreOptions,
  KeywayExecutionHandle,
  KeywayExecutionRequest,
  KeywayExecutionResult,
  KeywayStreamEvent,
  ManagedCredential,
  ProviderExecutionHandle,
  RouteAttempt,
  UsageCounters,
  UsageEventV2,
} from './contracts.js';

export type KeywayExecutionErrorCode =
  | 'route-not-found'
  | 'route-disabled'
  | 'target-unavailable'
  | 'credential-unavailable'
  | 'budget-denied'
  | 'budget-fallback-cycle'
  | 'provider-failed'
  | 'cancelled';

export class KeywayExecutionError extends Error {
  constructor(
    readonly code: KeywayExecutionErrorCode,
    message: string,
    readonly options: {
      statusCode?: number;
      retryable?: boolean;
      attempts?: readonly RouteAttempt[];
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'KeywayExecutionError';
  }
}

export function createKeywayCore(options: KeywayCoreOptions): KeywayCore {
  const credentialPool = new CredentialPool();
  return {
    execute(request: KeywayExecutionRequest): KeywayExecutionHandle {
      return new CoreExecutionHandle(options, credentialPool, request);
    },
  };
}

class CoreExecutionHandle implements KeywayExecutionHandle {
  readonly result: Promise<KeywayExecutionResult>;
  private readonly events = new AsyncEventQueue<KeywayStreamEvent>();
  private readonly controller = new AbortController();
  private providerHandle: ProviderExecutionHandle | undefined;

  constructor(
    private readonly options: KeywayCoreOptions,
    private readonly credentialPool: CredentialPool,
    private readonly request: KeywayExecutionRequest,
  ) {
    if (request.signal?.aborted) this.controller.abort(request.signal.reason);
    else request.signal?.addEventListener('abort', () => this.cancel(request.signal?.reason), { once: true });
    this.result = this.run().then(result => {
      this.events.finish();
      return result;
    }, error => {
      this.events.fail(error);
      throw error;
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<KeywayStreamEvent> {
    return this.events[Symbol.asyncIterator]();
  }

  cancel(reason?: unknown): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
    this.providerHandle?.cancel(reason);
  }

  private async run(): Promise<KeywayExecutionResult> {
    const startedAt = this.now();
    const attempts: RouteAttempt[] = [];
    const initialRoute = await this.options.store.transaction(transaction =>
      transaction.getRouteByAlias(this.request.routeAlias));
    if (!initialRoute) throw new KeywayExecutionError('route-not-found', `Route not found: ${this.request.routeAlias}`);
    let route: GatewayRoute = initialRoute;
    const visitedRoutes = new Set<string>();
    let lastError: unknown;
    let resolvedModel: string | undefined;
    let finalTarget: ExecutionTarget | undefined;
    let finalBudgetDecision: UsageEventV2['budgetDecision'];
    let finalUsage = zeroUsage('unknown');
    let timeToFirstTokenMs: number | undefined;

    try {
      routeLoop: while (true) {
        this.throwIfCancelled();
        if (!route.enabled) throw new KeywayExecutionError('route-disabled', `Route is disabled: ${route.alias}`);
        if (visitedRoutes.has(route.id)) {
          throw new KeywayExecutionError('budget-fallback-cycle', `Budget fallback cycle at route: ${route.id}`);
        }
        visitedRoutes.add(route.id);
        const candidates = route.candidates
          .filter(candidate => candidate.enabled)
          .sort(compareCandidates);
        if (candidates.length === 0) {
          throw new KeywayExecutionError('target-unavailable', `Route has no enabled candidates: ${route.alias}`);
        }

        for (const candidate of candidates) {
          this.throwIfCancelled();
          const target = await this.options.store.transaction(transaction => transaction.getTarget(candidate.targetId));
          if (!target?.enabled) {
            lastError = new KeywayExecutionError('target-unavailable', `Target unavailable: ${candidate.targetId}`, { retryable: true });
            continue;
          }
          const credentials = await this.credentialsFor(target);
          if (target.kind === 'managed-api' && credentials.length === 0) {
            lastError = new KeywayExecutionError(
              'credential-unavailable',
              `No healthy credential for provider: ${target.providerId}`,
              { retryable: true },
            );
            continue;
          }

          for (const credential of credentials) {
            const budget = await this.options.store.transaction(transaction => transaction.reserveBudget(
              this.request.requestId,
              this.request.estimatedUsage ?? {},
              {
                routeId: route.id,
                model: candidate.upstreamModel,
                ...(target.kind === 'managed-api' ? { providerId: target.providerId } : {}),
                ...(credential ? { credentialId: credential.id } : {}),
              },
            ));
            finalBudgetDecision = strongestBudgetDecision(budget.decisions);
            const fallback = budget.decisions.find(decision => decision.decision === 'fallback');
            if (fallback?.fallbackRouteId) {
              const fallbackRoute = await this.options.store.transaction(transaction =>
                transaction.getRouteById(fallback.fallbackRouteId!));
              if (!fallbackRoute) {
                throw new KeywayExecutionError('route-not-found', `Fallback route not found: ${fallback.fallbackRouteId}`);
              }
              route = fallbackRoute;
              continue routeLoop;
            }
            if (budget.decisions.some(decision => decision.decision === 'denied')) {
              throw new KeywayExecutionError('budget-denied', `Budget denied request: ${this.request.requestId}`);
            }

            let secret: string | undefined;
            if (credential) secret = await this.options.secretStore.resolve(credential.secretRef);
            if (credential && !secret) {
              await this.reconcile(budget.reservations, zeroUsage('unknown'));
              await this.recordCredentialFailure(credential.id, true);
              lastError = new KeywayExecutionError(
                'credential-unavailable',
                `Credential secret unavailable: ${credential.id}`,
                { retryable: true },
              );
              continue;
            }

            const attemptStarted = this.now();
            let emittedData = false;
            try {
              this.providerHandle = this.options.executor.execute({
                requestId: this.request.requestId,
                correlationId: this.request.correlationId,
                operation: this.request.operation,
                target,
                upstreamModel: candidate.upstreamModel,
                ...(credential && secret ? { credential: { id: credential.id, secret } } : {}),
                payload: this.request.payload,
                ...(this.request.metadata ? { metadata: this.request.metadata } : {}),
                signal: this.controller.signal,
              });
              const settledResult = this.providerHandle.result.then(
                value => ({ ok: true as const, value }),
                error => ({ ok: false as const, error }),
              );
              let streamError: unknown;
              try {
                for await (const event of this.providerHandle) {
                  if (event.type === 'data') {
                    emittedData = true;
                    timeToFirstTokenMs ??= this.now().getTime() - startedAt.getTime();
                  }
                  this.events.push(event);
                }
              } catch (error) {
                streamError = error;
              }
              const settled = await settledResult;
              if (streamError) throw streamError;
              if (!settled.ok) throw settled.error;
              const completedAt = this.now();
              finalUsage = settled.value.usage;
              resolvedModel = candidate.upstreamModel;
              finalTarget = target;
              attempts.push(routeAttempt(
                attempts.length + 1,
                candidate,
                target,
                credential,
                attemptStarted,
                completedAt,
                'succeeded',
                settled.value.statusCode,
              ));
              await this.reconcile(budget.reservations, finalUsage);
              if (credential) await this.recordCredentialSuccess(credential.id);
              const result: KeywayExecutionResult = {
                ...settled.value,
                requestId: this.request.requestId,
                correlationId: this.request.correlationId,
                routeId: route.id,
                attempts,
              };
              await this.appendUsageEvent({
                route,
                target,
                resolvedModel,
                usage: finalUsage,
                attempts,
                status: 'succeeded',
                ...(finalBudgetDecision ? { budgetDecision: finalBudgetDecision } : {}),
                startedAt,
                ...(timeToFirstTokenMs === undefined ? {} : { timeToFirstTokenMs }),
              });
              return result;
            } catch (error) {
              const completedAt = this.now();
              const statusCode = errorStatusCode(error);
              const retryable = isRetryableProviderError(error, statusCode);
              const failureUsage = errorUsage(error) ?? zeroUsage('unknown');
              finalUsage = failureUsage;
              resolvedModel = candidate.upstreamModel;
              finalTarget = target;
              attempts.push(routeAttempt(
                attempts.length + 1,
                candidate,
                target,
                credential,
                attemptStarted,
                completedAt,
                this.controller.signal.aborted ? 'cancelled' : 'failed',
                statusCode,
                retryable,
              ));
              await this.reconcile(budget.reservations, failureUsage);
              if (credential) await this.recordCredentialFailure(credential.id, retryable);
              lastError = error;
              if (this.controller.signal.aborted || emittedData || !retryable) throw error;
            } finally {
              this.providerHandle = undefined;
            }
          }
          if (route.mode === 'direct') break;
        }
        break;
      }
      throw normalizeFinalError(lastError, attempts);
    } catch (error) {
      const status = this.controller.signal.aborted
        ? 'cancelled'
        : error instanceof KeywayExecutionError && error.code === 'budget-denied'
          ? 'denied'
          : 'failed';
      await this.appendUsageEvent({
        route,
        ...(finalTarget ? { target: finalTarget } : {}),
        ...(resolvedModel ? { resolvedModel } : {}),
        usage: finalUsage,
        attempts,
        status,
        ...(finalBudgetDecision ? { budgetDecision: finalBudgetDecision } : {}),
        startedAt,
        ...(timeToFirstTokenMs === undefined ? {} : { timeToFirstTokenMs }),
      });
      if (status === 'cancelled') {
        throw new KeywayExecutionError('cancelled', 'Keyway execution cancelled.', { attempts, cause: error });
      }
      if (error instanceof KeywayExecutionError) throw error;
      throw normalizeFinalError(error, attempts);
    }
  }

  private async credentialsFor(target: ExecutionTarget): Promise<Array<ManagedCredential | undefined>> {
    if (target.kind === 'native-cli') return [undefined];
    return this.options.store.transaction(async transaction => {
      const remaining = [...await transaction.listCredentials(target.providerId)];
      const health = new Map(await Promise.all(remaining.map(async credential => (
        [credential.id, await transaction.getCredentialHealth(credential.id)] as const
      ))));
      const ordered: ManagedCredential[] = [];
      while (remaining.length > 0) {
        const selected = this.credentialPool.select(target.providerId, remaining, health, this.now());
        if (!selected) break;
        ordered.push(selected);
        remaining.splice(remaining.findIndex(item => item.id === selected.id), 1);
      }
      return ordered;
    });
  }

  private async reconcile(reservations: readonly BudgetReservation[], usage: UsageCounters): Promise<void> {
    if (reservations.length === 0) return;
    await this.options.store.transaction(transaction => transaction.reconcileBudget(reservations, usage));
  }

  private recordCredentialSuccess(credentialId: string): Promise<void> {
    return this.options.store.transaction(transaction =>
      transaction.recordCredentialSuccess(credentialId, this.now().toISOString()));
  }

  private recordCredentialFailure(credentialId: string, retryable: boolean): Promise<void> {
    return this.options.store.transaction(transaction =>
      transaction.recordCredentialFailure(credentialId, this.now().toISOString(), retryable));
  }

  private async appendUsageEvent(input: {
    route: GatewayRoute;
    target?: ExecutionTarget;
    resolvedModel?: string;
    usage: UsageCounters;
    attempts: readonly RouteAttempt[];
    status: UsageEventV2['status'];
    budgetDecision?: UsageEventV2['budgetDecision'];
    startedAt: Date;
    timeToFirstTokenMs?: number;
  }): Promise<void> {
    const completedAt = this.now();
    const metadata = this.request.metadata;
    const sessionId = metadataString(metadata, 'sessionId');
    const runId = metadataString(metadata, 'runId');
    const projectId = metadataString(metadata, 'projectId');
    const agentId = metadataString(metadata, 'agentId');
    const configurationId = metadataString(metadata, 'configurationId');
    const credentialId = lastCredentialId(input.attempts);
    const event: UsageEventV2 = {
      version: 2,
      eventId: this.id(),
      requestId: this.request.requestId,
      correlationId: this.request.correlationId,
      timestamp: completedAt.toISOString(),
      source: input.target?.kind === 'native-cli' ? 'native-cli' : 'keyway',
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(configurationId ? { configurationId } : {}),
      routeId: input.route.id,
      routeAlias: input.route.alias,
      ...(input.target ? { targetId: input.target.id } : {}),
      ...(input.target?.kind === 'managed-api' ? { providerId: input.target.providerId } : {}),
      ...(credentialId ? { credentialId } : {}),
      requestedModel: this.request.requestedModel,
      ...(input.resolvedModel ? { resolvedModel: input.resolvedModel } : {}),
      operation: this.request.operation,
      status: input.status,
      usage: input.usage,
      attempts: input.attempts,
      durationMs: Math.max(0, completedAt.getTime() - input.startedAt.getTime()),
      ...(input.timeToFirstTokenMs === undefined ? {} : { timeToFirstTokenMs: input.timeToFirstTokenMs }),
      streaming: this.request.operation === 'stream',
      ...(input.budgetDecision ? { budgetDecision: input.budgetDecision } : {}),
    };
    await this.options.usageSink.append(event).catch(() => undefined);
  }

  private throwIfCancelled(): void {
    if (this.controller.signal.aborted) {
      throw new KeywayExecutionError('cancelled', 'Keyway execution cancelled.');
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private id(): string {
    return this.options.idFactory?.() ?? crypto.randomUUID();
  }
}

function compareCandidates(left: GatewayRouteCandidate, right: GatewayRouteCandidate): number {
  return left.priority - right.priority || left.id.localeCompare(right.id);
}

function routeAttempt(
  attempt: number,
  candidate: GatewayRouteCandidate,
  target: ExecutionTarget,
  credential: ManagedCredential | undefined,
  startedAt: Date,
  completedAt: Date,
  status: RouteAttempt['status'],
  statusCode?: number,
  retryable?: boolean,
): RouteAttempt {
  return {
    attempt,
    targetId: target.id,
    ...(target.kind === 'managed-api' ? { providerId: target.providerId } : {}),
    ...(credential ? { credentialId: credential.id } : {}),
    upstreamModel: candidate.upstreamModel,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    status,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(retryable === undefined ? {} : { retryable }),
    latencyMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
  };
}

function strongestBudgetDecision(decisions: readonly BudgetDecision[]): UsageEventV2['budgetDecision'] {
  if (decisions.some(item => item.decision === 'denied')) return 'denied';
  if (decisions.some(item => item.decision === 'fallback')) return 'fallback';
  if (decisions.some(item => item.decision === 'warned')) return 'warned';
  return decisions.length > 0 ? 'allowed' : undefined;
}

function errorStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = Reflect.get(error, 'statusCode') ?? Reflect.get(error, 'status');
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRetryableProviderError(error: unknown, statusCode: number | undefined): boolean {
  if (typeof error === 'object' && error !== null && typeof Reflect.get(error, 'retryable') === 'boolean') {
    return Reflect.get(error, 'retryable') as boolean;
  }
  return statusCode === undefined || statusCode === 0 || statusCode === 429 || statusCode >= 500;
}

function errorUsage(error: unknown): UsageCounters | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const usage = Reflect.get(error, 'usage');
  return isUsageCounters(usage) ? usage : undefined;
}

function isUsageCounters(value: unknown): value is UsageCounters {
  return typeof value === 'object' && value !== null
    && typeof Reflect.get(value, 'requests') === 'number'
    && typeof Reflect.get(value, 'totalTokens') === 'number'
    && typeof Reflect.get(value, 'accuracy') === 'string';
}

function normalizeFinalError(error: unknown, attempts: readonly RouteAttempt[]): KeywayExecutionError {
  if (error instanceof KeywayExecutionError) return error;
  const statusCode = errorStatusCode(error);
  return new KeywayExecutionError(
    'provider-failed',
    error instanceof Error ? error.message : 'All route candidates failed.',
    {
      ...(statusCode === undefined ? {} : { statusCode }),
      retryable: isRetryableProviderError(error, statusCode),
      attempts,
      cause: error,
    },
  );
}

function zeroUsage(accuracy: UsageCounters['accuracy']): UsageCounters {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    accuracy,
  };
}

function metadataString(
  metadata: Readonly<Record<string, JsonValue>> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

function lastCredentialId(attempts: readonly RouteAttempt[]): string | undefined {
  return attempts.at(-1)?.credentialId;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure?: unknown;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  finish(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.failure !== undefined) return Promise.reject(this.failure);
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}
