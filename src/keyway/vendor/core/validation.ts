import {
  KEYWAY_EXPORT_VERSION,
  USAGE_EVENT_VERSION,
  type BudgetPolicy,
  type GatewayRoute,
  type KeywayExportV1,
  type UsageCounters,
  type UsageEventV2,
} from './contracts.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function assertIdentifier(value: string, field: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new TypeError(`${field} must match ${IDENTIFIER.source}.`);
  }
}

export function assertUsageCounters(usage: UsageCounters): void {
  const integerFields = [
    'requests',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'audioInputTokens',
    'audioOutputTokens',
  ] as const;
  for (const field of integerFields) {
    const value = usage[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`usage.${field} must be a non-negative safe integer.`);
    }
  }
  if (usage.totalTokens < usage.inputTokens + usage.outputTokens) {
    throw new RangeError('usage.totalTokens cannot be smaller than inputTokens + outputTokens.');
  }
  if (usage.costUsd !== undefined && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)) {
    throw new RangeError('usage.costUsd must be a finite, non-negative number.');
  }
}

export function assertGatewayRoute(route: GatewayRoute): void {
  assertIdentifier(route.id, 'route.id');
  if (!route.alias.trim()) throw new TypeError('route.alias is required.');
  if (route.candidates.length === 0) throw new TypeError('route.candidates must not be empty.');
  if (route.mode === 'direct' && route.candidates.filter(candidate => candidate.enabled).length !== 1) {
    throw new TypeError('A direct route must have exactly one enabled candidate.');
  }
  for (const candidate of route.candidates) {
    assertIdentifier(candidate.id, 'candidate.id');
    assertIdentifier(candidate.targetId, 'candidate.targetId');
    if (!candidate.upstreamModel.trim()) throw new TypeError('candidate.upstreamModel is required.');
    if (!Number.isSafeInteger(candidate.priority)) throw new TypeError('candidate.priority must be an integer.');
    if (!Number.isSafeInteger(candidate.weight) || candidate.weight < 1) {
      throw new TypeError('candidate.weight must be a positive integer.');
    }
  }
}

export function assertBudgetPolicy(policy: BudgetPolicy): void {
  assertIdentifier(policy.id, 'policy.id');
  if (!Number.isFinite(policy.limit) || policy.limit <= 0) {
    throw new RangeError('policy.limit must be a finite positive number.');
  }
  if (policy.action === 'fallbackRoute' && !policy.fallbackRouteId) {
    throw new TypeError('fallbackRoute action requires fallbackRouteId.');
  }
  if (policy.action !== 'fallbackRoute' && policy.fallbackRouteId !== undefined) {
    throw new TypeError('fallbackRouteId is only valid with fallbackRoute action.');
  }
}

export function assertUsageEventV2(event: UsageEventV2): void {
  if (event.version !== USAGE_EVENT_VERSION) throw new TypeError('Unsupported usage event version.');
  assertIdentifier(event.eventId, 'event.eventId');
  assertIdentifier(event.requestId, 'event.requestId');
  assertIdentifier(event.correlationId, 'event.correlationId');
  if (!event.requestedModel.trim()) throw new TypeError('event.requestedModel is required.');
  if (!Number.isFinite(event.durationMs) || event.durationMs < 0) {
    throw new RangeError('event.durationMs must be a finite, non-negative number.');
  }
  assertUsageCounters(event.usage);
}

export function assertKeywayExportV1(value: KeywayExportV1): void {
  if (value.version !== KEYWAY_EXPORT_VERSION) throw new TypeError('Unsupported Keyway export version.');
  for (const route of value.routes) assertGatewayRoute(route);
  for (const policy of value.budgetPolicies) assertBudgetPolicy(policy);
  for (const event of value.usageEvents) assertUsageEventV2(event);
}
