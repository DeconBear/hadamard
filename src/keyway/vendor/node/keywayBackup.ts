import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  KEYWAY_EXPORT_VERSION,
  assertKeywayExportV1,
  type BudgetPolicy,
  type ExecutionTarget,
  type GatewayRoute,
  type KeywayExportV1,
  type ManagedCredential,
  type UsageEventV2,
} from '../core/index.js';

import type { IssuedKeyRecord, SqliteKeywayStore, UsageQuery } from './sqliteKeywayStore.js';

export interface KeywayPortableStore {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  listTargets(): Promise<readonly ExecutionTarget[]>;
  saveTarget(value: ExecutionTarget): void;
  listManagedCredentials(): Promise<readonly ManagedCredential[]>;
  saveCredential(value: ManagedCredential): void;
  listRoutes(): Promise<readonly GatewayRoute[]>;
  saveRoute(value: GatewayRoute): void;
  listManagedBudgetPolicies(): Promise<readonly BudgetPolicy[]>;
  saveBudgetPolicy(value: BudgetPolicy): void;
  listIssuedKeys(): readonly IssuedKeyRecord[];
  saveIssuedKey(value: IssuedKeyRecord): void;
  queryUsage(query?: UsageQuery): readonly UsageEventV2[];
  append(event: UsageEventV2): Promise<void>;
}

export interface ImportKeywayExportResult {
  targets: number;
  credentialMetadata: number;
  routes: number;
  budgetPolicies: number;
  issuedKeys: number;
  usageEvents: number;
}

/** Portable, secret-free snapshot suitable for preview and cross-runtime migration. */
export async function exportKeywayV1(
  store: KeywayPortableStore,
  now: () => Date = () => new Date(),
): Promise<KeywayExportV1> {
  const [targets, credentials, routes, budgetPolicies] = await Promise.all([
    store.listTargets(),
    store.listManagedCredentials(),
    store.listRoutes(),
    store.listManagedBudgetPolicies(),
  ]);
  const issued = store.listIssuedKeys();
  const groups = [...new Set(issued.map(key => key.groupId))].sort().map(id => ({
    id,
    name: id === 'default' ? 'Default Group' : id,
    enabled: true,
  }));
  const usageEvents: UsageEventV2[] = [];
  for (let offset = 0; ; offset += 10_000) {
    const page = store.queryUsage({ limit: 10_000, offset });
    usageEvents.push(...page);
    if (page.length < 10_000) break;
  }
  return {
    version: KEYWAY_EXPORT_VERSION,
    exportedAt: now().toISOString(),
    groups,
    targets,
    credentialMetadata: credentials.map(({ secretRef: _secretRef, ...metadata }) => metadata),
    routes,
    budgetPolicies,
    issuedKeys: issued.map(key => ({
      id: key.id,
      groupId: key.groupId,
      prefix: key.prefix,
      name: key.name,
      enabled: key.enabled,
      quota: {
        ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
        ...(key.maxRequests !== undefined ? { maxRequests: key.maxRequests } : {}),
        usedRequests: key.usedRequests,
        ...(key.maxTokens !== undefined ? { maxTokens: key.maxTokens } : {}),
        usedTokens: key.usedTokens,
        ...(key.concurrencyLimit !== undefined ? { concurrencyLimit: key.concurrencyLimit } : {}),
        ...(key.rpmLimit !== undefined ? { rpmLimit: key.rpmLimit } : {}),
      },
    })),
    usageEvents,
  };
}

/** Import is one SQLite transaction; thrown errors leave the destination unchanged. */
export async function importKeywayV1(
  store: KeywayPortableStore,
  value: KeywayExportV1,
): Promise<ImportKeywayExportResult> {
  assertKeywayExportV1(value);
  return store.transaction(async () => {
    for (const target of value.targets) store.saveTarget(target);
    for (const credential of value.credentialMetadata) {
      store.saveCredential({
        ...credential,
        enabled: false,
        secretRef: `secret:${credential.id}`,
      });
    }
    for (const route of value.routes) store.saveRoute(route);
    for (const policy of value.budgetPolicies) store.saveBudgetPolicy(policy);
    for (const key of value.issuedKeys) {
      store.saveIssuedKey({
        id: key.id,
        groupId: key.groupId,
        keyHash: `unavailable:${key.id}`,
        prefix: key.prefix,
        name: key.name,
        enabled: false,
        ...(key.quota.expiresAt ? { expiresAt: key.quota.expiresAt } : {}),
        ...(key.quota.maxRequests !== undefined ? { maxRequests: key.quota.maxRequests } : {}),
        usedRequests: key.quota.usedRequests,
        ...(key.quota.maxTokens !== undefined ? { maxTokens: key.quota.maxTokens } : {}),
        usedTokens: key.quota.usedTokens,
        ...(key.quota.concurrencyLimit !== undefined ? { concurrencyLimit: key.quota.concurrencyLimit } : {}),
        ...(key.quota.rpmLimit !== undefined ? { rpmLimit: key.quota.rpmLimit } : {}),
        createdAt: value.exportedAt,
      });
    }
    for (const event of value.usageEvents) await store.append(event);
    return {
      targets: value.targets.length,
      credentialMetadata: value.credentialMetadata.length,
      routes: value.routes.length,
      budgetPolicies: value.budgetPolicies.length,
      issuedKeys: value.issuedKeys.length,
      usageEvents: value.usageEvents.length,
    };
  });
}

export function backupSqliteKeywayDatabase(sourceFile: string, destinationFile: string): void {
  const source = path.resolve(sourceFile);
  const destination = path.resolve(destinationFile);
  if (!existsSync(source)) throw new TypeError('Keyway database does not exist.');
  if (existsSync(destination)) throw new TypeError('Backup destination already exists.');
  const destinationDirectory = path.dirname(destination);
  mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
  protectPosixPath(destinationDirectory, 0o700);
  const database = new DatabaseSync(source);
  try {
    database.exec('PRAGMA wal_checkpoint(FULL)');
    database.exec(`VACUUM INTO '${destination.replace(/'/gu, "''")}'`);
  } finally {
    database.close();
  }
  protectPosixPath(destination, 0o600);
}

export function restoreSqliteKeywayDatabase(
  backupFile: string,
  destinationFile: string,
  options: { overwrite?: boolean } = {},
): void {
  const backup = path.resolve(backupFile);
  const destination = path.resolve(destinationFile);
  if (!existsSync(backup)) throw new TypeError('Keyway backup does not exist.');
  if (existsSync(destination) && !options.overwrite) throw new TypeError('Restore destination already exists.');
  const database = new DatabaseSync(backup, { readOnly: true });
  try {
    const row = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown };
    if (row.integrity_check !== 'ok') throw new Error('Keyway backup failed SQLite integrity_check.');
  } finally {
    database.close();
  }
  const destinationDirectory = path.dirname(destination);
  mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
  protectPosixPath(destinationDirectory, 0o700);
  const temporary = `${destination}.restore-${process.pid}`;
  copyFileSync(backup, temporary);
  if (options.overwrite) rmSync(destination, { force: true });
  renameSync(temporary, destination);
  protectPosixPath(destination, 0o600);
}

function protectPosixPath(filePath: string, mode: number): void {
  if (process.platform !== 'win32') chmodSync(filePath, mode);
}

export type KeywaySqlitePortableStore = SqliteKeywayStore;
