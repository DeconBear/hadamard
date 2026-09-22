import { describe, expect, it } from 'vitest';

import {
  assertBudgetPolicy,
  assertGatewayRoute,
  assertUsageEventV2,
  KEYWAY_CONTRACT_VERSION,
  KEYWAY_EXPORT_VERSION,
  USAGE_EVENT_VERSION,
  type BudgetPolicy,
  type GatewayRoute,
  type UsageEventV2,
} from '../src/keyway/vendor/core/index.js';

const now = '2026-08-25T00:00:00.000Z';

function route(): GatewayRoute {
  return {
    id: 'route.primary',
    alias: 'chat-default',
    mode: 'priority-failover',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    candidates: [
      {
        id: 'candidate.primary',
        targetId: 'target.ark',
        upstreamModel: 'glm-5.2',
        priority: 0,
        weight: 1,
        enabled: true,
      },
      {
        id: 'candidate.fallback',
        targetId: 'target.ark',
        upstreamModel: 'glm-5.3',
        priority: 1,
        weight: 1,
        enabled: true,
      },
    ],
  };
}

function event(): UsageEventV2 {
  return {
    version: USAGE_EVENT_VERSION,
    eventId: 'event.1',
    requestId: 'request.1',
    correlationId: 'correlation.1',
    timestamp: now,
    source: 'bridge',
    configurationId: 'claude-native',
    requestedModel: 'chat-default',
    resolvedModel: 'glm-5.2',
    operation: 'stream',
    status: 'succeeded',
    usage: {
      requests: 1,
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      audioInputTokens: 0,
      audioOutputTokens: 0,
      costUsd: 0.001,
      accuracy: 'actual',
    },
    attempts: [],
    durationMs: 50,
    streaming: true,
  };
}

describe('versioned contracts', () => {
  it('pins independent contract, usage and export versions', () => {
    expect(KEYWAY_CONTRACT_VERSION).toBe(1);
    expect(USAGE_EVENT_VERSION).toBe(2);
    expect(KEYWAY_EXPORT_VERSION).toBe(1);
  });

  it('accepts direct and priority-failover routes with valid candidates', () => {
    expect(() => assertGatewayRoute(route())).not.toThrow();
    expect(() => assertGatewayRoute({
      ...route(),
      mode: 'direct',
      candidates: [route().candidates[0]!],
    })).not.toThrow();
  });

  it('rejects ambiguous direct routes', () => {
    expect(() => assertGatewayRoute({ ...route(), mode: 'direct' })).toThrow(/exactly one/u);
  });

  it('requires a fallback target only for fallbackRoute budget actions', () => {
    const valid: BudgetPolicy = {
      id: 'budget.global',
      scope: { kind: 'global' },
      period: 'monthly',
      metric: 'costUsd',
      limit: 10,
      action: 'fallbackRoute',
      fallbackRouteId: 'route.fallback',
      enabled: true,
    };
    expect(() => assertBudgetPolicy(valid)).not.toThrow();
    const { fallbackRouteId: _fallbackRouteId, ...missingFallback } = valid;
    expect(() => assertBudgetPolicy(missingFallback)).toThrow(/requires/u);
  });

  it('validates cache-aware usage events without storing prompt content', () => {
    expect(() => assertUsageEventV2(event())).not.toThrow();
    expect(JSON.stringify(event())).not.toContain('prompt');
  });

  it('rejects inconsistent token totals', () => {
    const value = event();
    expect(() => assertUsageEventV2({
      ...value,
      usage: { ...value.usage, totalTokens: 1 },
    })).toThrow(/totalTokens/u);
  });
});
