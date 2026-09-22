export const KEYWAY_CONTRACT_VERSION = 1 as const;
export const USAGE_EVENT_VERSION = 2 as const;
export const KEYWAY_EXPORT_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ProviderProtocol = 'openai' | 'anthropic';
export type ExecutionOperation = 'generate' | 'stream';
export type UsageAccuracy = 'actual' | 'estimated' | 'unknown';

export interface UsageCounters {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly audioInputTokens: number;
  readonly audioOutputTokens: number;
  readonly costUsd?: number;
  readonly accuracy: UsageAccuracy;
}

export interface ManagedApiTarget {
  readonly kind: 'managed-api';
  readonly id: string;
  readonly providerId: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly enabled: boolean;
}

export interface NativeCliTarget {
  readonly kind: 'native-cli';
  readonly id: string;
  /** Runtime identifier is adapter-owned; Keyway core does not depend on a fixed CLI catalog. */
  readonly runtime: string;
  readonly profileName?: string;
  readonly configId?: string;
  readonly enabled: boolean;
}

export type ExecutionTarget = ManagedApiTarget | NativeCliTarget;

export interface ManagedCredential {
  readonly id: string;
  readonly providerId: string;
  readonly secretRef: string;
  readonly label: string;
  readonly priority: number;
  readonly weight: number;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CredentialHealth {
  readonly credentialId: string;
  readonly state: 'unknown' | 'healthy' | 'degraded' | 'circuit-open' | 'disabled';
  readonly consecutiveFailures: number;
  readonly lastSuccessAt?: string;
  readonly lastFailureAt?: string;
  readonly circuitOpenUntil?: string;
}

export interface GatewayRouteCandidate {
  readonly id: string;
  readonly targetId: string;
  readonly upstreamModel: string;
  readonly priority: number;
  readonly weight: number;
  readonly enabled: boolean;
}

export interface GatewayRoute {
  readonly id: string;
  readonly alias: string;
  readonly mode: 'direct' | 'priority-failover';
  readonly candidates: readonly GatewayRouteCandidate[];
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type BudgetScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'provider'; readonly id: string }
  | { readonly kind: 'credential'; readonly id: string }
  | { readonly kind: 'route'; readonly id: string }
  | { readonly kind: 'model'; readonly id: string };

export type BudgetPeriod = 'daily' | 'monthly' | 'lifetime';
export type BudgetMetric = 'requests' | 'totalTokens' | 'costUsd';
export type BudgetAction = 'warn' | 'deny' | 'fallbackRoute';

export interface BudgetPolicy {
  readonly id: string;
  readonly scope: BudgetScope;
  readonly period: BudgetPeriod;
  readonly metric: BudgetMetric;
  readonly limit: number;
  readonly action: BudgetAction;
  readonly fallbackRouteId?: string;
  readonly enabled: boolean;
}

export interface BudgetReservation {
  readonly id: string;
  readonly requestId: string;
  readonly policyId: string;
  readonly metric: BudgetMetric;
  readonly periodKey: string;
  readonly reserved: number;
  readonly createdAt: string;
}

export interface BudgetContext {
  readonly providerId?: string;
  readonly credentialId?: string;
  readonly routeId?: string;
  readonly model?: string;
}

export interface BudgetDecision {
  readonly policyId: string;
  readonly decision: 'allowed' | 'warned' | 'denied' | 'fallback';
  readonly used: number;
  readonly reserved: number;
  readonly requested: number;
  readonly limit: number;
  readonly fallbackRouteId?: string;
}

export interface BudgetReservationOutcome {
  readonly reservations: readonly BudgetReservation[];
  readonly decisions: readonly BudgetDecision[];
}

export interface KeyQuota {
  readonly maxRequests?: number;
  readonly usedRequests: number;
  readonly maxTokens?: number;
  readonly usedTokens: number;
  readonly concurrencyLimit?: number;
  readonly rpmLimit?: number;
  readonly expiresAt?: string;
}

export interface RouteAttempt {
  readonly attempt: number;
  readonly targetId: string;
  readonly providerId?: string;
  readonly credentialId?: string;
  readonly upstreamModel: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'denied';
  readonly statusCode?: number;
  readonly retryable?: boolean;
  readonly latencyMs: number;
  readonly errorCode?: string;
}

export interface UsageEventV2 {
  readonly version: typeof USAGE_EVENT_VERSION;
  readonly eventId: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly timestamp: string;
  readonly source: 'hadamard' | 'bridge' | 'keyway' | 'native-cli' | 'import';
  readonly sessionId?: string;
  readonly runId?: string;
  readonly projectId?: string;
  readonly agentId?: string;
  readonly routeId?: string;
  readonly routeAlias?: string;
  /** Stable Hadamard provider/bridge configuration identifier. */
  readonly configurationId?: string;
  readonly targetId?: string;
  readonly providerId?: string;
  readonly credentialId?: string;
  readonly requestedModel: string;
  readonly resolvedModel?: string;
  readonly operation: ExecutionOperation;
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'denied';
  readonly usage: UsageCounters;
  readonly attempts: readonly RouteAttempt[];
  readonly durationMs: number;
  readonly timeToFirstTokenMs?: number;
  readonly streaming: boolean;
  readonly budgetDecision?: 'allowed' | 'warned' | 'denied' | 'fallback';
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface KeywayExecutionRequest {
  readonly requestId: string;
  readonly correlationId: string;
  readonly routeAlias: string;
  readonly requestedModel: string;
  readonly operation: ExecutionOperation;
  readonly payload: JsonValue;
  readonly estimatedUsage?: Partial<UsageCounters>;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly signal?: AbortSignal;
}

export interface ProviderExecutionRequest {
  readonly requestId: string;
  readonly correlationId: string;
  readonly operation: ExecutionOperation;
  readonly target: ExecutionTarget;
  readonly upstreamModel: string;
  readonly credential?: {
    readonly id: string;
    readonly secret: string;
  };
  readonly payload: JsonValue;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly signal?: AbortSignal;
}

export type KeywayStreamEvent =
  | { readonly type: 'data'; readonly value: JsonValue }
  | { readonly type: 'usage'; readonly usage: UsageCounters }
  | { readonly type: 'provider-event'; readonly value: JsonValue };

export interface ProviderExecutionResult {
  readonly output: JsonValue;
  readonly usage: UsageCounters;
  readonly statusCode?: number;
  readonly providerRequestId?: string;
}

export interface ProviderExecutionHandle extends AsyncIterable<KeywayStreamEvent> {
  readonly result: Promise<ProviderExecutionResult>;
  cancel(reason?: unknown): void;
}

export interface ProviderExecutor {
  execute(request: ProviderExecutionRequest): ProviderExecutionHandle;
}

export interface SecretStore {
  put(secretRef: string, value: string): Promise<void>;
  resolve(secretRef: string): Promise<string | undefined>;
  has(secretRef: string): Promise<boolean>;
  remove(secretRef: string): Promise<void>;
}

export interface UsageSink {
  append(event: UsageEventV2): Promise<void>;
}

export interface KeywayTransaction {
  getRouteByAlias(alias: string): Promise<GatewayRoute | undefined>;
  getRouteById(id: string): Promise<GatewayRoute | undefined>;
  getTarget(id: string): Promise<ExecutionTarget | undefined>;
  listCredentials(providerId: string): Promise<readonly ManagedCredential[]>;
  getCredentialHealth(credentialId: string): Promise<CredentialHealth | undefined>;
  listBudgetPolicies(): Promise<readonly BudgetPolicy[]>;
  reserveBudget(
    requestId: string,
    estimatedUsage: Partial<UsageCounters>,
    context?: BudgetContext,
  ): Promise<BudgetReservationOutcome>;
  reconcileBudget(reservations: readonly BudgetReservation[], usage: UsageCounters): Promise<void>;
  recordCredentialSuccess(credentialId: string, at: string): Promise<void>;
  recordCredentialFailure(credentialId: string, at: string, retryable: boolean): Promise<void>;
}

export interface KeywayStore {
  transaction<T>(operation: (transaction: KeywayTransaction) => Promise<T>): Promise<T>;
}

/** CRUD surface used by embedding hosts; execution only depends on KeywayStore. */
export interface KeywayAdminStore extends KeywayStore {
  saveTarget(target: ExecutionTarget): void;
  listTargets(): Promise<readonly ExecutionTarget[]>;
  deleteTarget(targetId: string): boolean;
  saveCredential(credential: ManagedCredential): void;
  listManagedCredentials(providerId?: string): Promise<readonly ManagedCredential[]>;
  deleteCredential(credentialId: string): boolean;
  saveRoute(route: GatewayRoute): void;
  listRoutes(): Promise<readonly GatewayRoute[]>;
  deleteRoute(routeId: string): boolean;
  saveBudgetPolicy(policy: BudgetPolicy): void;
  listManagedBudgetPolicies(): Promise<readonly BudgetPolicy[]>;
  deleteBudgetPolicy(policyId: string): boolean;
}

export interface KeywayCoreOptions {
  readonly store: KeywayStore;
  readonly secretStore: SecretStore;
  readonly executor: ProviderExecutor;
  readonly usageSink: UsageSink;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface KeywayExecutionResult extends ProviderExecutionResult {
  readonly requestId: string;
  readonly correlationId: string;
  readonly routeId: string;
  readonly attempts: readonly RouteAttempt[];
}

export interface KeywayExecutionHandle extends AsyncIterable<KeywayStreamEvent> {
  readonly result: Promise<KeywayExecutionResult>;
  cancel(reason?: unknown): void;
}

export interface KeywayCore {
  execute(request: KeywayExecutionRequest): KeywayExecutionHandle;
}

export type CreateKeywayCore = (options: KeywayCoreOptions) => KeywayCore;

export interface KeywayExportV1 {
  readonly version: typeof KEYWAY_EXPORT_VERSION;
  readonly exportedAt: string;
  readonly groups: readonly {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
  }[];
  readonly targets: readonly ExecutionTarget[];
  readonly credentialMetadata: readonly Omit<ManagedCredential, 'secretRef'>[];
  readonly routes: readonly GatewayRoute[];
  readonly budgetPolicies: readonly BudgetPolicy[];
  readonly issuedKeys: readonly {
    readonly id: string;
    readonly groupId: string;
    readonly prefix: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly quota: KeyQuota;
  }[];
  readonly usageEvents: readonly UsageEventV2[];
}
