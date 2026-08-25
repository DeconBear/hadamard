export type UsageSource = 'hadamard' | 'bridge' | 'keyway' | 'native-cli' | 'import';
export type UsageStatus = 'succeeded' | 'failed' | 'cancelled' | 'denied';
export type UsageAccuracy = 'actual' | 'estimated' | 'unknown';

export interface UsageCounters {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  audioInputTokens: number;
  audioOutputTokens: number;
  costUsd?: number;
  accuracy: UsageAccuracy;
}

export interface UsageRouteAttempt {
  attempt: number;
  targetId: string;
  providerId?: string;
  credentialId?: string;
  upstreamModel: string;
  startedAt: string;
  completedAt: string;
  status: UsageStatus;
  statusCode?: number;
  retryable?: boolean;
  latencyMs: number;
  errorCode?: string;
}

interface UsageEventRequest {
  version: 2;
  eventId: string;
  requestId: string;
  correlationId: string;
  timestamp: string;
  source: UsageSource;
  status: UsageStatus;
  requestedModel: string;
  resolvedModel?: string;
  operation: 'generate' | 'stream';
}

interface UsageEventAttribution {
  providerId?: string;
  credentialId?: string;
  routeId?: string;
  routeAlias?: string;
  targetId?: string;
  configurationId?: string;
  projectId?: string;
  agentId?: string;
  sessionId?: string;
  runId?: string;
}

interface UsageEventResult {
  usage: UsageCounters;
  attempts: readonly UsageRouteAttempt[];
  durationMs: number;
  timeToFirstTokenMs?: number;
  streaming: boolean;
  budgetDecision?: 'allowed' | 'warned' | 'denied' | 'fallback';
}

/** Stable, prompt-free event contract shared by the ledger and Keyway adapters. */
export type UsageEventV2 = UsageEventRequest & UsageEventAttribution & UsageEventResult;

export interface UsageFilter {
  from?: string;
  to?: string;
  source?: UsageSource;
  status?: UsageStatus;
  model?: string;
  providerId?: string;
  credentialId?: string;
  routeId?: string;
  configurationId?: string;
  projectId?: string;
  agentId?: string;
  sessionId?: string;
  runId?: string;
}

export interface UsagePage extends UsageFilter {
  limit?: number;
  offset?: number;
}

export interface UsageSummary extends UsageCounters {
  entries: number;
}

export interface UsageImportResult {
  imported: number;
  skipped: number;
  malformed: number;
}

export type BudgetScope =
  | { kind: 'global' }
  | { kind: 'provider'; id: string }
  | { kind: 'credential'; id: string }
  | { kind: 'route'; id: string }
  | { kind: 'model'; id: string };

export type BudgetMetric = 'requests' | 'totalTokens' | 'costUsd';
export type BudgetPeriod = 'daily' | 'monthly' | 'lifetime';
export type BudgetAction = 'warn' | 'deny' | 'fallbackRoute';

export interface BudgetPolicy {
  id: string;
  scope: BudgetScope;
  period: BudgetPeriod;
  metric: BudgetMetric;
  limit: number;
  action: BudgetAction;
  fallbackRouteId?: string;
  enabled: boolean;
}

export interface BudgetReservation {
  id: string;
  requestId: string;
  policyId: string;
  metric: BudgetMetric;
  periodKey: string;
  reserved: number;
  createdAt: string;
}

export interface BudgetContext {
  providerId?: string;
  credentialId?: string;
  routeId?: string;
  model?: string;
}

export interface BudgetDecision {
  policyId: string;
  decision: 'allowed' | 'warned' | 'denied' | 'fallback';
  used: number;
  reserved: number;
  requested: number;
  limit: number;
  fallbackRouteId?: string;
}

export interface BudgetReservationOutcome {
  reservations: readonly BudgetReservation[];
  decisions: readonly BudgetDecision[];
}
