import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  isManagedExternalCliRuntime,
  readBridgeConfigs,
  type PersistedBridgeConfig,
} from '../parity/bridgeConfigs.js';
import type {
  KeywayExecutionTargetPort,
  KeywayGatewayRoutePort,
  KeywayManagedCredentialPort,
  KeywaySdkModulesPort,
  KeywaySecretStorePort,
  KeywayStorePort,
} from './keywayPorts.js';
import { loadKeywaySdkModules } from './embeddedKeyway.js';

export interface BridgeMigrationPreviewItem {
  configName: string;
  kind: 'managed-api' | 'native-cli';
  ready: boolean;
  targetId: string;
  routeId: string;
  credentialId?: string;
  containsLegacyApiKey: boolean;
  issues: readonly string[];
}

export interface BridgeMigrationPreview {
  source: 'bridge-configs';
  items: readonly BridgeMigrationPreviewItem[];
  ready: number;
  blocked: number;
  oauthSessionSecretsRead: false;
}

export interface PortableMigrationPreview {
  source: 'keyway-export-v1';
  counts: Record<string, number>;
  secretsIncluded: false;
  issuedKeysRequireRotation: boolean;
}

export interface KeywayMigrationServiceOptions {
  homeDir: string;
  store: KeywayStorePort;
  secretStore: KeywaySecretStorePort;
  modules?: KeywaySdkModulesPort;
  now?: () => Date;
}

/** Preview-first migration. Bridge API keys are copied only on explicit apply; native OAuth is never read. */
export class KeywayMigrationService {
  constructor(private readonly options: KeywayMigrationServiceOptions) {}

  previewBridgeConfigs(): BridgeMigrationPreview {
    const items = readBridgeConfigs(this.options.homeDir).configs.map(config => previewConfig(config));
    return {
      source: 'bridge-configs',
      items,
      ready: items.filter(item => item.ready).length,
      blocked: items.filter(item => !item.ready).length,
      oauthSessionSecretsRead: false,
    };
  }

  async importBridgeConfigs(): Promise<Record<string, unknown>> {
    const configs = readBridgeConfigs(this.options.homeDir).configs;
    const plans = configs.map(config => ({ config, preview: previewConfig(config) }))
      .filter(item => item.preview.ready);
    const before = await this.capture(plans.map(item => item.preview));
    try {
      for (const { config, preview } of plans) await this.applyBridgeConfig(config, preview);
      return {
        imported: plans.length,
        skipped: configs.length - plans.length,
        rollback: 'automatic-on-failure',
        legacyApiKeysRetained: true,
        oauthSessionSecretsRead: false,
      };
    } catch (error) {
      await this.restore(before);
      throw error;
    }
  }

  async previewPortableFile(filePath: string): Promise<PortableMigrationPreview> {
    const value = await readPortableFile(filePath);
    const modules = this.options.modules ?? await loadKeywaySdkModules();
    modules.core.assertKeywayExportV1(value);
    return portablePreview(value as Record<string, unknown>);
  }

  async importPortableFile(filePath: string): Promise<Record<string, unknown>> {
    const value = await readPortableFile(filePath);
    const modules = this.options.modules ?? await loadKeywaySdkModules();
    modules.core.assertKeywayExportV1(value);
    const result = await modules.node.importKeywayV1(this.options.store, value);
    return {
      ...result,
      rollback: 'sqlite-transaction',
      secretsIncluded: false,
      credentialsRequireSecretBinding: true,
      issuedKeysRequireRotation: true,
    };
  }

  private async applyBridgeConfig(
    config: PersistedBridgeConfig,
    preview: BridgeMigrationPreviewItem,
  ): Promise<void> {
    const model = config.model ?? config.models?.[0]?.name;
    if (!model) throw new TypeError(`Bridge config ${config.name} has no model.`);
    const now = (this.options.now?.() ?? new Date()).toISOString();
    if (preview.kind === 'native-cli') {
      this.options.store.saveTarget({
        kind: 'native-cli',
        id: preview.targetId,
        runtime: config.runtime,
        configId: config.name,
        enabled: true,
      });
    } else {
      const providerId = `bridge.${slug(config.name)}`;
      this.options.store.saveTarget({
        kind: 'managed-api',
        id: preview.targetId,
        providerId,
        protocol: config.provider,
        baseUrl: config.baseURL!,
        enabled: true,
      });
      const credentialId = preview.credentialId!;
      const secretRef = `secret:${credentialId}`;
      await this.options.secretStore.put(secretRef, config.apiKey!);
      this.options.store.saveCredential({
        id: credentialId,
        providerId,
        secretRef,
        label: config.name,
        priority: 0,
        weight: 1,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    }
    this.options.store.saveRoute({
      id: preview.routeId,
      alias: `bridge-${slug(config.name)}`,
      mode: 'direct',
      enabled: true,
      createdAt: now,
      updatedAt: now,
      candidates: [{
        id: `${preview.routeId}.candidate.1`,
        targetId: preview.targetId,
        upstreamModel: model,
        priority: 0,
        weight: 1,
        enabled: true,
      }],
    });
  }

  private async capture(items: readonly BridgeMigrationPreviewItem[]): Promise<MigrationBackup> {
    const [targets, credentials, routes] = await Promise.all([
      this.options.store.listTargets(),
      this.options.store.listManagedCredentials(),
      this.options.store.listRoutes(),
    ]);
    const ids = new Set(items.flatMap(item => [item.targetId, item.routeId, ...(item.credentialId ? [item.credentialId] : [])]));
    const selectedCredentials = credentials.filter(item => ids.has(item.id));
    return {
      ids,
      targets: targets.filter(item => ids.has(item.id)),
      credentials: selectedCredentials,
      routes: routes.filter(item => ids.has(item.id)),
      secrets: new Map(await Promise.all(selectedCredentials.map(async item => [
        item.secretRef,
        await this.options.secretStore.resolve(item.secretRef),
      ] as const))),
    };
  }

  private async restore(backup: MigrationBackup): Promise<void> {
    for (const route of await this.options.store.listRoutes()) {
      if (backup.ids.has(route.id)) this.options.store.deleteRoute(route.id);
    }
    for (const credential of await this.options.store.listManagedCredentials()) {
      if (backup.ids.has(credential.id)) {
        this.options.store.deleteCredential(credential.id);
        await this.options.secretStore.remove(credential.secretRef);
      }
    }
    for (const target of await this.options.store.listTargets()) {
      if (backup.ids.has(target.id)) this.options.store.deleteTarget(target.id);
    }
    for (const target of backup.targets) this.options.store.saveTarget(target);
    for (const credential of backup.credentials) this.options.store.saveCredential(credential);
    for (const route of backup.routes) this.options.store.saveRoute(route);
    for (const [ref, value] of backup.secrets) {
      if (value !== undefined) await this.options.secretStore.put(ref, value);
    }
  }
}

interface MigrationBackup {
  ids: Set<string>;
  targets: readonly KeywayExecutionTargetPort[];
  credentials: readonly KeywayManagedCredentialPort[];
  routes: readonly KeywayGatewayRoutePort[];
  secrets: Map<string, string | undefined>;
}

function previewConfig(config: PersistedBridgeConfig): BridgeMigrationPreviewItem {
  const name = slug(config.name);
  const kind = (config.execution ?? 'api') === 'cli' ? 'native-cli' : 'managed-api';
  const issues: string[] = [];
  if (!config.model && !config.models?.[0]?.name) issues.push('No model is configured.');
  if (kind === 'native-cli') {
    if (!isManagedExternalCliRuntime(config.runtime)) issues.push('Runtime is not a managed native CLI.');
    const authSource = config.authSource ?? 'native';
    if (authSource !== 'native') {
      issues.push('CLI config uses explicit API-key auth; only native CLI auth can be migrated without changing semantics.');
    }
  } else {
    if (!config.baseURL) issues.push('No base URL is configured.');
    if (!config.apiKey) issues.push('No legacy API key is available to copy.');
  }
  return {
    configName: config.name,
    kind,
    ready: issues.length === 0,
    targetId: `target.bridge.${name}`,
    routeId: `route.bridge.${name}`,
    ...(kind === 'managed-api' ? { credentialId: `credential.bridge.${name}` } : {}),
    containsLegacyApiKey: kind === 'managed-api' && !!config.apiKey,
    issues,
  };
}

function slug(value: string): string {
  const result = value.trim().replace(/[^A-Za-z0-9._:-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return result || randomUUID();
}

async function readPortableFile(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as unknown;
}

function portablePreview(value: Record<string, unknown>): PortableMigrationPreview {
  const count = (field: string) => Array.isArray(value[field]) ? value[field].length : 0;
  return {
    source: 'keyway-export-v1',
    counts: {
      groups: count('groups'),
      targets: count('targets'),
      credentialMetadata: count('credentialMetadata'),
      routes: count('routes'),
      budgetPolicies: count('budgetPolicies'),
      issuedKeys: count('issuedKeys'),
      usageEvents: count('usageEvents'),
    },
    secretsIncluded: false,
    issuedKeysRequireRotation: count('issuedKeys') > 0,
  };
}
