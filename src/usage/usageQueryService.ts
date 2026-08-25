import path from 'node:path';

import type { UsageFilter, UsagePage, UsageSummary } from './contracts.js';
import { UsageLedger } from './usageLedger.js';

export function usageDatabasePath(homeDir: string): string {
  return path.join(homeDir, 'usage', 'usage-v2.sqlite');
}

export function legacyCostLedgerPath(homeDir: string): string {
  return path.join(homeDir, 'usage', 'cost-ledger.jsonl');
}

export class UsageQueryService {
  private constructor(private readonly ledger: UsageLedger) {}

  static async open(homeDir: string): Promise<UsageQueryService> {
    const ledger = await UsageLedger.open({ filename: usageDatabasePath(homeDir) });
    await ledger.importLegacyJsonl(legacyCostLedgerPath(homeDir));
    return new UsageQueryService(ledger);
  }

  summary(filter: UsageFilter = {}): UsageSummary {
    return this.ledger.summarize(filter);
  }

  events(page: UsagePage = {}) {
    return this.ledger.query(page);
  }

  close(): void {
    this.ledger.close();
  }
}
