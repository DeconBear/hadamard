import type { UsageCounters, UsageEventV2 } from '../usage/contracts.js';

export type KeywayJson = null | boolean | number | string | KeywayJson[] | { [key: string]: KeywayJson };

export interface KeywayManagedTargetPort {
  kind: 'managed-api';
  id: string;
  providerId: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  enabled: boolean;
}

export interface KeywayNativeTargetPort {
  kind: 'native-cli';
  id: string;
  runtime: string;
  profileName?: string;
  configId?: string;
  enabled: boolean;
}

export type KeywayExecutionTargetPort = KeywayManagedTargetPort | KeywayNativeTargetPort;

export interface KeywayManagedCredentialPort {
  id: string;
  providerId: string;
  secretRef: string;
  label: string;
  priority: number;
  weight: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KeywayCredentialHealthPort {
  credentialId: string;
  state: 'unknown' | 'healthy' | 'degraded' | 'circuit-open' | 'disabled';
  consecutiveFailures: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  circuitOpenUntil?: string;
}

export interface KeywayRouteCandidatePort {
  id: string;
  targetId: string;
  upstreamModel: string;
  priority: number;
  weight: number;
  enabled: boolean;
}

export interface KeywayGatewayRoutePort {
  id: string;
  alias: string;
  mode: 'direct' | 'priority-failover';
  candidates: readonly KeywayRouteCandidatePort[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KeywayProviderRequestPort {
  requestId: string;
  correlationId: string;
  operation: 'generate' | 'stream';
  target: KeywayExecutionTargetPort;
  upstreamModel: string;
  credential?: { id: string; secret: string };
  payload: KeywayJson;
  metadata?: Readonly<Record<string, KeywayJson>>;
  signal?: AbortSignal;
}

export type KeywayStreamEventPort =
  | { type: 'data'; value: KeywayJson }
  | { type: 'usage'; usage: UsageCounters }
  | { type: 'provider-event'; value: KeywayJson };

export interface KeywayProviderResultPort {
  output: KeywayJson;
  usage: UsageCounters;
  statusCode?: number;
  providerRequestId?: string;
}

export interface KeywayProviderHandlePort extends AsyncIterable<KeywayStreamEventPort> {
  result: Promise<KeywayProviderResultPort>;
  cancel(reason?: unknown): void;
}

export interface KeywayProviderExecutorPort {
  execute(request: KeywayProviderRequestPort): KeywayProviderHandlePort;
}

export interface KeywayExecutionRequestPort {
  requestId: string;
  correlationId: string;
  routeAlias: string;
  requestedModel: string;
  operation: 'generate' | 'stream';
  payload: KeywayJson;
  estimatedUsage?: Partial<UsageCounters>;
  metadata?: Readonly<Record<string, KeywayJson>>;
  signal?: AbortSignal;
}

export interface KeywayExecutionResultPort extends KeywayProviderResultPort {
  requestId: string;
  correlationId: string;
  routeId: string;
}

export interface KeywayExecutionHandlePort extends AsyncIterable<KeywayStreamEventPort> {
  result: Promise<KeywayExecutionResultPort>;
  cancel(reason?: unknown): void;
}

export interface KeywayCorePort {
  execute(request: KeywayExecutionRequestPort): KeywayExecutionHandlePort;
}

export interface KeywaySecretStorePort {
  put(secretRef: string, value: string): Promise<void>;
  resolve(secretRef: string): Promise<string | undefined>;
  has(secretRef: string): Promise<boolean>;
  remove(secretRef: string): Promise<void>;
}

export interface KeywayStorePort {
  close(): void;
  saveTarget(target: KeywayExecutionTargetPort): void;
  listTargets(): Promise<readonly KeywayExecutionTargetPort[]>;
  deleteTarget(targetId: string): boolean;
  saveCredential(credential: KeywayManagedCredentialPort): void;
  listManagedCredentials(providerId?: string): Promise<readonly KeywayManagedCredentialPort[]>;
  deleteCredential(credentialId: string): boolean;
  getCredentialHealth(credentialId: string): Promise<KeywayCredentialHealthPort | undefined>;
  saveRoute(route: KeywayGatewayRoutePort): void;
  listRoutes(): Promise<readonly KeywayGatewayRoutePort[]>;
  deleteRoute(routeId: string): boolean;
  saveBudgetPolicy(policy: import('../usage/contracts.js').BudgetPolicy): void;
  listManagedBudgetPolicies(): Promise<readonly import('../usage/contracts.js').BudgetPolicy[]>;
  deleteBudgetPolicy(policyId: string): boolean;
}

export interface KeywaySdkModulesPort {
  core: {
    KEYWAY_CONTRACT_VERSION: 1;
    createKeywayCore(options: {
      store: unknown;
      secretStore: KeywaySecretStorePort;
      executor: KeywayProviderExecutorPort;
      usageSink: { append(event: UsageEventV2): Promise<void> };
    }): KeywayCorePort;
  };
  node: {
    SqliteKeywayStore: new (options: { filePath: string }) => KeywayStorePort;
    EnvironmentSecretStore: new (environment?: NodeJS.ProcessEnv, prefix?: string) => KeywaySecretStorePort;
    EncryptedFileSecretStore: new (options: { filePath: string; masterKey: Uint8Array }) => KeywaySecretStorePort;
    CompositeSecretStore: new (managed: KeywaySecretStorePort, environment?: KeywaySecretStorePort) => KeywaySecretStorePort;
    decodeMasterKey(value: string): Uint8Array;
  };
}
