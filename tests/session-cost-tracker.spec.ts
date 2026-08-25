import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SessionCostTracker,
  readLedgerSummary,
} from '../src/extensions/sessionCostTracker.js';
import { UsageQueryService } from '../src/usage/usageQueryService.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A homeDir whose basename is .hadamard so resolveHadamardHome uses it directly. */
async function fakeHome(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-cost-'));
  tempDirs.push(root);
  const homeDir = path.join(root, '.hadamard');
  await mkdir(homeDir, { recursive: true });
  return homeDir;
}

function ledgerPath(homeDir: string): string {
  return path.join(homeDir, 'usage', 'cost-ledger.jsonl');
}

async function waitForLedgerLines(homeDir: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const raw = await readFile(ledgerPath(homeDir), 'utf8').catch(() => '');
    const lines = raw.split('\n').filter((line) => line.trim());
    if (lines.length >= count) return lines;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${count} ledger lines; got ${lines.length}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('SessionCostTracker', () => {
  it('accumulates tokens and cost with a per-model breakdown', async () => {
    const homeDir = await fakeHome();
    const tracker = new SessionCostTracker(homeDir, { ledger: false });

    // gpt-4o-mini: $0.15/1M in, $0.60/1M out.
    tracker.record('gpt-4o-mini', { input_tokens: 2_000_000, output_tokens: 1_000_000 });
    tracker.record('gpt-4o-mini', { input_tokens: 1_000_000, output_tokens: 500_000 });
    tracker.record('deepseek-v3', { input_tokens: 1_000_000, output_tokens: 0 });

    const snapshot = tracker.snapshot();
    expect(snapshot.inputTokens).toBe(4_000_000);
    expect(snapshot.outputTokens).toBe(1_500_000);
    // mini: 3M in * 0.15 + 1.5M out * 0.60 = 0.45 + 0.90; deepseek: 1M in * 0.27.
    expect(snapshot.costUsd).toBeCloseTo(0.45 + 0.9 + 0.27, 6);
    expect(snapshot.perModel['gpt-4o-mini']).toEqual({
      inputTokens: 3_000_000,
      outputTokens: 1_500_000,
      costUsd: expect.closeTo(1.35, 6),
    });
    expect(snapshot.perModel['deepseek-v3']).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 0,
      costUsd: expect.closeTo(0.27, 6),
    });
  });

  it('counts tokens at $0 for models without pricing', async () => {
    const homeDir = await fakeHome();
    const tracker = new SessionCostTracker(homeDir, { ledger: false });

    tracker.record('no-such-model', { input_tokens: 10_000, output_tokens: 5_000 });

    const snapshot = tracker.snapshot();
    expect(snapshot.inputTokens).toBe(10_000);
    expect(snapshot.outputTokens).toBe(5_000);
    expect(snapshot.costUsd).toBe(0);
    expect(snapshot.perModel['no-such-model']).toEqual({
      inputTokens: 10_000,
      outputTokens: 5_000,
      costUsd: 0,
    });
  });

  it('appends one JSONL ledger line per record and tolerates undefined usage', async () => {
    const homeDir = await fakeHome();
    const tracker = new SessionCostTracker(homeDir);

    tracker.record('gpt-4o-mini', {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: null,
    }, { sessionId: 'session-1', runId: 'run-1' });
    tracker.record('gpt-4o-mini', {});

    const lines = await waitForLedgerLines(homeDir, 2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first).toMatchObject({
      sessionId: 'session-1',
      runId: 'run-1',
      model: 'gpt-4o-mini',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 300,
    });
    expect(typeof first.ts).toBe('string');
    expect(first.costUsd).toBeCloseTo(1000 / 1_000_000 * 0.15 + 200 / 1_000_000 * 0.6, 9);
    const queryService = await UsageQueryService.open(homeDir);
    const [stored] = queryService.events({ sessionId: 'session-1' });
    queryService.close();
    expect(stored).toMatchObject({
      source: 'hadamard',
      sessionId: 'session-1',
      runId: 'run-1',
      usage: {
        cacheReadTokens: 300,
        cacheWriteTokens: 0,
      },
    });
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(second.inputTokens).toBe(0);
    expect(second.sessionId).toBeUndefined();
  });

  it('never writes the ledger when ledger: false', async () => {
    const homeDir = await fakeHome();
    const tracker = new SessionCostTracker(homeDir, { ledger: false });
    tracker.record('gpt-4o-mini', { input_tokens: 1000, output_tokens: 100 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(stat(ledgerPath(homeDir))).rejects.toThrow();
  });
});

describe('readLedgerSummary', () => {
  it('splits today vs total and skips malformed lines', async () => {
    const homeDir = await fakeHome();
    const tracker = new SessionCostTracker(homeDir);
    tracker.record('gpt-4o-mini', { input_tokens: 1000, output_tokens: 500 });
    await waitForLedgerLines(homeDir, 1);

    // An old entry (definitely not today) and malformed lines mixed in.
    const oldLine = JSON.stringify({
      ts: '2020-01-01T00:00:00.000Z',
      model: 'gpt-4o-mini',
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      costUsd: 0.9,
    });
    const noTsLine = JSON.stringify({ model: 'x', inputTokens: 7, outputTokens: 3, costUsd: 0.5 });
    await writeFile(
      ledgerPath(homeDir),
      `${await readFile(ledgerPath(homeDir), 'utf8')}${oldLine}\nnot-json\n{"ts":\n${noTsLine}\n`,
      'utf8',
    );

    const summary = await readLedgerSummary(homeDir);
    expect(summary.entries).toBe(3); // today + old + no-ts; garbage lines skipped
    expect(summary.total.inputTokens).toBe(2_001_007);
    expect(summary.total.outputTokens).toBe(1_000_503);
    expect(summary.total.costUsd).toBeCloseTo(0.00045 + 0.9 + 0.5, 9);
    expect(summary.today.inputTokens).toBe(1000);
    expect(summary.today.outputTokens).toBe(500);
    expect(summary.today.costUsd).toBeCloseTo(0.00045, 9);
  });

  it('returns zeros when the ledger does not exist', async () => {
    const homeDir = await fakeHome();
    const summary = await readLedgerSummary(homeDir);
    expect(summary).toEqual({
      today: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      total: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      entries: 0,
    });
  });
});
