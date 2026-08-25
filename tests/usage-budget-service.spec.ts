import { describe, expect, it } from 'vitest';

import {
  UsageBudgetService,
  type BudgetNotification,
  type BudgetStorePort,
  type BudgetTransactionPort,
} from '../src/usage/budgetService.js';
import type {
  BudgetDecision,
  BudgetReservation,
  BudgetReservationOutcome,
  UsageCounters,
} from '../src/usage/contracts.js';

const emptyUsage: UsageCounters = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  audioInputTokens: 0,
  audioOutputTokens: 0,
  costUsd: 0,
  accuracy: 'actual',
};

function outcome(decision: BudgetDecision): BudgetReservationOutcome {
  return { reservations: [], decisions: [decision] };
}

function decision(kind: BudgetDecision['decision'], fallbackRouteId?: string): BudgetDecision {
  return {
    policyId: 'daily-global',
    decision: kind,
    used: 80,
    reserved: 10,
    requested: 20,
    limit: 100,
    ...(fallbackRouteId ? { fallbackRouteId } : {}),
  };
}

class FakeBudgetStore implements BudgetStorePort, BudgetTransactionPort {
  reconciled: readonly BudgetReservation[] = [];
  constructor(private readonly next: BudgetReservationOutcome) {}

  async transaction<T>(operation: (transaction: BudgetTransactionPort) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async reserveBudget(): Promise<BudgetReservationOutcome> {
    return this.next;
  }

  async reconcileBudget(reservations: readonly BudgetReservation[]): Promise<void> {
    this.reconciled = reservations;
  }
}

describe('UsageBudgetService', () => {
  it('allows warning policies while emitting a user-facing notification', async () => {
    const notifications: BudgetNotification[] = [];
    const service = new UsageBudgetService(
      new FakeBudgetStore(outcome(decision('warned'))),
      notification => notifications.push(notification),
    );
    const result = await service.reserve('request-1', { totalTokens: 20 });
    expect(result.action).toBe('allow');
    expect(notifications).toMatchObject([{
      title: 'Budget warning',
      severity: 'warning',
      body: expect.stringContaining('110%'),
    }]);
  });

  it('returns explicit deny and fallback actions', async () => {
    const denied = await new UsageBudgetService(new FakeBudgetStore(outcome(decision('denied'))))
      .reserve('request-1', { requests: 1 });
    expect(denied.action).toBe('deny');

    const fallback = await new UsageBudgetService(new FakeBudgetStore(outcome(decision('fallback', 'route-backup'))))
      .reserve('request-2', { requests: 1 });
    expect(fallback).toMatchObject({ action: 'fallback', fallbackRouteId: 'route-backup' });
  });

  it('reconciles reservations through the store transaction boundary', async () => {
    const reservation: BudgetReservation = {
      id: 'reservation-1',
      requestId: 'request-1',
      policyId: 'daily-global',
      metric: 'totalTokens',
      periodKey: '2026-08-25',
      reserved: 100,
      createdAt: '2026-08-25T10:00:00.000Z',
    };
    const store = new FakeBudgetStore({ reservations: [reservation], decisions: [] });
    const service = new UsageBudgetService(store);
    await service.reconcile([reservation], { ...emptyUsage, totalTokens: 40 });
    expect(store.reconciled).toEqual([reservation]);
  });
});
