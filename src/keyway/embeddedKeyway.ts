import path from 'node:path';

import type { ModelApi } from '../types.js';
import { UsageLedger } from '../usage/usageLedger.js';
import { usageDatabasePath } from '../usage/usageQueryService.js';
import { KeywayModelApi, type KeywayModelApiOptions } from './keywayModelApi.js';
import { KeywayLoopbackGatewayController } from './keywayLoopbackGateway.js';
import {
  HadamardKeywayProviderExecutor,
  type HadamardKeywayProviderExecutorOptions,
} from './keywayProviderExecutor.js';
import type {
  KeywayCorePort,
  KeywaySdkModulesPort,
  KeywaySecretStorePort,
  KeywayStorePort,
} from './keywayPorts.js';

export interface EmbeddedKeywayOptions extends HadamardKeywayProviderExecutorOptions {
  homeDir: string;
  secretStore: KeywaySecretStorePort;
  modules?: KeywaySdkModulesPort;
  keywayDatabaseFile?: string;
  usageDatabaseFile?: string;
}

export interface EmbeddedKeyway {
  core: KeywayCorePort;
  store: KeywayStorePort;
  executor: HadamardKeywayProviderExecutor;
  gateway: KeywayLoopbackGatewayController;
  modelApi(options: Omit<KeywayModelApiOptions, 'core'>): ModelApi;
  close(): Promise<void>;
}

export interface HeadlessKeywaySecretStoreOptions {
  homeDir: string;
  environment?: NodeJS.ProcessEnv;
  modules?: KeywaySdkModulesPort;
}

/** Loads the independently versioned Keyway TS packages without a Python sidecar. */
export async function loadKeywaySdkModules(): Promise<KeywaySdkModulesPort> {
  const corePackage = '@keyway-router/core';
  const nodePackage = '@keyway-router/node';
  try {
    const [core, node] = await Promise.all([import(corePackage), import(nodePackage)]);
    if (core.KEYWAY_CONTRACT_VERSION !== 1) {
      throw new Error(`Unsupported Keyway contract version: ${String(core.KEYWAY_CONTRACT_VERSION)}`);
    }
    return { core, node } as unknown as KeywaySdkModulesPort;
  } catch (error) {
    throw new Error(
      'Keyway TS packages are unavailable. Install matching @keyway-router/core and @keyway-router/node versions.',
      { cause: error },
    );
  }
}

export async function createEmbeddedKeyway(options: EmbeddedKeywayOptions): Promise<EmbeddedKeyway> {
  const modules = options.modules ?? await loadKeywaySdkModules();
  const store = new modules.node.SqliteKeywayStore({
    filePath: options.keywayDatabaseFile ?? path.join(options.homeDir, 'keyway', 'keyway.sqlite'),
  });
  const usageLedger = await UsageLedger.open({
    filename: options.usageDatabaseFile ?? usageDatabasePath(options.homeDir),
  });
  try {
    const executor = new HadamardKeywayProviderExecutor(options);
    const core = modules.core.createKeywayCore({
      store,
      secretStore: options.secretStore,
      executor,
      usageSink: {
        async append(event) {
          usageLedger.append(event);
        },
      },
    });
    const gateway = new KeywayLoopbackGatewayController({ core, store });
    return {
      core,
      store,
      executor,
      gateway,
      modelApi(modelOptions) {
        return new KeywayModelApi({ core, ...modelOptions });
      },
      async close() {
        await gateway.stop();
        usageLedger.close();
        store.close();
      },
    };
  } catch (error) {
    usageLedger.close();
    store.close();
    throw error;
  }
}

/**
 * Headless/TUI policy: env refs are always readable; managed write-only secrets
 * require an explicit AES-256-GCM master key and are never stored as plaintext.
 */
export async function createHeadlessKeywaySecretStore(
  options: HeadlessKeywaySecretStoreOptions,
): Promise<KeywaySecretStorePort> {
  const modules = options.modules ?? await loadKeywaySdkModules();
  const environment = options.environment ?? process.env;
  const environmentStore = new modules.node.EnvironmentSecretStore(environment);
  const masterKey = environment.HADAMARD_KEYWAY_MASTER_KEY?.trim();
  if (!masterKey) return environmentStore;
  const managed = new modules.node.EncryptedFileSecretStore({
    filePath: path.join(options.homeDir, 'keyway', 'secrets.aes-gcm.json'),
    masterKey: modules.node.decodeMasterKey(masterKey),
  });
  return new modules.node.CompositeSecretStore(managed, environmentStore);
}
