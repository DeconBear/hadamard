import { randomUUID } from 'node:crypto';

import type { UsageFilter, UsagePage, UsageSummary, BudgetPolicy } from '../usage/contracts.js';
import { UsageQueryService } from '../usage/usageQueryService.js';
import { probeKeywayNativeTargetAuth } from './keywayProviderExecutor.js';
import type { KeywayMigrationService } from './keywayMigrationService.js';
import type {
  KeywayExecutionTargetPort,
  KeywayGatewayRoutePort,
  KeywayManagedCredentialPort,
  KeywayProviderExecutorPort,
  KeywaySecretStorePort,
  KeywayStorePort,
} from './keywayPorts.js';

export interface UsageTrendPoint {
  date: string;
  requests: number;
  tokens: number;
  costUsd: number;
}

export interface UsageRoutingOverview {
  summary: UsageSummary;
  trend: readonly UsageTrendPoint[];
  byProvider: readonly { key: string; requests: number; tokens: number; costUsd: number }[];
  unknownUsageEntries: number;
}

export interface UsageRoutingCatalog {
  targets: readonly KeywayExecutionTargetPort[];
  routes: readonly KeywayGatewayRoutePort[];
  budgets: readonly BudgetPolicy[];
  credentials: ReadonlyArray<Omit<KeywayManagedCredentialPort, 'secretRef'> & {
    secretConfigured: boolean;
    health: Awaited<ReturnType<KeywayStorePort['getCredentialHealth']>>;
  }>;
}

export interface ProviderPresetInstallResult {
  preset: 'ark-agent-plan';
  credentialId: string;
  targetId: string;
  routeAliases: readonly string[];
}

export interface UsageRoutingAdminServiceOptions {
  homeDir: string;
  store: KeywayStorePort;
  secretStore: KeywaySecretStorePort;
  executor?: KeywayProviderExecutorPort;
  gateway?: {
    status(): object;
    start(port?: number): Promise<object>;
    stop(): Promise<object>;
  };
  migration?: KeywayMigrationService;
  now?: () => Date;
  idFactory?: () => string;
}

/** Host-owned admin facade. No method returns secret values or prompt content. */
export class UsageRoutingAdminService {
  private constructor(
    private readonly usage: UsageQueryService,
    private readonly options: UsageRoutingAdminServiceOptions,
  ) {}

  static async open(options: UsageRoutingAdminServiceOptions): Promise<UsageRoutingAdminService> {
    return new UsageRoutingAdminService(await UsageQueryService.open(options.homeDir), options);
  }

  overview(filter: UsageFilter = {}): UsageRoutingOverview {
    const summary = this.usage.summary(filter);
    const events = this.usage.events({ ...filter, limit: 10_000 });
    const trend = new Map<string, UsageTrendPoint>();
    const providers = new Map<string, UsageTrendPoint>();
    let unknownUsageEntries = 0;
    for (const event of events) {
      if (event.usage.accuracy === 'unknown') unknownUsageEntries += 1;
      accumulate(trend, event.timestamp.slice(0, 10), event);
      accumulate(providers, event.providerId ?? 'Unattributed', event);
    }
    return {
      summary,
      trend: [...trend.values()].sort((left, right) => left.date.localeCompare(right.date)),
      byProvider: [...providers.values()]
        .map(point => ({ key: point.date, requests: point.requests, tokens: point.tokens, costUsd: point.costUsd }))
        .sort((left, right) => right.tokens - left.tokens),
      unknownUsageEntries,
    };
  }

  ledger(page: UsagePage = {}) {
    return { summary: this.usage.summary(page), events: this.usage.events(page) };
  }

  async catalog(): Promise<UsageRoutingCatalog> {
    const [targets, routes, budgets, credentials] = await Promise.all([
      this.options.store.listTargets(),
      this.options.store.listRoutes(),
      this.options.store.listManagedBudgetPolicies(),
      this.options.store.listManagedCredentials(),
    ]);
    return {
      targets,
      routes,
      budgets,
      credentials: await Promise.all(credentials.map(async ({ secretRef, ...credential }) => ({
        ...credential,
        secretConfigured: await this.options.secretStore.has(secretRef),
        health: await this.options.store.getCredentialHealth(credential.id),
      }))),
    };
  }

  async saveCredential(input: Record<string, unknown>): Promise<{ id: string }> {
    const id = identifier(input.id, 'credential id', this.id());
    const existing = (await this.options.store.listManagedCredentials()).find(item => item.id === id);
    const providerId = identifier(input.providerId ?? existing?.providerId, 'provider id');
    const secretRef = existing?.secretRef ?? `secret:${id}`;
    const secret = optionalString(input.secret);
    if (!existing && !secret) throw new TypeError('A new managed credential requires a secret.');
    const previousSecret = secret && existing
      ? await this.options.secretStore.resolve(secretRef)
      : undefined;
    if (secret) await this.options.secretStore.put(secretRef, secret);
    const now = this.now().toISOString();
    try {
      this.options.store.saveCredential({
        id,
        providerId,
        secretRef,
        label: optionalString(input.label) ?? existing?.label ?? id,
        priority: integer(input.priority, existing?.priority ?? 0, 0),
        weight: integer(input.weight, existing?.weight ?? 1, 1),
        enabled: boolean(input.enabled, existing?.enabled ?? true),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    } catch (error) {
      if (secret) {
        try {
          if (previousSecret === undefined) await this.options.secretStore.remove(secretRef);
          else await this.options.secretStore.put(secretRef, previousSecret);
        } catch {
          // Preserve the metadata failure; secure-store recovery is best effort.
        }
      }
      throw error;
    }
    return { id };
  }

  async deleteCredential(id: string): Promise<boolean> {
    const credential = (await this.options.store.listManagedCredentials()).find(item => item.id === id);
    if (!credential) return false;
    const deleted = this.options.store.deleteCredential(id);
    if (deleted) await this.options.secretStore.remove(credential.secretRef);
    return deleted;
  }

  async installArkAgentPlan(input: Record<string, unknown>): Promise<ProviderPresetInstallResult> {
    const secret = optionalString(input.secret);
    const existing = (await this.options.store.listManagedCredentials())
      .find(item => item.id === 'credential.ark-agent-plan');
    if (!secret && !existing) throw new TypeError('Ark API key is required for the initial setup.');
    await this.saveCredential({
      id: 'credential.ark-agent-plan',
      providerId: 'ark-agent-plan',
      label: 'Volcengine Ark Agent Plan',
      ...(secret ? { secret } : {}),
      priority: 0,
      weight: 1,
      enabled: true,
    });
    this.saveTarget({
      id: 'target.ark-agent-plan',
      kind: 'managed-api',
      providerId: 'ark-agent-plan',
      protocol: 'openai',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      enabled: true,
    });
    for (const model of ['glm-5.2', 'glm-5.3'] as const) {
      await this.saveRoute({
        id: `route.ark-${model}`,
        alias: `ark-${model}`,
        mode: 'direct',
        enabled: true,
        candidates: [{
          id: `route.ark-${model}.candidate.1`,
          targetId: 'target.ark-agent-plan',
          upstreamModel: model,
          priority: 0,
          weight: 1,
          enabled: true,
        }],
      });
    }
    return {
      preset: 'ark-agent-plan',
      credentialId: 'credential.ark-agent-plan',
      targetId: 'target.ark-agent-plan',
      routeAliases: ['ark-glm-5.2', 'ark-glm-5.3'],
    };
  }

  saveTarget(input: Record<string, unknown>): { id: string } {
    const id = identifier(input.id, 'target id', this.id());
    const kind = input.kind === 'native-cli' ? 'native-cli' : input.kind === 'managed-api' ? 'managed-api' : undefined;
    if (!kind) throw new TypeError('target kind must be managed-api or native-cli.');
    const enabled = boolean(input.enabled, true);
    if (kind === 'managed-api') {
      const protocol = input.protocol === 'anthropic' ? 'anthropic' : input.protocol === 'openai' ? 'openai' : undefined;
      if (!protocol) throw new TypeError('managed target protocol must be openai or anthropic.');
      this.options.store.saveTarget({
        kind,
        id,
        providerId: identifier(input.providerId, 'provider id'),
        protocol,
        baseUrl: httpUrl(input.baseUrl),
        enabled,
      });
    } else {
      this.options.store.saveTarget({
        kind,
        id,
        runtime: identifier(input.runtime, 'runtime'),
        enabled,
        ...(optionalString(input.profileName) ? { profileName: optionalString(input.profileName) } : {}),
        ...(optionalString(input.configId) ? { configId: optionalString(input.configId) } : {}),
      });
    }
    return { id };
  }

  deleteTarget(id: string): boolean {
    return this.options.store.deleteTarget(id);
  }

  async saveRoute(input: Record<string, unknown>): Promise<{ id: string }> {
    const id = identifier(input.id, 'route id', this.id());
    const existing = (await this.options.store.listRoutes()).find(item => item.id === id);
    if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
      throw new TypeError('A route requires at least one candidate.');
    }
    const now = this.now().toISOString();
    const route: KeywayGatewayRoutePort = {
      id,
      alias: identifier(input.alias, 'route alias'),
      mode: input.mode === 'priority-failover' ? 'priority-failover' : 'direct',
      enabled: boolean(input.enabled, true),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      candidates: input.candidates.map((value, index) => {
        const candidate = record(value, `candidate ${index + 1}`);
        return {
          id: identifier(candidate.id, 'candidate id', `${id}.candidate.${index + 1}`),
          targetId: identifier(candidate.targetId, 'candidate target id'),
          upstreamModel: text(candidate.upstreamModel, 'upstream model'),
          priority: integer(candidate.priority, index, 0),
          weight: integer(candidate.weight, 1, 1),
          enabled: boolean(candidate.enabled, true),
        };
      }),
    };
    this.options.store.saveRoute(route);
    return { id };
  }

  deleteRoute(id: string): boolean {
    return this.options.store.deleteRoute(id);
  }

  saveBudget(input: Record<string, unknown>): { id: string } {
    const id = identifier(input.id, 'budget id', this.id());
    const scopeKind = input.scopeKind;
    const scope: BudgetPolicy['scope'] | undefined = scopeKind === 'global'
      ? { kind: 'global' as const }
      : scopeKind === 'provider' || scopeKind === 'credential' || scopeKind === 'route' || scopeKind === 'model'
        ? { kind: scopeKind, id: identifier(input.scopeId, 'scope id') }
        : undefined;
    if (!scope) throw new TypeError('Unsupported budget scope.');
    const period = input.period === 'daily' || input.period === 'monthly' || input.period === 'lifetime'
      ? input.period : undefined;
    const metric = input.metric === 'requests' || input.metric === 'totalTokens' || input.metric === 'costUsd'
      ? input.metric : undefined;
    const action = input.action === 'warn' || input.action === 'deny' || input.action === 'fallbackRoute'
      ? input.action : undefined;
    if (!period || !metric || !action) throw new TypeError('Unsupported budget period, metric, or action.');
    const limit = positiveNumber(input.limit, 'budget limit');
    this.options.store.saveBudgetPolicy({
      id,
      scope,
      period,
      metric,
      limit,
      action,
      enabled: boolean(input.enabled, true),
      ...(action === 'fallbackRoute'
        ? { fallbackRouteId: identifier(input.fallbackRouteId, 'fallback route id') }
        : {}),
    });
    return { id };
  }

  deleteBudget(id: string): boolean {
    return this.options.store.deleteBudgetPolicy(id);
  }

  async testCredential(id: string): Promise<Record<string, unknown>> {
    const credential = (await this.options.store.listManagedCredentials()).find(item => item.id === id);
    if (!credential) throw new TypeError('Credential not found.');
    const secret = await this.options.secretStore.resolve(credential.secretRef);
    if (!secret) return { id, state: 'missing' };
    if (!this.options.executor) return { id, state: 'configured', tested: false };
    const targets = (await this.options.store.listTargets()).filter(target => (
      target.kind === 'managed-api' && target.providerId === credential.providerId && target.enabled
    ));
    const routes = await this.options.store.listRoutes();
    const target = targets[0];
    const candidate = target && routes.flatMap(route => route.candidates).find(item => item.targetId === target.id);
    if (!target || !candidate) return { id, state: 'configured', tested: false, reason: 'No enabled route candidate uses this provider.' };
    try {
      const result = await this.options.executor.execute({
        requestId: this.id(),
        correlationId: this.id(),
        operation: 'generate',
        target,
        upstreamModel: candidate.upstreamModel,
        credential: { id, secret },
        payload: {
          modelRequest: {
            model: candidate.upstreamModel,
            messages: [{ role: 'user', content: 'Reply OK.' }],
            max_tokens: 1,
          },
        },
      }).result;
      return { id, state: 'healthy', tested: true, statusCode: result.statusCode ?? 200 };
    } catch (error) {
      return {
        id,
        state: 'degraded',
        tested: true,
        statusCode: statusCode(error),
        error: 'Credential test failed.',
      };
    }
  }

  async testTarget(id: string): Promise<Record<string, unknown>> {
    const target = (await this.options.store.listTargets()).find(item => item.id === id);
    if (!target) throw new TypeError('Target not found.');
    if (target.kind === 'managed-api') return { id, state: 'configured', source: 'managed-api' };
    const status = await probeKeywayNativeTargetAuth(target);
    return { id, ...status };
  }

  gatewayStatus(): Record<string, unknown> {
    return this.options.gateway ? { ...this.options.gateway.status() } : { running: false, authentication: 'client-key' };
  }

  async startGateway(port = 0): Promise<Record<string, unknown>> {
    if (!this.options.gateway) throw new TypeError('The optional Keyway loopback gateway is unavailable.');
    return { ...(await this.options.gateway.start(port)) };
  }

  async stopGateway(): Promise<Record<string, unknown>> {
    if (!this.options.gateway) return this.gatewayStatus();
    return { ...(await this.options.gateway.stop()) };
  }

  previewBridgeMigration() {
    if (!this.options.migration) throw new TypeError('Keyway migration service is unavailable.');
    return this.options.migration.previewBridgeConfigs();
  }

  async importBridgeMigration(): Promise<Record<string, unknown>> {
    if (!this.options.migration) throw new TypeError('Keyway migration service is unavailable.');
    return this.options.migration.importBridgeConfigs();
  }

  async previewPortableMigration(filePath: string) {
    if (!this.options.migration) throw new TypeError('Keyway migration service is unavailable.');
    return this.options.migration.previewPortableFile(filePath);
  }

  async importPortableMigration(filePath: string): Promise<Record<string, unknown>> {
    if (!this.options.migration) throw new TypeError('Keyway migration service is unavailable.');
    return this.options.migration.importPortableFile(filePath);
  }

  close(): void {
    this.usage.close();
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private id(): string {
    return this.options.idFactory?.() ?? randomUUID();
  }
}

function accumulate(
  map: Map<string, UsageTrendPoint>,
  key: string,
  event: ReturnType<UsageQueryService['events']>[number],
): void {
  const point = map.get(key) ?? { date: key, requests: 0, tokens: 0, costUsd: 0 };
  point.requests += event.usage.requests;
  point.tokens += event.usage.totalTokens;
  point.costUsd += event.usage.costUsd ?? 0;
  map.set(key, point);
}

function identifier(value: unknown, name: string, fallback?: string): string {
  const result = optionalString(value) ?? fallback;
  if (!result || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(result)) {
    throw new TypeError(`${name} must contain only letters, numbers, dot, underscore, colon, or hyphen.`);
  }
  return result;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function httpUrl(value: unknown): string {
  const url = new URL(text(value, 'base URL'));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('base URL must use HTTP or HTTPS.');
  return url.toString().replace(/\/$/u, '');
}

function integer(value: unknown, fallback: number, minimum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new TypeError(`Expected an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number.`);
  }
  return value;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { statusCode?: unknown; status?: unknown }).statusCode
    ?? (error as { status?: unknown }).status;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function usageFilterFromSearch(search: URLSearchParams): UsagePage {
  const filter: UsagePage = {};
  for (const field of ['from', 'to', 'providerId', 'credentialId', 'routeId', 'model', 'projectId', 'agentId', 'sessionId', 'runId'] as const) {
    const value = search.get(field);
    if (value) filter[field] = value;
  }
  const source = search.get('source');
  if (source === 'hadamard' || source === 'bridge' || source === 'keyway' || source === 'native-cli' || source === 'import') filter.source = source;
  const status = search.get('status');
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'denied') filter.status = status;
  const limit = Number(search.get('limit'));
  const offset = Number(search.get('offset'));
  if (Number.isInteger(limit) && limit > 0) filter.limit = Math.min(limit, 1000);
  if (Number.isInteger(offset) && offset >= 0) filter.offset = offset;
  return filter;
}
