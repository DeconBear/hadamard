import { describe, expect, it } from 'vitest';

import {
  createKeywayCore,
  KeywayExecutionError,
  type BudgetContext,
  type BudgetReservation,
  type BudgetReservationOutcome,
  type CredentialHealth,
  type ExecutionTarget,
  type GatewayRoute,
  type KeywayCoreOptions,
  type KeywayStreamEvent,
  type KeywayTransaction,
  type ManagedCredential,
  type ProviderExecutionHandle,
  type ProviderExecutionRequest,
  type ProviderExecutionResult,
  type UsageCounters,
  type UsageEventV2,
} from '../src/keyway/vendor/core/index.js';

const now = '2026-08-25T10:00:00.000Z';

function usage(overrides: Partial<UsageCounters> = {}): UsageCounters {
  return {
    requests: 1,
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
    cacheReadTokens: 5,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    costUsd: 0.001,
    accuracy: 'actual',
    ...overrides,
  };
}

function route(
  id: string,
  alias: string,
  candidates: GatewayRoute['candidates'],
  mode: GatewayRoute['mode'] = candidates.length === 1 ? 'direct' : 'priority-failover',
): GatewayRoute {
  return { id, alias, mode, candidates, enabled: true, createdAt: now, updatedAt: now };
}

function target(id: string, providerId: string): ExecutionTarget {
  return {
    kind: 'managed-api',
    id,
    providerId,
    protocol: 'openai',
    baseUrl: `https://${providerId}.example.test/v1`,
    enabled: true,
  };
}

function credential(id: string, providerId: string): ManagedCredential {
  return {
    id,
    providerId,
    secretRef: `secret.${id}`,
    label: id,
    priority: 0,
    weight: 1,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

class FakeStore implements KeywayTransaction {
  readonly routes = new Map<string, GatewayRoute>();
  readonly targets = new Map<string, ExecutionTarget>();
  readonly credentials = new Map<string, ManagedCredential[]>();
  readonly health = new Map<string, CredentialHealth>();
  readonly reconciled: Array<{ reservations: readonly BudgetReservation[]; usage: UsageCounters }> = [];
  readonly successes: string[] = [];
  readonly failures: Array<{ id: string; retryable: boolean }> = [];
  budget: (context: BudgetContext) => BudgetReservationOutcome = () => ({ reservations: [], decisions: [] });

  async transaction<T>(operation: (transaction: KeywayTransaction) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async getRouteByAlias(alias: string): Promise<GatewayRoute | undefined> {
    return [...this.routes.values()].find(value => value.alias === alias);
  }

  async getRouteById(id: string): Promise<GatewayRoute | undefined> {
    return this.routes.get(id);
  }

  async getTarget(id: string): Promise<ExecutionTarget | undefined> {
    return this.targets.get(id);
  }

  async listCredentials(providerId: string): Promise<readonly ManagedCredential[]> {
    return this.credentials.get(providerId) ?? [];
  }

  async getCredentialHealth(credentialId: string): Promise<CredentialHealth | undefined> {
    return this.health.get(credentialId);
  }

  async listBudgetPolicies() { return []; }

  async reserveBudget(
    _requestId: string,
    _estimatedUsage: Partial<UsageCounters>,
    context: BudgetContext = {},
  ): Promise<BudgetReservationOutcome> {
    return this.budget(context);
  }

  async reconcileBudget(reservations: readonly BudgetReservation[], actual: UsageCounters): Promise<void> {
    this.reconciled.push({ reservations, usage: actual });
  }

  async recordCredentialSuccess(credentialId: string): Promise<void> {
    this.successes.push(credentialId);
  }

  async recordCredentialFailure(credentialId: string, _at: string, retryable: boolean): Promise<void> {
    this.failures.push({ id: credentialId, retryable });
  }
}

class FakeExecutor {
  readonly requests: ProviderExecutionRequest[] = [];
  readonly responses = new Map<string, () => ProviderExecutionHandle>();

  execute(request: ProviderExecutionRequest): ProviderExecutionHandle {
    this.requests.push(request);
    const response = this.responses.get(request.target.id);
    if (!response) throw new Error(`No response for ${request.target.id}`);
    return response();
  }
}

function handle(
  result: ProviderExecutionResult | Error,
  events: readonly KeywayStreamEvent[] = [],
): ProviderExecutionHandle {
  let cancelled = false;
  return {
    result: result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    cancel() { cancelled = true; },
    async *[Symbol.asyncIterator]() {
      if (cancelled) return;
      for (const event of events) yield event;
    },
  };
}

function providerError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

function setup() {
  const store = new FakeStore();
  const executor = new FakeExecutor();
  const events: UsageEventV2[] = [];
  const secrets = new Map<string, string>();
  let id = 0;
  const options: KeywayCoreOptions = {
    store,
    executor,
    secretStore: {
      async put(ref, value) { secrets.set(ref, value); },
      async resolve(ref) { return secrets.get(ref); },
      async has(ref) { return secrets.has(ref); },
      async remove(ref) { secrets.delete(ref); },
    },
    usageSink: { async append(event) { events.push(event); } },
    now: () => new Date(now),
    idFactory: () => `event.${++id}`,
  };
  return { store, executor, events, secrets, core: createKeywayCore(options) };
}

function request(routeAlias: string) {
  return {
    requestId: 'request.1',
    correlationId: 'correlation.1',
    routeAlias,
    requestedModel: 'chat-default',
    operation: 'stream' as const,
    payload: { messages: [{ role: 'user', content: 'hello' }] },
    estimatedUsage: { requests: 1, totalTokens: 100 },
    metadata: { configurationId: 'config.main', projectId: 'project.hash' },
  };
}

describe('createKeywayCore', () => {
  it('executes a managed direct route, forwards streaming events, and records usage', async () => {
    const fixture = setup();
    const direct = route('route.direct', 'chat-direct', [
      { id: 'candidate.1', targetId: 'target.primary', upstreamModel: 'glm-5.2', priority: 0, weight: 1, enabled: true },
    ]);
    fixture.store.routes.set(direct.id, direct);
    fixture.store.targets.set('target.primary', target('target.primary', 'ark'));
    fixture.store.credentials.set('ark', [credential('credential.ark', 'ark')]);
    fixture.secrets.set('secret.credential.ark', 'secret-value');
    fixture.executor.responses.set('target.primary', () => handle(
      { output: { text: 'ok' }, usage: usage(), statusCode: 200 },
      [{ type: 'data', value: { delta: 'ok' } }, { type: 'usage', usage: usage() }],
    ));

    const execution = fixture.core.execute(request('chat-direct'));
    const streamed: KeywayStreamEvent[] = [];
    for await (const event of execution) streamed.push(event);
    const result = await execution.result;

    expect(streamed.map(event => event.type)).toEqual(['data', 'usage']);
    expect(result).toMatchObject({ routeId: 'route.direct', output: { text: 'ok' } });
    expect(fixture.executor.requests[0]).toMatchObject({
      upstreamModel: 'glm-5.2',
      credential: { id: 'credential.ark', secret: 'secret-value' },
    });
    expect(fixture.store.successes).toEqual(['credential.ark']);
    expect(fixture.events).toMatchObject([{
      source: 'keyway',
      configurationId: 'config.main',
      projectId: 'project.hash',
      routeId: 'route.direct',
      resolvedModel: 'glm-5.2',
      status: 'succeeded',
      usage: { cacheReadTokens: 5, accuracy: 'actual' },
    }]);
  });

  it('fails over on retryable 5xx errors and records credential health', async () => {
    const fixture = setup();
    const failover = route('route.failover', 'chat-failover', [
      { id: 'candidate.1', targetId: 'target.primary', upstreamModel: 'glm-5.2', priority: 0, weight: 1, enabled: true },
      { id: 'candidate.2', targetId: 'target.backup', upstreamModel: 'glm-5.3', priority: 1, weight: 1, enabled: true },
    ]);
    fixture.store.routes.set(failover.id, failover);
    fixture.store.targets.set('target.primary', target('target.primary', 'ark-primary'));
    fixture.store.targets.set('target.backup', target('target.backup', 'ark-backup'));
    fixture.store.credentials.set('ark-primary', [credential('credential.primary', 'ark-primary')]);
    fixture.store.credentials.set('ark-backup', [credential('credential.backup', 'ark-backup')]);
    fixture.secrets.set('secret.credential.primary', 'primary-secret');
    fixture.secrets.set('secret.credential.backup', 'backup-secret');
    fixture.executor.responses.set('target.primary', () => handle(providerError(503, 'temporarily unavailable')));
    fixture.executor.responses.set('target.backup', () => handle({ output: { text: 'backup' }, usage: usage() }));

    const execution = fixture.core.execute(request('chat-failover'));
    const result = await execution.result;
    expect(result.output).toEqual({ text: 'backup' });
    expect(result.attempts).toMatchObject([
      { targetId: 'target.primary', status: 'failed', statusCode: 503, retryable: true },
      { targetId: 'target.backup', status: 'succeeded' },
    ]);
    expect(fixture.store.failures).toEqual([{ id: 'credential.primary', retryable: true }]);
    expect(fixture.store.successes).toEqual(['credential.backup']);
  });

  it('stops on non-retryable 4xx errors', async () => {
    const fixture = setup();
    const failover = route('route.failover', 'chat-failover', [
      { id: 'candidate.1', targetId: 'target.primary', upstreamModel: 'glm-5.2', priority: 0, weight: 1, enabled: true },
      { id: 'candidate.2', targetId: 'target.backup', upstreamModel: 'glm-5.3', priority: 1, weight: 1, enabled: true },
    ]);
    fixture.store.routes.set(failover.id, failover);
    fixture.store.targets.set('target.primary', target('target.primary', 'ark-primary'));
    fixture.store.targets.set('target.backup', target('target.backup', 'ark-backup'));
    fixture.store.credentials.set('ark-primary', [credential('credential.primary', 'ark-primary')]);
    fixture.store.credentials.set('ark-backup', [credential('credential.backup', 'ark-backup')]);
    fixture.secrets.set('secret.credential.primary', 'primary-secret');
    fixture.secrets.set('secret.credential.backup', 'backup-secret');
    fixture.executor.responses.set('target.primary', () => handle(providerError(401, 'unauthorized')));
    fixture.executor.responses.set('target.backup', () => handle({ output: {}, usage: usage() }));

    await expect(fixture.core.execute(request('chat-failover')).result).rejects.toMatchObject({
      code: 'provider-failed',
      options: { statusCode: 401, retryable: false },
    });
    expect(fixture.executor.requests).toHaveLength(1);
  });

  it('honors deny and fallbackRoute budget decisions before provider dispatch', async () => {
    const denied = setup();
    const primary = route('route.primary', 'chat-primary', [
      { id: 'candidate.1', targetId: 'target.primary', upstreamModel: 'glm-5.2', priority: 0, weight: 1, enabled: true },
    ]);
    denied.store.routes.set(primary.id, primary);
    denied.store.targets.set('target.primary', target('target.primary', 'ark'));
    denied.store.credentials.set('ark', [credential('credential.ark', 'ark')]);
    denied.secrets.set('secret.credential.ark', 'secret');
    denied.store.budget = () => ({
      reservations: [],
      decisions: [{ policyId: 'budget.1', decision: 'denied', used: 90, reserved: 0, requested: 20, limit: 100 }],
    });
    await expect(denied.core.execute(request('chat-primary')).result)
      .rejects.toBeInstanceOf(KeywayExecutionError);
    expect(denied.executor.requests).toHaveLength(0);
    expect(denied.events[0]).toMatchObject({ status: 'denied', budgetDecision: 'denied' });

    const fallback = setup();
    const backup = route('route.backup', 'chat-backup', [
      { id: 'candidate.backup', targetId: 'target.backup', upstreamModel: 'glm-5.3', priority: 0, weight: 1, enabled: true },
    ]);
    fallback.store.routes.set(primary.id, primary);
    fallback.store.routes.set(backup.id, backup);
    fallback.store.targets.set('target.primary', target('target.primary', 'ark-primary'));
    fallback.store.targets.set('target.backup', target('target.backup', 'ark-backup'));
    fallback.store.credentials.set('ark-primary', [credential('credential.primary', 'ark-primary')]);
    fallback.store.credentials.set('ark-backup', [credential('credential.backup', 'ark-backup')]);
    fallback.secrets.set('secret.credential.primary', 'primary-secret');
    fallback.secrets.set('secret.credential.backup', 'backup-secret');
    fallback.store.budget = context => context.routeId === 'route.primary'
      ? {
          reservations: [],
          decisions: [{
            policyId: 'budget.1', decision: 'fallback', used: 90, reserved: 0,
            requested: 20, limit: 100, fallbackRouteId: 'route.backup',
          }],
        }
      : { reservations: [], decisions: [] };
    fallback.executor.responses.set('target.backup', () => handle({ output: { text: 'fallback' }, usage: usage() }));

    const fallbackResult = await fallback.core.execute(request('chat-primary')).result;
    expect(fallbackResult).toMatchObject({ routeId: 'route.backup', output: { text: 'fallback' } });
    expect(fallback.executor.requests).toHaveLength(1);
  });

  it('executes native CLI targets without resolving a managed credential', async () => {
    const fixture = setup();
    const nativeRoute = route('route.native', 'claude-native', [
      { id: 'candidate.native', targetId: 'target.claude', upstreamModel: 'claude-native', priority: 0, weight: 1, enabled: true },
    ]);
    fixture.store.routes.set(nativeRoute.id, nativeRoute);
    fixture.store.targets.set('target.claude', {
      kind: 'native-cli',
      id: 'target.claude',
      runtime: 'claude',
      profileName: 'default',
      enabled: true,
    });
    fixture.executor.responses.set('target.claude', () => handle({ output: { text: 'native' }, usage: usage() }));

    const result = await fixture.core.execute(request('claude-native')).result;
    expect(result.output).toEqual({ text: 'native' });
    expect(fixture.executor.requests[0]?.credential).toBeUndefined();
    expect(fixture.events[0]?.source).toBe('native-cli');
  });
});
