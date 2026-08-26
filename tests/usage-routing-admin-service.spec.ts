import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BudgetPolicy, UsageEventV2 } from '../src/usage/contracts.js';
import { UsageLedger } from '../src/usage/usageLedger.js';
import { usageDatabasePath } from '../src/usage/usageQueryService.js';
import type {
  KeywayCredentialHealthPort,
  KeywayExecutionTargetPort,
  KeywayGatewayRoutePort,
  KeywayManagedCredentialPort,
  KeywayProviderExecutorPort,
  KeywaySecretStorePort,
  KeywayStorePort,
} from '../src/keyway/keywayPorts.js';
import { UsageRoutingAdminService } from '../src/keyway/usageRoutingAdminService.js';

const roots: string[] = [];
const timestamp = '2026-08-25T00:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

class FakeStore implements KeywayStorePort {
  targets: KeywayExecutionTargetPort[] = [];
  routes: KeywayGatewayRoutePort[] = [];
  credentials: KeywayManagedCredentialPort[] = [];
  budgets: BudgetPolicy[] = [];
  health = new Map<string, KeywayCredentialHealthPort>();
  credentialSaveError?: Error;
  close(): void {}
  saveTarget(value: KeywayExecutionTargetPort): void { upsert(this.targets, value); }
  async listTargets() { return this.targets; }
  deleteTarget(id: string): boolean { return remove(this.targets, id); }
  saveCredential(value: KeywayManagedCredentialPort): void {
    if (this.credentialSaveError) throw this.credentialSaveError;
    upsert(this.credentials, value);
  }
  async listManagedCredentials(providerId?: string) { return providerId ? this.credentials.filter(item => item.providerId === providerId) : this.credentials; }
  deleteCredential(id: string): boolean { return remove(this.credentials, id); }
  async getCredentialHealth(id: string) { return this.health.get(id); }
  saveRoute(value: KeywayGatewayRoutePort): void { upsert(this.routes, value); }
  async listRoutes() { return this.routes; }
  deleteRoute(id: string): boolean { return remove(this.routes, id); }
  saveBudgetPolicy(value: BudgetPolicy): void { upsert(this.budgets, value); }
  async listManagedBudgetPolicies() { return this.budgets; }
  deleteBudgetPolicy(id: string): boolean { return remove(this.budgets, id); }
}

class MemorySecrets implements KeywaySecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: string, value: string) { this.values.set(ref, value); }
  async resolve(ref: string) { return this.values.get(ref); }
  async has(ref: string) { return this.values.has(ref); }
  async remove(ref: string) { this.values.delete(ref); }
}

function upsert<T extends { id: string }>(items: T[], value: T): void {
  const index = items.findIndex(item => item.id === value.id);
  if (index === -1) items.push(value); else items[index] = value;
}

function remove<T extends { id: string }>(items: T[], id: string): boolean {
  const index = items.findIndex(item => item.id === id);
  if (index === -1) return false;
  items.splice(index, 1);
  return true;
}

async function home(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'hadamard-usage-routing-'));
  roots.push(root);
  return root;
}

async function seedUsage(root: string): Promise<void> {
  const ledger = await UsageLedger.open({ filename: usageDatabasePath(root) });
  const event: UsageEventV2 = {
    version: 2,
    eventId: 'event.1',
    requestId: 'request.1',
    correlationId: 'correlation.1',
    timestamp,
    source: 'keyway',
    status: 'succeeded',
    requestedModel: 'chat-default',
    resolvedModel: 'glm-5.2',
    operation: 'generate',
    providerId: 'ark',
    routeId: 'route.chat',
    usage: {
      requests: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120,
      cacheReadTokens: 80, cacheWriteTokens: 10, reasoningTokens: 0,
      audioInputTokens: 0, audioOutputTokens: 0, costUsd: 0.02, accuracy: 'actual',
    },
    attempts: [],
    durationMs: 10,
    streaming: false,
  };
  ledger.append(event);
  ledger.close();
}

describe('UsageRoutingAdminService', () => {
  it('queries one ledger and returns chart/provider aggregates without prompts', async () => {
    const root = await home();
    await seedUsage(root);
    const service = await UsageRoutingAdminService.open({
      homeDir: root,
      store: new FakeStore(),
      secretStore: new MemorySecrets(),
    });
    expect(service.overview({ providerId: 'ark' })).toMatchObject({
      summary: { entries: 1, totalTokens: 120, cacheReadTokens: 80, costUsd: 0.02 },
      trend: [{ date: '2026-08-25', tokens: 120 }],
      byProvider: [{ key: 'ark', tokens: 120 }],
    });
    expect(JSON.stringify(service.ledger({ limit: 10 }))).not.toContain('prompt');
    service.close();
  });

  it('keeps managed secrets write-only while exposing metadata, health, and tests', async () => {
    const root = await home();
    const store = new FakeStore();
    const secrets = new MemorySecrets();
    const createMessage = vi.fn(async () => ({
      output: { type: 'message', content: [{ type: 'text', text: 'OK' }] },
      usage: {
        requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        audioInputTokens: 0, audioOutputTokens: 0, accuracy: 'actual' as const,
      },
      statusCode: 200,
    }));
    const executor: KeywayProviderExecutorPort = {
      execute() {
        return {
          result: createMessage(),
          cancel() {},
          async *[Symbol.asyncIterator]() { /* generate has no stream events */ },
        };
      },
    };
    const service = await UsageRoutingAdminService.open({
      homeDir: root, store, secretStore: secrets, executor,
      now: () => new Date(timestamp), idFactory: () => 'generated-id',
    });
    service.saveTarget({
      id: 'target.ark', kind: 'managed-api', providerId: 'ark', protocol: 'openai',
      baseUrl: 'https://ark.example.test/v1', enabled: true,
    });
    await service.saveRoute({
      id: 'route.chat', alias: 'chat', mode: 'direct', enabled: true,
      candidates: [{ id: 'candidate.1', targetId: 'target.ark', upstreamModel: 'glm-5.2', priority: 0, weight: 1, enabled: true }],
    });
    await service.saveCredential({
      id: 'credential.ark', providerId: 'ark', label: 'Primary', secret: 'secret-canary',
      priority: 0, weight: 1, enabled: true,
    });
    store.health.set('credential.ark', { credentialId: 'credential.ark', state: 'healthy', consecutiveFailures: 0 });
    const catalog = await service.catalog();
    expect(catalog.credentials).toMatchObject([{
      id: 'credential.ark', providerId: 'ark', secretConfigured: true, health: { state: 'healthy' },
    }]);
    expect(JSON.stringify(catalog)).not.toContain('secret-canary');
    expect(JSON.stringify(catalog)).not.toContain('secretRef');
    await expect(service.testCredential('credential.ark')).resolves.toMatchObject({ state: 'healthy', tested: true });
    expect(createMessage).toHaveBeenCalledOnce();
    await expect(service.deleteCredential('credential.ark')).resolves.toBe(true);
    expect(secrets.values.size).toBe(0);
    service.close();
  });

  it('restores the prior write-only secret when credential metadata cannot be saved', async () => {
    const root = await home();
    const store = new FakeStore();
    const secrets = new MemorySecrets();
    const service = await UsageRoutingAdminService.open({
      homeDir: root,
      store,
      secretStore: secrets,
      now: () => new Date(timestamp),
    });
    await service.saveCredential({
      id: 'credential.ark',
      providerId: 'ark',
      secret: 'original-secret',
    });
    store.credentialSaveError = new Error('metadata write failed');
    await expect(service.saveCredential({
      id: 'credential.ark',
      providerId: 'ark',
      secret: 'replacement-secret',
    })).rejects.toThrow('metadata write failed');
    await expect(secrets.resolve('secret:credential.ark')).resolves.toBe('original-secret');
    service.close();
  });

  it('installs Ark Agent Plan models entirely inside Hadamard Keyway storage', async () => {
    const root = await home();
    const store = new FakeStore();
    const secrets = new MemorySecrets();
    const service = await UsageRoutingAdminService.open({
      homeDir: root,
      store,
      secretStore: secrets,
      now: () => new Date(timestamp),
    });
    const result = await service.installArkAgentPlan({ secret: 'ark-write-only-canary' });
    expect(result.routeAliases).toEqual(['ark-glm-5.2', 'ark-glm-5.3']);
    expect(store.targets).toContainEqual(expect.objectContaining({
      id: 'target.ark-agent-plan',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    }));
    expect(store.routes.map(route => [route.alias, route.candidates[0]?.upstreamModel])).toEqual([
      ['ark-glm-5.2', 'glm-5.2'],
      ['ark-glm-5.3', 'glm-5.3'],
    ]);
    expect(await secrets.resolve('secret:credential.ark-agent-plan')).toBe('ark-write-only-canary');
    expect(JSON.stringify(await service.catalog())).not.toContain('ark-write-only-canary');
    service.close();
  });
});
