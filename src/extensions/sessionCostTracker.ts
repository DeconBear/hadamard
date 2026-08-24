/**
 * Session cost tracker (built-in `costTracker` extension): per-surface token +
 * USD accumulation with an append-only JSONL ledger at
 * `<homeDir>/usage/cost-ledger.jsonl` so `/cost` can show today/total across
 * sessions. Pricing comes from src/team/pricing; models without pricing still
 * count tokens at $0. Ledger writes are fire-and-forget and never throw.
 *
 * @module src/extensions/sessionCostTracker
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { isRecord } from '../runtime/helpers.js';
import { estimateCost } from '../team/pricing.js';

export interface SessionCostModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface SessionCostSnapshot {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  perModel: Record<string, SessionCostModelUsage>;
}

/** Provider-reported usage shape (Anthropic/OpenAI-style field names). */
export interface SessionCostUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export interface CostLedgerTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CostLedgerSummary {
  today: CostLedgerTotals;
  total: CostLedgerTotals;
  entries: number;
}

function ledgerPath(homeDir: string): string {
  return path.join(homeDir, 'usage', 'cost-ledger.jsonl');
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export class SessionCostTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;
  private readonly perModel = new Map<string, SessionCostModelUsage>();
  private readonly ledger: boolean;
  /** Serializes fire-and-forget appends so ledger lines land in record order. */
  private ledgerQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly homeDir: string,
    opts?: { ledger?: boolean },
  ) {
    this.ledger = opts?.ledger !== false;
  }

  record(
    model: string,
    usage: SessionCostUsage,
    meta?: { sessionId?: string; runId?: string },
  ): void {
    const inputTokens = count(usage.input_tokens);
    const outputTokens = count(usage.output_tokens);
    const cacheReadTokens = count(usage.cache_read_input_tokens);
    // Unknown pricing is not an error: tokens still count, cost stays 0.
    const costUsd = estimateCost(model, inputTokens, outputTokens, this.homeDir) ?? 0;
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    this.costUsd += costUsd;
    const entry = this.perModel.get(model) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    entry.inputTokens += inputTokens;
    entry.outputTokens += outputTokens;
    entry.costUsd += costUsd;
    this.perModel.set(model, entry);
    if (!this.ledger) return;
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
      ...(meta?.runId ? { runId: meta.runId } : {}),
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      costUsd,
    })}\n`;
    const filePath = ledgerPath(this.homeDir);
    this.ledgerQueue = this.ledgerQueue.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, line, 'utf8');
    }).catch(() => undefined);
  }

  snapshot(): SessionCostSnapshot {
    const perModel: Record<string, SessionCostModelUsage> = {};
    for (const [model, entry] of this.perModel) {
      perModel[model] = { ...entry };
    }
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
      perModel,
    };
  }
}

/**
 * Read the JSONL cost ledger into today/total totals. Bad lines are skipped;
 * "today" matches the local calendar date of the entry's `ts`.
 */
export async function readLedgerSummary(homeDir: string): Promise<CostLedgerSummary> {
  const summary: CostLedgerSummary = {
    today: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    total: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    entries: 0,
  };
  let raw: string;
  try {
    raw = await readFile(ledgerPath(homeDir), 'utf8');
  } catch {
    return summary;
  }
  const now = new Date();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    const inputTokens = count(entry.inputTokens);
    const outputTokens = count(entry.outputTokens);
    const costUsd = count(entry.costUsd);
    summary.entries += 1;
    summary.total.inputTokens += inputTokens;
    summary.total.outputTokens += outputTokens;
    summary.total.costUsd += costUsd;
    const ts = typeof entry.ts === 'string' ? new Date(entry.ts) : null;
    if (
      ts
      && !Number.isNaN(ts.getTime())
      && ts.getFullYear() === now.getFullYear()
      && ts.getMonth() === now.getMonth()
      && ts.getDate() === now.getDate()
    ) {
      summary.today.inputTokens += inputTokens;
      summary.today.outputTokens += outputTokens;
      summary.today.costUsd += costUsd;
    }
  }
  return summary;
}
