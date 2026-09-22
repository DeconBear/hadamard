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
import * as keywayCoreSdk from './vendor/core/index.js';
import * as keywayNodeSdk from './vendor/node/index.js';

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

/**
 * The Keyway TS SDK is vendored in-tree under `src/keyway/vendor/`, so the
 * embedded runtime needs no external packages or Python sidecar. The contract
 * version guard stays so an incompatible vendored bump fails loudly.
 */
export async function loadKeywaySdkModules(): Promise<KeywaySdkModulesPort> {
  const core = keywayCoreSdk;
  const node = keywayNodeSdk;
  if (core.KEYWAY_CONTRACT_VERSION !== 1) {
    throw new Error(`Unsupported Keyway contract version: ${String(core.KEYWAY_CONTRACT_VERSION)}`);
  }
  return { core, node } as unknown as KeywaySdkModulesPort;
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
