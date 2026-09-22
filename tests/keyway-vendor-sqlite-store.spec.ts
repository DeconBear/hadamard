import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  USAGE_EVENT_VERSION,
  type BudgetPolicy,
  type GatewayRoute,
  type ManagedCredential,
  type UsageCounters,
  type UsageEventV2,
} from '../src/keyway/vendor/core/index.js';

import {
  SqliteKeywayStore,
  backupSqliteKeywayDatabase,
  exportKeywayV1,
  importKeywayV1,
  restoreSqliteKeywayDatabase,
} from '../src/keyway/vendor/node/index.js';

const temporaryDirectories: string[] = [];
const timestamp = '2026-08-25T00:00:00.000Z';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { store: SqliteKeywayStore; filePath: string } {
  const directory = mkdtempSync(path.join(tmpdir(), 'keyway-store-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'keyway.db');
  return {
    filePath,
    store: new SqliteKeywayStore({
      filePath,
      now: () => new Date(timestamp),
    }),
  };
}

function credential(id: string, priority = 0): ManagedCredential {
  return {
    id,
    providerId: 'ark',
    secretRef: `secret:${id}`,
    label: id,
    priority,
    weight: 1,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function usage(totalTokens: number): UsageCounters {
  return {
    requests: 1,
    inputTokens: Math.max(0, totalTokens - 10),
    outputTokens: Math.min(10, totalTokens),
    totalTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    costUsd: totalTokens / 1_000_000,
    accuracy: 'actual',
  };
}

describe('SqliteKeywayStore', () => {
  it('migrates once and safely reopens schema version 1', () => {
    const { store, filePath } = createStore();
    expect(store.schemaVersion()).toBe(1);
    store.close();
    const reopened = new SqliteKeywayStore({ filePath });
    expect(reopened.schemaVersion()).toBe(1);
    reopened.close();
  });

  it.skipIf(process.platform === 'win32')('tightens POSIX storage permissions', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'keyway-store-permissions-'));
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o755);
    const filePath = path.join(directory, 'keyway.db');
    const store = new SqliteKeywayStore({ filePath });
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    store.close();
  });

  it('persists targets, routes and credential metadata without secret material', async () => {
    const { store } = createStore();
    store.saveTarget({
      kind: 'managed-api',
      id: 'target.ark',
      providerId: 'ark',
      protocol: 'openai',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      enabled: true,
    });
    store.saveCredential(credential('credential.primary'));
    const route: GatewayRoute = {
      id: 'route.chat',
      alias: 'chat',
      mode: 'direct',
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      candidates: [{
        id: 'candidate.primary',
        targetId: 'target.ark',
        upstreamModel: 'glm-5.2',
        priority: 0,
        weight: 1,
        enabled: true,
      }],
    };
    store.saveRoute(route);

    expect(await store.getTarget('target.ark')).toMatchObject({ providerId: 'ark' });
    expect(await store.listTargets()).toEqual([expect.objectContaining({ id: 'target.ark' })]);
    expect(await store.getRouteByAlias('chat')).toEqual(route);
    expect(await store.getRouteById('route.chat')).toEqual(route);
    expect(await store.listRoutes()).toEqual([route]);
    const credentials = await store.listCredentials('ark');
    expect(credentials).toEqual([credential('credential.primary')]);
    expect(await store.listManagedCredentials()).toEqual([credential('credential.primary')]);
    expect(JSON.stringify(credentials)).not.toContain('apiKey');
    expect(() => store.deleteTarget('target.ark')).toThrow();
    expect(store.deleteRoute('route.chat')).toBe(true);
    expect(store.deleteTarget('target.ark')).toBe(true);
    expect(store.deleteCredential('credential.primary')).toBe(true);
    store.close();
  });

  it('lists disabled budget policies for management and deletes them', async () => {
    const { store } = createStore();
    const policy: BudgetPolicy = {
      id: 'budget.disabled',
      scope: { kind: 'global' },
      period: 'monthly',
      metric: 'costUsd',
      limit: 10,
      action: 'warn',
      enabled: false,
    };
    store.saveBudgetPolicy(policy);
    expect(await store.listBudgetPolicies()).toEqual([]);
    expect(await store.listManagedBudgetPolicies()).toEqual([policy]);
    expect(store.deleteBudgetPolicy(policy.id)).toBe(true);
    expect(await store.listManagedBudgetPolicies()).toEqual([]);
    store.close();
  });

  it('serializes concurrent budget reservations and prevents oversell', async () => {
    const { store } = createStore();
    const policy: BudgetPolicy = {
      id: 'budget.monthly',
      scope: { kind: 'global' },
      period: 'monthly',
      metric: 'totalTokens',
      limit: 100,
      action: 'deny',
      enabled: true,
    };
    store.saveBudgetPolicy(policy);
    const [first, second] = await Promise.all([
      store.transaction(transaction => transaction.reserveBudget('request.first', { totalTokens: 60 })),
      store.transaction(transaction => transaction.reserveBudget('request.second', { totalTokens: 60 })),
    ]);
    expect(first.reservations).toHaveLength(1);
    expect(second.reservations).toHaveLength(0);
    expect(second.decisions[0]?.decision).toBe('denied');

    await store.transaction(transaction => transaction.reconcileBudget(first.reservations, usage(40)));
    const third = await store.transaction(transaction => transaction.reserveBudget(
      'request.third',
      { totalTokens: 60 },
    ));
    expect(third.reservations).toHaveLength(1);
    store.close();
  });

  it('opens and resets credential circuits using Python v0.2 thresholds', async () => {
    const { store } = createStore();
    store.saveCredential(credential('credential.primary'));
    await store.recordCredentialFailure('credential.primary', timestamp, true);
    await store.recordCredentialFailure('credential.primary', timestamp, true);
    expect((await store.getCredentialHealth('credential.primary'))?.state).toBe('degraded');
    await store.recordCredentialFailure('credential.primary', timestamp, true);
    expect(await store.getCredentialHealth('credential.primary')).toMatchObject({
      state: 'circuit-open',
      consecutiveFailures: 3,
    });
    await store.recordCredentialSuccess('credential.primary', timestamp);
    expect(await store.getCredentialHealth('credential.primary')).toMatchObject({
      state: 'healthy',
      consecutiveFailures: 0,
    });
    store.close();
  });

  it('stores only issued-key hashes and clamps refunded counters', () => {
    const { store } = createStore();
    const plaintext = 'db_sk_test_plaintext';
    const keyHash = createHash('sha256').update(plaintext).digest('hex');
    store.saveIssuedKey({
      id: 'issued.1',
      groupId: 'default',
      keyHash,
      prefix: 'db_sk_te',
      name: 'test',
      enabled: true,
      maxRequests: 10,
      usedRequests: 1,
      maxTokens: 1000,
      usedTokens: 100,
      createdAt: timestamp,
    });
    store.adjustIssuedKeyUsage('issued.1', -5, -500);
    const stored = store.getIssuedKeyByHash(keyHash);
    expect(stored).toMatchObject({ usedRequests: 0, usedTokens: 0, prefix: 'db_sk_te' });
    expect(JSON.stringify(stored)).not.toContain(plaintext);
    store.close();
  });

  it('writes and filters cache-aware usage events', async () => {
    const { store } = createStore();
    const event: UsageEventV2 = {
      version: USAGE_EVENT_VERSION,
      eventId: 'event.1',
      requestId: 'request.1',
      correlationId: 'correlation.1',
      timestamp,
      source: 'keyway',
      providerId: 'ark',
      credentialId: 'credential.primary',
      routeId: 'route.chat',
      requestedModel: 'chat',
      resolvedModel: 'glm-5.2',
      operation: 'stream',
      status: 'succeeded',
      usage: { ...usage(30), cacheReadTokens: 20 },
      attempts: [],
      durationMs: 100,
      streaming: true,
    };
    await store.append(event);
    expect(store.queryUsage({ providerId: 'ark' })).toEqual([event]);
    expect(store.queryUsage({ providerId: 'other' })).toEqual([]);
    store.close();
  });

  it('exports a secret-free snapshot and imports it atomically', async () => {
    const { store } = createStore();
    store.saveTarget({
      kind: 'managed-api',
      id: 'target.ark',
      providerId: 'ark',
      protocol: 'openai',
      baseUrl: 'https://ark.example.test/v1',
      enabled: true,
    });
    store.saveCredential(credential('credential.primary'));
    store.saveRoute({
      id: 'route.chat',
      alias: 'chat',
      mode: 'direct',
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      candidates: [{ id: 'candidate.1', targetId: 'target.ark', upstreamModel: 'glm-5.2', priority: 0, weight: 1, enabled: true }],
    });
    const snapshot = await exportKeywayV1(store, () => new Date(timestamp));
    expect(JSON.stringify(snapshot)).not.toContain('secretRef');
    expect(JSON.stringify(snapshot)).not.toContain('keyHash');

    const destination = createStore().store;
    await expect(importKeywayV1(destination, snapshot)).resolves.toMatchObject({
      targets: 1,
      credentialMetadata: 1,
      routes: 1,
    });
    expect(await destination.listManagedCredentials()).toEqual([
      expect.objectContaining({
        id: 'credential.primary',
        enabled: false,
        secretRef: 'secret:credential.primary',
      }),
    ]);
    destination.close();

    const rollback = createStore().store;
    const saveRoute = rollback.saveRoute.bind(rollback);
    rollback.saveRoute = () => { throw new Error('route import failed'); };
    await expect(importKeywayV1(rollback, snapshot)).rejects.toThrow('route import failed');
    rollback.saveRoute = saveRoute;
    expect(await rollback.listTargets()).toEqual([]);
    rollback.close();
    store.close();
  });

  it('backs up, integrity-checks and restores SQLite state', async () => {
    const { store, filePath } = createStore();
    store.saveTarget({
      kind: 'native-cli',
      id: 'target.codex',
      runtime: 'codex',
      enabled: true,
    });
    store.close();
    const directory = path.dirname(filePath);
    const backup = path.join(directory, 'backup.sqlite');
    const restored = path.join(directory, 'restored.sqlite');
    backupSqliteKeywayDatabase(filePath, backup);
    restoreSqliteKeywayDatabase(backup, restored);
    if (process.platform !== 'win32') {
      expect(statSync(backup).mode & 0o777).toBe(0o600);
      expect(statSync(restored).mode & 0o777).toBe(0o600);
    }
    const reopened = new SqliteKeywayStore({ filePath: restored });
    expect(await reopened.listTargets()).toEqual([
      expect.objectContaining({ id: 'target.codex', runtime: 'codex' }),
    ]);
    reopened.close();
  });
});
