import type {
  BudgetContext,
  BudgetDecision,
  BudgetReservation,
  BudgetReservationOutcome,
  UsageCounters,
} from './contracts.js';

export interface BudgetTransactionPort {
  reserveBudget(
    requestId: string,
    estimate: Partial<UsageCounters>,
    context?: BudgetContext,
  ): Promise<BudgetReservationOutcome>;
  reconcileBudget(reservations: readonly BudgetReservation[], usage: UsageCounters): Promise<void>;
}

export interface BudgetStorePort {
  transaction<T>(operation: (transaction: BudgetTransactionPort) => Promise<T>): Promise<T>;
}

export interface BudgetNotification {
  title: string;
  body: string;
  severity: 'warning' | 'critical';
  decision: BudgetDecision;
}

export interface BudgetPreflightResult extends BudgetReservationOutcome {
  action: 'allow' | 'deny' | 'fallback';
  fallbackRouteId?: string;
}

/** Coordinates Keyway-compatible atomic budget reservation and UI notifications. */
export class UsageBudgetService {
  constructor(
    private readonly store: BudgetStorePort,
    private readonly notify?: (notification: BudgetNotification) => void,
  ) {}

  async reserve(
    requestId: string,
    estimate: Partial<UsageCounters>,
    context: BudgetContext = {},
  ): Promise<BudgetPreflightResult> {
    const outcome = await this.store.transaction(transaction =>
      transaction.reserveBudget(requestId, estimate, context));
    const fallback = outcome.decisions.find(decision => decision.decision === 'fallback');
    const denied = outcome.decisions.find(decision => decision.decision === 'denied');
    for (const decision of outcome.decisions) {
      if (decision.decision !== 'allowed') this.notify?.(formatBudgetNotification(decision));
    }
    if (fallback) {
      return {
        ...outcome,
        action: 'fallback',
        ...(fallback.fallbackRouteId ? { fallbackRouteId: fallback.fallbackRouteId } : {}),
      };
    }
    if (denied) return { ...outcome, action: 'deny' };
    return { ...outcome, action: 'allow' };
  }

  async reconcile(reservations: readonly BudgetReservation[], usage: UsageCounters): Promise<void> {
    if (reservations.length === 0) return;
    await this.store.transaction(transaction => transaction.reconcileBudget(reservations, usage));
  }
}

export function formatBudgetNotification(decision: BudgetDecision): BudgetNotification {
  const percent = decision.limit > 0
    ? Math.min(999, Math.round(((decision.used + decision.reserved + decision.requested) / decision.limit) * 100))
    : 100;
  const label = decision.decision === 'warned'
    ? 'Budget warning'
    : decision.decision === 'fallback'
      ? 'Budget route fallback'
      : 'Budget limit reached';
  return {
    title: label,
    body: `${decision.policyId}: ${percent}% of limit (${decision.used + decision.reserved} used/reserved, ${decision.requested} requested).`,
    severity: decision.decision === 'warned' ? 'warning' : 'critical',
    decision,
  };
}
