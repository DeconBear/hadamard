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
  };
}
