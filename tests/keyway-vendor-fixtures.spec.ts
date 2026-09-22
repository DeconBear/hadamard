import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  assertBudgetPolicy,
  assertGatewayRoute,
  assertKeywayExportV1,
  assertUsageCounters,
  type BudgetPolicy,
  type GatewayRoute,
  type KeywayExportV1,
  type UsageCounters,
} from '../src/keyway/vendor/core/index.js';

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/keyway/${name}`, import.meta.url), 'utf8')) as T;
}

describe('frozen parity fixtures', () => {
  it.each(['route-direct.json', 'route-priority-failover.json'])('validates %s', name => {
    expect(() => assertGatewayRoute(fixture<GatewayRoute>(name))).not.toThrow();
  });

  it('validates budget reservation/reconciliation input', () => {
    const value = fixture<{
      policy: BudgetPolicy;
      actualUsage: UsageCounters;
      reservation: { reserved: number };
      expectedRefund: number;
    }>('quota-reconcile.json');
    expect(() => assertBudgetPolicy(value.policy)).not.toThrow();
    expect(() => assertUsageCounters(value.actualUsage)).not.toThrow();
    expect(value.reservation.reserved - value.actualUsage.totalTokens).toBe(value.expectedRefund);
  });

  it('pins cache token mappings for both protocols', () => {
    const value = fixture<Record<'openai' | 'anthropic', {
      expected: { totalTokens: number; cacheReadTokens: number };
    }>>('protocol-usage.json');
    expect(value.openai.expected).toMatchObject({ totalTokens: 150, cacheReadTokens: 80 });
    expect(value.anthropic.expected).toMatchObject({ totalTokens: 150, cacheReadTokens: 80 });
  });

  it('validates KeywayExportV1 without credential material', () => {
    const value = fixture<KeywayExportV1>('keyway-export-v1.json');
    expect(() => assertKeywayExportV1(value)).not.toThrow();
    expect(JSON.stringify(value)).not.toMatch(/api[_-]?key|secret|oauth|token\s*:/iu);
  });
});
