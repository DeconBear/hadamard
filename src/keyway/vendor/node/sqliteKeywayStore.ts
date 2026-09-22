import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  assertBudgetPolicy,
  assertGatewayRoute,
  assertUsageEventV2,
  type BudgetContext,
  type BudgetDecision,
  type BudgetMetric,
  type BudgetPeriod,
  type BudgetPolicy,
  type BudgetReservation,
  type BudgetReservationOutcome,
  type CredentialHealth,
  type ExecutionTarget,
  type GatewayRoute,
  type GatewayRouteCandidate,
  type KeywayAdminStore,
  type KeywayStore,
  type KeywayTransaction,
  type ManagedCredential,
  type UsageCounters,
  type UsageEventV2,
  type UsageSink,
} from '../core/index.js';

const SCHEMA_VERSION = 1;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 60_000;

export interface SqliteKeywayStoreOptions {
  readonly filePath: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface IssuedKeyRecord {
  readonly id: string;
  readonly groupId: string;
  readonly keyHash: string;
  readonly prefix: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly expiresAt?: string;
  readonly maxRequests?: number;
  readonly usedRequests: number;
  readonly maxTokens?: number;
  readonly usedTokens: number;
  readonly concurrencyLimit?: number;
  readonly rpmLimit?: number;
  readonly createdAt: string;
}

export interface UsageQuery {
  readonly from?: string;
  readonly to?: string;
  readonly providerId?: string;
  readonly credentialId?: string;
  readonly routeId?: string;
  readonly model?: string;
  readonly source?: UsageEventV2['source'];
  readonly status?: UsageEventV2['status'];
  readonly limit?: number;
  readonly offset?: number;
}

export class SqliteKeywayStore implements KeywayStore, KeywayAdminStore, KeywayTransaction, UsageSink {
  private readonly database: DatabaseSync;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private transactionTail: Promise<void> = Promise.resolve();
  private transactionActive = false;
  private closed = false;

  constructor(options: SqliteKeywayStoreOptions) {
    const filePath = path.resolve(options.filePath);
    const directory = path.dirname(filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(directory, 0o700);
    this.database = new DatabaseSync(filePath);
    if (process.platform !== 'win32') chmodSync(filePath, 0o600);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  schemaVersion(): number {
    const row = recordRequired(this.database.prepare('PRAGMA user_version').get());
    return numberValue(row.user_version, 'user_version');
  }

  async transaction<T>(operation: (transaction: KeywayTransaction) => Promise<T>): Promise<T> {
    this.assertOpen();
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    this.database.exec('BEGIN IMMEDIATE');
    this.transactionActive = true;
    try {
      const result = await operation(this);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionActive = false;
      release();
    }
  }

  saveTarget(target: ExecutionTarget): void {
    this.assertOpen();
    this.database.prepare(`
      INSERT INTO execution_targets (
        id, kind, provider_id, protocol, base_url, runtime, profile_name, config_id, enabled, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        provider_id = excluded.provider_id,
        protocol = excluded.protocol,
        base_url = excluded.base_url,
        runtime = excluded.runtime,
        profile_name = excluded.profile_name,
        config_id = excluded.config_id,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
      target.id,
      target.kind,
      target.kind === 'managed-api' ? target.providerId : null,
      target.kind === 'managed-api' ? target.protocol : null,
      target.kind === 'managed-api' ? target.baseUrl : null,
      target.kind === 'native-cli' ? target.runtime : null,
      target.kind === 'native-cli' ? target.profileName ?? null : null,
      target.kind === 'native-cli' ? target.configId ?? null : null,
      target.enabled ? 1 : 0,
      this.now().toISOString(),
    );
  }

  async listTargets(): Promise<readonly ExecutionTarget[]> {
    const rows = this.database.prepare('SELECT id FROM execution_targets ORDER BY id ASC').all();
    const targets = await Promise.all(rows.map(value => (
      this.getTarget(stringValue(recordRequired(value).id, 'target.id'))
    )));
    return targets.filter((target): target is ExecutionTarget => target !== undefined);
  }

  deleteTarget(targetId: string): boolean {
    this.assertOpen();
    const result = this.database.prepare('DELETE FROM execution_targets WHERE id = ?').run(targetId);
    return Number(result.changes) > 0;
  }

  saveCredential(credential: ManagedCredential): void {
    this.assertOpen();
    this.database.prepare(`
      INSERT INTO managed_credentials (
        id, provider_id, secret_ref, label, priority, weight, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider_id = excluded.provider_id,
        secret_ref = excluded.secret_ref,
        label = excluded.label,
        priority = excluded.priority,
        weight = excluded.weight,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
      credential.id,
      credential.providerId,
      credential.secretRef,
      credential.label,
      credential.priority,
      Math.max(1, credential.weight),
      credential.enabled ? 1 : 0,
      credential.createdAt,
      credential.updatedAt,
    );
  }

  deleteCredential(credentialId: string): boolean {
    this.assertOpen();
    const result = this.database.prepare('DELETE FROM managed_credentials WHERE id = ?').run(credentialId);
    return Number(result.changes) > 0;
  }

  async listManagedCredentials(providerId?: string): Promise<readonly ManagedCredential[]> {
    const sql = providerId
      ? 'SELECT * FROM managed_credentials WHERE provider_id = ? ORDER BY provider_id, priority, created_at, id'
      : 'SELECT * FROM managed_credentials ORDER BY provider_id, priority, created_at, id';
    const rows = providerId
      ? this.database.prepare(sql).all(providerId)
      : this.database.prepare(sql).all();
    return rows.map(value => credentialFromRow(recordRequired(value)));
  }

  saveRoute(route: GatewayRoute): void {
    assertGatewayRoute(route);
    const ownsTransaction = !this.transactionActive;
    if (ownsTransaction) this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO gateway_routes (id, alias, mode, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          alias = excluded.alias,
          mode = excluded.mode,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `).run(route.id, route.alias, route.mode, route.enabled ? 1 : 0, route.createdAt, route.updatedAt);
      this.database.prepare('DELETE FROM route_candidates WHERE route_id = ?').run(route.id);
      const insert = this.database.prepare(`
        INSERT INTO route_candidates (
          id, route_id, target_id, upstream_model, priority, weight, enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const candidate of route.candidates) {
        insert.run(
          candidate.id,
          route.id,
          candidate.targetId,
          candidate.upstreamModel,
          candidate.priority,
          candidate.weight,
          candidate.enabled ? 1 : 0,
        );
      }
      if (ownsTransaction) this.database.exec('COMMIT');
    } catch (error) {
      if (ownsTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async listRoutes(): Promise<readonly GatewayRoute[]> {
    const rows = this.database.prepare('SELECT id FROM gateway_routes ORDER BY alias ASC, id ASC').all();
    const routes = await Promise.all(rows.map(value => (
      this.getRouteById(stringValue(recordRequired(value).id, 'route.id'))
    )));
    return routes.filter((route): route is GatewayRoute => route !== undefined);
  }

  deleteRoute(routeId: string): boolean {
    this.assertOpen();
    const result = this.database.prepare('DELETE FROM gateway_routes WHERE id = ?').run(routeId);
    return Number(result.changes) > 0;
  }

  saveBudgetPolicy(policy: BudgetPolicy): void {
    assertBudgetPolicy(policy);
    this.database.prepare(`
      INSERT INTO budget_policies (
        id, scope_json, period, metric, limit_value, action, fallback_route_id, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        scope_json = excluded.scope_json,
        period = excluded.period,
        metric = excluded.metric,
        limit_value = excluded.limit_value,
        action = excluded.action,
        fallback_route_id = excluded.fallback_route_id,
        enabled = excluded.enabled
    `).run(
      policy.id,
      JSON.stringify(policy.scope),
      policy.period,
      policy.metric,
      policy.limit,
      policy.action,
      policy.fallbackRouteId ?? null,
      policy.enabled ? 1 : 0,
    );
  }

  async listManagedBudgetPolicies(): Promise<readonly BudgetPolicy[]> {
    return this.database.prepare('SELECT * FROM budget_policies ORDER BY id ASC')
      .all()
      .map(value => policyFromRow(recordRequired(value)));
  }

  deleteBudgetPolicy(policyId: string): boolean {
    this.assertOpen();
    const result = this.database.prepare('DELETE FROM budget_policies WHERE id = ?').run(policyId);
    return Number(result.changes) > 0;
  }

  saveIssuedKey(record: IssuedKeyRecord): void {
    if (!record.keyHash || !record.prefix) throw new TypeError('Issued key hash and prefix are required.');
    this.database.prepare(`
      INSERT INTO issued_keys (
        id, group_id, key_hash, prefix, name, enabled, expires_at,
        max_requests, used_requests, max_tokens, used_tokens,
        concurrency_limit, rpm_limit, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        group_id = excluded.group_id,
        key_hash = excluded.key_hash,
        prefix = excluded.prefix,
        name = excluded.name,
        enabled = excluded.enabled,
        expires_at = excluded.expires_at,
        max_requests = excluded.max_requests,
        used_requests = excluded.used_requests,
        max_tokens = excluded.max_tokens,
        used_tokens = excluded.used_tokens,
        concurrency_limit = excluded.concurrency_limit,
        rpm_limit = excluded.rpm_limit
    `).run(
      record.id,
      record.groupId,
      record.keyHash,
      record.prefix,
      record.name,
      record.enabled ? 1 : 0,
      record.expiresAt ?? null,
      record.maxRequests ?? null,
      record.usedRequests,
      record.maxTokens ?? null,
      record.usedTokens,
      record.concurrencyLimit ?? null,
      record.rpmLimit ?? null,
      record.createdAt,
    );
  }

  getIssuedKeyByHash(keyHash: string): IssuedKeyRecord | undefined {
    const row = record(this.database.prepare('SELECT * FROM issued_keys WHERE key_hash = ?').get(keyHash));
    return row ? issuedKeyFromRow(row) : undefined;
  }

  listIssuedKeys(): readonly IssuedKeyRecord[] {
    return this.database.prepare('SELECT * FROM issued_keys ORDER BY created_at ASC, id ASC')
      .all()
      .map(value => issuedKeyFromRow(recordRequired(value)));
  }

  deleteIssuedKey(keyId: string): boolean {
    const result = this.database.prepare('DELETE FROM issued_keys WHERE id = ?').run(keyId);
    return Number(result.changes) > 0;
  }

  adjustIssuedKeyUsage(keyId: string, requests: number, tokens: number): void {
    this.database.prepare(`
      UPDATE issued_keys SET
        used_requests = MAX(0, used_requests + ?),
        used_tokens = MAX(0, used_tokens + ?)
      WHERE id = ?
    `).run(Math.trunc(requests), Math.trunc(tokens), keyId);
  }

  async getRouteByAlias(alias: string): Promise<GatewayRoute | undefined> {
    const route = record(this.database.prepare('SELECT * FROM gateway_routes WHERE alias = ?').get(alias));
    if (!route) return undefined;
    const candidates = this.database.prepare(`
      SELECT * FROM route_candidates WHERE route_id = ? ORDER BY priority ASC, id ASC
    `).all(stringValue(route.id, 'route.id')).map(value => candidateFromRow(recordRequired(value)));
    return {
      id: stringValue(route.id, 'route.id'),
      alias: stringValue(route.alias, 'route.alias'),
      mode: stringValue(route.mode, 'route.mode') as GatewayRoute['mode'],
      enabled: booleanValue(route.enabled),
      createdAt: stringValue(route.created_at, 'route.created_at'),
      updatedAt: stringValue(route.updated_at, 'route.updated_at'),
      candidates,
    };
  }

  async getRouteById(id: string): Promise<GatewayRoute | undefined> {
    const route = record(this.database.prepare('SELECT * FROM gateway_routes WHERE id = ?').get(id));
    if (!route) return undefined;
    const candidates = this.database.prepare(`
      SELECT * FROM route_candidates WHERE route_id = ? ORDER BY priority ASC, id ASC
    `).all(stringValue(route.id, 'route.id')).map(value => candidateFromRow(recordRequired(value)));
    return {
      id: stringValue(route.id, 'route.id'),
      alias: stringValue(route.alias, 'route.alias'),
      mode: stringValue(route.mode, 'route.mode') as GatewayRoute['mode'],
      enabled: booleanValue(route.enabled),
      createdAt: stringValue(route.created_at, 'route.created_at'),
      updatedAt: stringValue(route.updated_at, 'route.updated_at'),
      candidates,
    };
  }

  async getTarget(id: string): Promise<ExecutionTarget | undefined> {
    const row = record(this.database.prepare('SELECT * FROM execution_targets WHERE id = ?').get(id));
    if (!row) return undefined;
    if (row.kind === 'managed-api') {
      return {
        kind: 'managed-api',
        id: stringValue(row.id, 'target.id'),
        providerId: stringValue(row.provider_id, 'target.provider_id'),
        protocol: stringValue(row.protocol, 'target.protocol') as 'openai' | 'anthropic',
        baseUrl: stringValue(row.base_url, 'target.base_url'),
        enabled: booleanValue(row.enabled),
      };
    }
    if (row.kind === 'native-cli') {
      const profileName = optionalString(row.profile_name);
      const configId = optionalString(row.config_id);
      return {
        kind: 'native-cli',
        id: stringValue(row.id, 'target.id'),
        runtime: stringValue(row.runtime, 'target.runtime'),
        enabled: booleanValue(row.enabled),
        ...(profileName ? { profileName } : {}),
        ...(configId ? { configId } : {}),
      };
    }
    throw new TypeError(`Unknown execution target kind: ${String(row.kind)}`);
  }

  async listCredentials(providerId: string): Promise<readonly ManagedCredential[]> {
    return this.database.prepare(`
      SELECT * FROM managed_credentials WHERE provider_id = ? ORDER BY priority ASC, created_at ASC, id ASC
    `).all(providerId).map(value => credentialFromRow(recordRequired(value)));
  }

  async getCredentialHealth(credentialId: string): Promise<CredentialHealth | undefined> {
    const row = record(this.database.prepare('SELECT * FROM credential_health WHERE credential_id = ?').get(credentialId));
    return row ? healthFromRow(row) : undefined;
  }

  async listBudgetPolicies(): Promise<readonly BudgetPolicy[]> {
    return this.database.prepare('SELECT * FROM budget_policies WHERE enabled = 1 ORDER BY id ASC')
      .all()
      .map(value => policyFromRow(recordRequired(value)));
  }

  async reserveBudget(
    requestId: string,
    estimatedUsage: Partial<UsageCounters>,
    context: BudgetContext = {},
  ): Promise<BudgetReservationOutcome> {
    const policies = (await this.listBudgetPolicies()).filter(policy => scopeMatches(policy, context));
    const now = this.now();
    const pending: Array<{
      policy: BudgetPolicy;
      periodKey: string;
      requested: number;
      used: number;
      reserved: number;
      decision: BudgetDecision['decision'];
    }> = [];
    for (const policy of policies) {
      const periodKey = budgetPeriodKey(policy.period, now);
      const usage = record(this.database.prepare(`
        SELECT used, reserved FROM budget_usage WHERE policy_id = ? AND period_key = ?
      `).get(policy.id, periodKey));
      const used = usage ? numberValue(usage.used, 'budget_usage.used') : 0;
      const reserved = usage ? numberValue(usage.reserved, 'budget_usage.reserved') : 0;
      const requested = metricValue(policy.metric, estimatedUsage, true);
      const exceeded = used + reserved + requested > policy.limit;
      const decision: BudgetDecision['decision'] = !exceeded
        ? 'allowed'
        : policy.action === 'warn'
          ? 'warned'
          : policy.action === 'deny'
            ? 'denied'
            : 'fallback';
      pending.push({ policy, periodKey, requested, used, reserved, decision });
    }

    const decisions = pending.map(({ policy, requested, used, reserved, decision }) => ({
      policyId: policy.id,
      decision,
      used,
      reserved,
      requested,
      limit: policy.limit,
      ...(policy.fallbackRouteId ? { fallbackRouteId: policy.fallbackRouteId } : {}),
    }));
    if (decisions.some(decision => decision.decision === 'denied' || decision.decision === 'fallback')) {
      return { reservations: [], decisions };
    }

    const reservations: BudgetReservation[] = [];
    const createdAt = now.toISOString();
    for (const item of pending) {
      const reservation: BudgetReservation = {
        id: this.idFactory(),
        requestId,
        policyId: item.policy.id,
        metric: item.policy.metric,
        periodKey: item.periodKey,
        reserved: item.requested,
        createdAt,
      };
      this.database.prepare(`
        INSERT INTO budget_usage (policy_id, period_key, used, reserved)
        VALUES (?, ?, 0, ?)
        ON CONFLICT(policy_id, period_key) DO UPDATE SET reserved = reserved + excluded.reserved
      `).run(reservation.policyId, reservation.periodKey, reservation.reserved);
      this.database.prepare(`
        INSERT INTO budget_reservations (
          id, request_id, policy_id, period_key, metric, reserved, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
      `).run(
        reservation.id,
        reservation.requestId,
        reservation.policyId,
        reservation.periodKey,
        reservation.metric,
        reservation.reserved,
        reservation.createdAt,
      );
      reservations.push(reservation);
    }
    return { reservations, decisions };
  }

  async reconcileBudget(
    reservations: readonly BudgetReservation[],
    usage: UsageCounters,
  ): Promise<void> {
    for (const reservation of reservations) {
      const row = record(this.database.prepare(`
        SELECT status FROM budget_reservations WHERE id = ?
      `).get(reservation.id));
      if (!row || row.status !== 'active') continue;
      const actual = metricValue(reservation.metric, usage, false);
      this.database.prepare(`
        UPDATE budget_usage SET
          reserved = MAX(0, reserved - ?),
          used = used + ?
        WHERE policy_id = ? AND period_key = ?
      `).run(reservation.reserved, actual, reservation.policyId, reservation.periodKey);
      this.database.prepare(`
        UPDATE budget_reservations SET status = 'reconciled', actual = ?, reconciled_at = ? WHERE id = ?
      `).run(actual, this.now().toISOString(), reservation.id);
    }
  }

  async recordCredentialSuccess(credentialId: string, at: string): Promise<void> {
    const credential = record(this.database.prepare('SELECT provider_id FROM managed_credentials WHERE id = ?').get(credentialId));
    if (!credential) return;
    this.database.prepare(`
      INSERT INTO credential_health (
        credential_id, provider_id, state, consecutive_failures, last_success_at, circuit_open_until
      ) VALUES (?, ?, 'healthy', 0, ?, NULL)
      ON CONFLICT(credential_id) DO UPDATE SET
        state = 'healthy',
        consecutive_failures = 0,
        last_success_at = excluded.last_success_at,
        circuit_open_until = NULL
    `).run(credentialId, stringValue(credential.provider_id, 'credential.provider_id'), at);
  }

  async recordCredentialFailure(credentialId: string, at: string, retryable: boolean): Promise<void> {
    const credential = record(this.database.prepare('SELECT provider_id FROM managed_credentials WHERE id = ?').get(credentialId));
    if (!credential) return;
    const existing = await this.getCredentialHealth(credentialId);
    const failures = (existing?.consecutiveFailures ?? 0) + 1;
    const opens = retryable && failures >= CIRCUIT_FAILURE_THRESHOLD;
    const circuitOpenUntil = opens
      ? new Date(Date.parse(at) + CIRCUIT_OPEN_MS).toISOString()
      : undefined;
    this.database.prepare(`
      INSERT INTO credential_health (
        credential_id, provider_id, state, consecutive_failures, last_failure_at, circuit_open_until
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(credential_id) DO UPDATE SET
        state = excluded.state,
        consecutive_failures = excluded.consecutive_failures,
        last_failure_at = excluded.last_failure_at,
        circuit_open_until = excluded.circuit_open_until
    `).run(
      credentialId,
      stringValue(credential.provider_id, 'credential.provider_id'),
      opens ? 'circuit-open' : 'degraded',
      failures,
      at,
      circuitOpenUntil ?? null,
    );
  }

  async append(event: UsageEventV2): Promise<void> {
    assertUsageEventV2(event);
    this.database.prepare(`
      INSERT OR IGNORE INTO usage_events (
        event_id, request_id, timestamp, source, provider_id, credential_id,
        route_id, model, status, total_tokens, cost_usd, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.requestId,
      event.timestamp,
      event.source,
      event.providerId ?? null,
      event.credentialId ?? null,
      event.routeId ?? null,
      event.resolvedModel ?? event.requestedModel,
      event.status,
      event.usage.totalTokens,
      event.usage.costUsd ?? null,
      JSON.stringify(event),
    );
  }

  queryUsage(query: UsageQuery = {}): readonly UsageEventV2[] {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    for (const [column, value] of [
      ['provider_id', query.providerId],
      ['credential_id', query.credentialId],
      ['route_id', query.routeId],
      ['model', query.model],
      ['source', query.source],
      ['status', query.status],
    ] as const) {
      if (value === undefined) continue;
      clauses.push(`${column} = ?`);
      parameters.push(value);
    }
    if (query.from !== undefined) {
      clauses.push('timestamp >= ?');
      parameters.push(query.from);
    }
    if (query.to !== undefined) {
      clauses.push('timestamp < ?');
      parameters.push(query.to);
    }
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 10_000);
    const offset = Math.max(query.offset ?? 0, 0);
    parameters.push(limit, offset);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.database.prepare(`
      SELECT event_json FROM usage_events ${where}
      ORDER BY timestamp DESC, event_id DESC LIMIT ? OFFSET ?
    `).all(...parameters).map(value => (
      JSON.parse(stringValue(recordRequired(value).event_json, 'usage.event_json')) as UsageEventV2
    ));
  }

  private migrate(): void {
    const version = this.schemaVersion();
    if (version > SCHEMA_VERSION) {
      throw new Error(`Keyway database schema ${version} is newer than supported ${SCHEMA_VERSION}.`);
    }
    if (version === SCHEMA_VERSION) return;
    this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS execution_targets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('managed-api', 'native-cli')),
        provider_id TEXT,
        protocol TEXT,
        base_url TEXT,
        runtime TEXT,
        profile_name TEXT,
        config_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS managed_credentials (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        secret_ref TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 0,
        weight INTEGER NOT NULL DEFAULT 1 CHECK(weight >= 1),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS managed_credentials_provider
        ON managed_credentials(provider_id, enabled, priority, created_at);
      CREATE TABLE IF NOT EXISTS credential_health (
        credential_id TEXT PRIMARY KEY REFERENCES managed_credentials(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        state TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_success_at TEXT,
        last_failure_at TEXT,
        circuit_open_until TEXT
      );
      CREATE TABLE IF NOT EXISTS gateway_routes (
        id TEXT PRIMARY KEY,
        alias TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL CHECK(mode IN ('direct', 'priority-failover')),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS route_candidates (
        id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL REFERENCES gateway_routes(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES execution_targets(id) ON DELETE RESTRICT,
        upstream_model TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        weight INTEGER NOT NULL DEFAULT 1 CHECK(weight >= 1),
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS route_candidates_route
        ON route_candidates(route_id, enabled, priority, id);
      CREATE TABLE IF NOT EXISTS budget_policies (
        id TEXT PRIMARY KEY,
        scope_json TEXT NOT NULL,
        period TEXT NOT NULL,
        metric TEXT NOT NULL,
        limit_value REAL NOT NULL CHECK(limit_value > 0),
        action TEXT NOT NULL,
        fallback_route_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS budget_usage (
        policy_id TEXT NOT NULL REFERENCES budget_policies(id) ON DELETE CASCADE,
        period_key TEXT NOT NULL,
        used REAL NOT NULL DEFAULT 0,
        reserved REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(policy_id, period_key)
      );
      CREATE TABLE IF NOT EXISTS budget_reservations (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        policy_id TEXT NOT NULL REFERENCES budget_policies(id) ON DELETE CASCADE,
        period_key TEXT NOT NULL,
        metric TEXT NOT NULL,
        reserved REAL NOT NULL,
        actual REAL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reconciled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS budget_reservations_request ON budget_reservations(request_id);
      CREATE TABLE IF NOT EXISTS issued_keys (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        expires_at TEXT,
        max_requests INTEGER,
        used_requests INTEGER NOT NULL DEFAULT 0,
        max_tokens INTEGER,
        used_tokens INTEGER NOT NULL DEFAULT 0,
        concurrency_limit INTEGER,
        rpm_limit INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        event_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        provider_id TEXT,
        credential_id TEXT,
        route_id TEXT,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        total_tokens INTEGER NOT NULL,
        cost_usd REAL,
        event_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_events_timestamp ON usage_events(timestamp);
      CREATE INDEX IF NOT EXISTS usage_events_provider ON usage_events(provider_id, timestamp);
      CREATE INDEX IF NOT EXISTS usage_events_route ON usage_events(route_id, timestamp);
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SqliteKeywayStore is closed.');
  }
}

function candidateFromRow(row: Record<string, unknown>): GatewayRouteCandidate {
  return {
    id: stringValue(row.id, 'candidate.id'),
    targetId: stringValue(row.target_id, 'candidate.target_id'),
    upstreamModel: stringValue(row.upstream_model, 'candidate.upstream_model'),
    priority: numberValue(row.priority, 'candidate.priority'),
    weight: numberValue(row.weight, 'candidate.weight'),
    enabled: booleanValue(row.enabled),
  };
}

function credentialFromRow(row: Record<string, unknown>): ManagedCredential {
  return {
    id: stringValue(row.id, 'credential.id'),
    providerId: stringValue(row.provider_id, 'credential.provider_id'),
    secretRef: stringValue(row.secret_ref, 'credential.secret_ref'),
    label: stringValue(row.label, 'credential.label'),
    priority: numberValue(row.priority, 'credential.priority'),
    weight: numberValue(row.weight, 'credential.weight'),
    enabled: booleanValue(row.enabled),
    createdAt: stringValue(row.created_at, 'credential.created_at'),
    updatedAt: stringValue(row.updated_at, 'credential.updated_at'),
  };
}

function healthFromRow(row: Record<string, unknown>): CredentialHealth {
  const lastSuccessAt = optionalString(row.last_success_at);
  const lastFailureAt = optionalString(row.last_failure_at);
  const circuitOpenUntil = optionalString(row.circuit_open_until);
  return {
    credentialId: stringValue(row.credential_id, 'health.credential_id'),
    state: stringValue(row.state, 'health.state') as CredentialHealth['state'],
    consecutiveFailures: numberValue(row.consecutive_failures, 'health.consecutive_failures'),
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    ...(lastFailureAt ? { lastFailureAt } : {}),
    ...(circuitOpenUntil ? { circuitOpenUntil } : {}),
  };
}

function policyFromRow(row: Record<string, unknown>): BudgetPolicy {
  const fallbackRouteId = optionalString(row.fallback_route_id);
  return {
    id: stringValue(row.id, 'policy.id'),
    scope: JSON.parse(stringValue(row.scope_json, 'policy.scope_json')) as BudgetPolicy['scope'],
    period: stringValue(row.period, 'policy.period') as BudgetPolicy['period'],
    metric: stringValue(row.metric, 'policy.metric') as BudgetPolicy['metric'],
    limit: numberValue(row.limit_value, 'policy.limit_value'),
    action: stringValue(row.action, 'policy.action') as BudgetPolicy['action'],
    enabled: booleanValue(row.enabled),
    ...(fallbackRouteId ? { fallbackRouteId } : {}),
  };
}

function issuedKeyFromRow(row: Record<string, unknown>): IssuedKeyRecord {
  const expiresAt = optionalString(row.expires_at);
  const maxRequests = optionalNumber(row.max_requests);
  const maxTokens = optionalNumber(row.max_tokens);
  const concurrencyLimit = optionalNumber(row.concurrency_limit);
  const rpmLimit = optionalNumber(row.rpm_limit);
  return {
    id: stringValue(row.id, 'issued_key.id'),
    groupId: stringValue(row.group_id, 'issued_key.group_id'),
    keyHash: stringValue(row.key_hash, 'issued_key.key_hash'),
    prefix: stringValue(row.prefix, 'issued_key.prefix'),
    name: stringValue(row.name, 'issued_key.name'),
    enabled: booleanValue(row.enabled),
    usedRequests: numberValue(row.used_requests, 'issued_key.used_requests'),
    usedTokens: numberValue(row.used_tokens, 'issued_key.used_tokens'),
    createdAt: stringValue(row.created_at, 'issued_key.created_at'),
    ...(expiresAt ? { expiresAt } : {}),
    ...(maxRequests !== undefined ? { maxRequests } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(concurrencyLimit !== undefined ? { concurrencyLimit } : {}),
    ...(rpmLimit !== undefined ? { rpmLimit } : {}),
  };
}

function scopeMatches(policy: BudgetPolicy, context: BudgetContext): boolean {
  switch (policy.scope.kind) {
    case 'global': return true;
    case 'provider': return policy.scope.id === context.providerId;
    case 'credential': return policy.scope.id === context.credentialId;
    case 'route': return policy.scope.id === context.routeId;
    case 'model': return policy.scope.id === context.model;
  }
}

function budgetPeriodKey(period: BudgetPeriod, date: Date): string {
  const iso = date.toISOString();
  if (period === 'daily') return iso.slice(0, 10);
  if (period === 'monthly') return iso.slice(0, 7);
  return 'lifetime';
}

function metricValue(metric: BudgetMetric, usage: Partial<UsageCounters>, estimated: boolean): number {
  if (metric === 'requests') return usage.requests ?? (estimated ? 1 : 0);
  if (metric === 'totalTokens') {
    return usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
  return usage.costUsd ?? 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function recordRequired(value: unknown): Record<string, unknown> {
  const result = record(value);
  if (!result) throw new TypeError('SQLite row was not an object.');
  return result;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${field} must be a number.`);
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean {
  return value === 1 || value === true;
}
