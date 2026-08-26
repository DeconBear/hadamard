import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeBridgeConfigs } from '../src/parity/bridgeConfigs.js';
import { KeywayMigrationService } from '../src/keyway/keywayMigrationService.js';
import type {
  KeywayExecutionTargetPort,
  KeywayGatewayRoutePort,
  KeywayManagedCredentialPort,
  KeywaySdkModulesPort,
  KeywaySecretStorePort,
  KeywayStorePort,
} from '../src/keyway/keywayPorts.js';
import type { BudgetPolicy } from '../src/usage/contracts.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

class Store implements KeywayStorePort {
  targets: KeywayExecutionTargetPort[] = [];
  credentials: KeywayManagedCredentialPort[] = [];
  routes: KeywayGatewayRoutePort[] = [];
  budgets: BudgetPolicy[] = [];
  failRoute = false;
  close() {}
  saveTarget(value: KeywayExecutionTargetPort) { upsert(this.targets, value); }
  async listTargets() { return this.targets; }
  deleteTarget(id: string) { return remove(this.targets, id); }
  saveCredential(value: KeywayManagedCredentialPort) { upsert(this.credentials, value); }
  async listManagedCredentials() { return this.credentials; }
  deleteCredential(id: string) { return remove(this.credentials, id); }
  async getCredentialHealth() { return undefined; }
  saveRoute(value: KeywayGatewayRoutePort) {
    if (this.failRoute) throw new Error('route write failed');
    upsert(this.routes, value);
  }
  async listRoutes() { return this.routes; }
  deleteRoute(id: string) { return remove(this.routes, id); }
  saveBudgetPolicy(value: BudgetPolicy) { upsert(this.budgets, value); }
  async listManagedBudgetPolicies() { return this.budgets; }
  deleteBudgetPolicy(id: string) { return remove(this.budgets, id); }
}

class Secrets implements KeywaySecretStorePort {
  values = new Map<string, string>();
  async put(ref: string, value: string) { this.values.set(ref, value); }
  async resolve(ref: string) { return this.values.get(ref); }
  async has(ref: string) { return this.values.has(ref); }
  async remove(ref: string) { this.values.delete(ref); }
}

describe('KeywayMigrationService', () => {
  it('previews and imports bridge API keys while leaving native OAuth owned by the CLI', async () => {
    const homeDir = await temporaryHome();
    writeBridgeConfigs({ configs: [
      {
        name: 'Ark Primary',
        runtime: 'hadamard',
        execution: 'api',
        authSource: 'apiKey',
        provider: 'openai',
        apiKey: 'secret-canary',
        baseURL: 'https://ark.example.test/v1',
        model: 'glm-5.2',
      },
      {
        name: 'Codex Native',
        runtime: 'codex',
        execution: 'cli',
        authSource: 'native',
        provider: 'openai',
        model: 'gpt-5',
      },
      {
        name: 'Claude CLI with API key',
        runtime: 'claude',
        execution: 'cli',
        authSource: 'apiKey',
        provider: 'anthropic',
        apiKey: 'must-not-be-silently-dropped',
        model: 'claude-test',
      },
    ] }, homeDir);
    const store = new Store();
    const secrets = new Secrets();
    const service = new KeywayMigrationService({ homeDir, store, secretStore: secrets });
    expect(service.previewBridgeConfigs()).toMatchObject({
      ready: 2,
      blocked: 1,
      oauthSessionSecretsRead: false,
      items: [
        { kind: 'managed-api', containsLegacyApiKey: true },
        { kind: 'native-cli', containsLegacyApiKey: false },
        {
          kind: 'native-cli',
          ready: false,
          issues: [expect.stringContaining('explicit API-key auth')],
        },
      ],
    });
    const result = await service.importBridgeConfigs();
    expect(result).toMatchObject({
      imported: 2,
      skipped: 1,
      legacyApiKeysRetained: true,
      oauthSessionSecretsRead: false,
    });
    expect(store.targets).toEqual([
      expect.objectContaining({ kind: 'managed-api', providerId: 'bridge.Ark-Primary' }),
      expect.objectContaining({ kind: 'native-cli', runtime: 'codex', configId: 'Codex Native' }),
    ]);
    expect(store.routes).toHaveLength(2);
    expect(secrets.values.get('secret:credential.bridge.Ark-Primary')).toBe('secret-canary');
    expect(JSON.stringify(result)).not.toContain('secret-canary');
  });

  it('restores metadata and removes copied API keys if bridge import fails', async () => {
    const homeDir = await temporaryHome();
    writeBridgeConfigs({ configs: [{
      name: 'Broken',
      runtime: 'hadamard',
      execution: 'api',
      provider: 'openai',
      apiKey: 'secret-canary',
      baseURL: 'https://example.test/v1',
      model: 'model',
    }] }, homeDir);
    const store = new Store();
    store.failRoute = true;
    const secrets = new Secrets();
    const service = new KeywayMigrationService({ homeDir, store, secretStore: secrets });
    await expect(service.importBridgeConfigs()).rejects.toThrow('route write failed');
    expect(store.targets).toEqual([]);
    expect(store.credentials).toEqual([]);
    expect(secrets.values.size).toBe(0);
  });

  it('previews and delegates secret-free portable imports through the versioned SDK contract', async () => {
    const homeDir = await temporaryHome();
    const filePath = path.join(homeDir, 'keyway-export-v1.json');
    const snapshot = {
      version: 1,
      exportedAt: '2026-08-26T00:00:00.000Z',
      groups: [],
      targets: [{ kind: 'native-cli', id: 'target.codex', runtime: 'codex', enabled: true }],
      credentialMetadata: [],
      routes: [],
      budgetPolicies: [],
      issuedKeys: [{ id: 'key.1', groupId: 'default', prefix: 'db_sk_ab', name: 'legacy', enabled: true, quota: { usedRequests: 0, usedTokens: 0 } }],
      usageEvents: [],
    };
    await writeFile(filePath, JSON.stringify(snapshot), 'utf8');
    let validated: unknown;
    let imported: unknown;
    const modules = {
      core: {
        assertKeywayExportV1(value: unknown) { validated = value; },
      },
      node: {
        async importKeywayV1(_store: KeywayStorePort, value: unknown) {
          imported = value;
          return { targets: 1, issuedKeys: 1 };
        },
      },
    } as unknown as KeywaySdkModulesPort;
    const service = new KeywayMigrationService({
      homeDir,
      store: new Store(),
      secretStore: new Secrets(),
      modules,
    });
    await expect(service.previewPortableFile(filePath)).resolves.toMatchObject({
      counts: { targets: 1, issuedKeys: 1 },
      secretsIncluded: false,
      issuedKeysRequireRotation: true,
    });
    await expect(service.importPortableFile(filePath)).resolves.toMatchObject({
      targets: 1,
      issuedKeys: 1,
      rollback: 'sqlite-transaction',
      credentialsRequireSecretBinding: true,
      issuedKeysRequireRotation: true,
    });
    expect(validated).toEqual(snapshot);
    expect(imported).toEqual(snapshot);
  });
});

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'hadamard-keyway-migration-'));
  roots.push(root);
  return root;
}

function upsert<T extends { id: string }>(items: T[], value: T): void {
  const index = items.findIndex(item => item.id === value.id);
  if (index === -1) items.push(value);
  else items[index] = value;
}

function remove<T extends { id: string }>(items: T[], id: string): boolean {
  const index = items.findIndex(item => item.id === id);
  if (index === -1) return false;
  items.splice(index, 1);
  return true;
}
