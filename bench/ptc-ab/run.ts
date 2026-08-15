#!/usr/bin/env npx tsx
/**
 * P4 A/B orchestrator: cases × arms × trials, per-provider reporting and the
 * default-presentation decision rule (success not degraded AND a meaningful
 * cost or latency win; otherwise the presentation stays optional).
 *
 * Usage:
 *   npx tsx bench/ptc-ab/run.ts --provider deepseek --trials 3 --concurrency 2
 *   npx tsx bench/ptc-ab/run.ts --cases serial-dependency,parallel-reads
 */
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PTC_AB_ARMS, PTC_AB_CASES } from './cases.js';
import { runPtcAbTrial } from './runner.js';
import type {
  PtcAbArm,
  PtcAbArmSummary,
  PtcAbFamilyDecision,
  PtcAbReport,
  PtcAbTrialRow,
} from './types.js';

interface CliOptions {
  provider: 'deepseek' | 'minimax';
  trials: number;
  concurrency: number;
  cases?: string[];
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { provider: 'deepseek', trials: 3, concurrency: 2 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--provider' && value) { options.provider = value === 'minimax' ? 'minimax' : 'deepseek'; index += 1; }
    if (flag === '--trials' && value) { options.trials = Math.max(1, Number.parseInt(value, 10) || 1); index += 1; }
    if (flag === '--concurrency' && value) { options.concurrency = Math.max(1, Number.parseInt(value, 10) || 1); index += 1; }
    if (flag === '--cases' && value) { options.cases = value.split(',').map((entry) => entry.trim()).filter(Boolean); index += 1; }
  }
  return options;
}

function loadKeys(): Record<string, string> {
  try {
    const raw = readFileSync(path.join(process.cwd(), 'bench', '.bench-keys.json'), 'utf8');
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function runConfigFor(provider: CliOptions['provider']): { provider: string; model: string; baseURL: string; apiKey: string; maxTokens: number } {
  const keys = loadKeys();
  if (provider === 'minimax') {
    return {
      provider: 'minimax',
      model: 'MiniMax-M3',
      baseURL: 'https://api.minimaxi.com/anthropic/v1',
      apiKey: keys.MINIMAX_API_KEY ?? '',
      maxTokens: 131072,
    };
  }
  return {
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    baseURL: 'https://api.deepseek.com/anthropic/v1',
    apiKey: keys.DEEPSEEK_API_KEY ?? '',
    maxTokens: 384000,
  };
}

async function withConcurrency<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await run(items[index]!);
    }
  });
  await Promise.all(workers);
}

function summarizeArm(rows: readonly PtcAbTrialRow[]): PtcAbArmSummary {
  const passed = rows.filter((row) => row.passed).length;
  const average = (pick: (row: PtcAbTrialRow) => number): number =>
    rows.length === 0 ? 0 : Math.round(rows.reduce((sum, row) => sum + pick(row), 0) / rows.length);
  return {
    arm: rows[0]?.arm ?? 'native',
    trials: rows.length,
    passed,
    successRate: rows.length === 0 ? 0 : passed / rows.length,
    avgDurationMs: average((row) => row.durationMs),
    avgRequestCount: average((row) => row.requestCount),
    avgToolCallCount: average((row) => row.toolCallCount),
    avgToolErrors: average((row) => row.toolErrors),
    avgInputTokens: average((row) => row.inputTokens),
    avgOutputTokens: average((row) => row.outputTokens),
    avgCacheReadTokens: average((row) => row.cacheReadTokens),
    avgFixedSystemToolTokens: average((row) => row.fixedSystemToolTokens),
    avgSdkChars: average((row) => row.sdkChars),
  };
}

function decideFamily(rows: readonly PtcAbTrialRow[]): PtcAbFamilyDecision {
  const baseline = summarizeArm(rows.filter((row) => row.arm === 'native'));
  const candidates: PtcAbArmSummary[] = PTC_AB_ARMS
    .filter((arm) => arm.arm !== 'native')
    .map((arm) => summarizeArm(rows.filter((row) => row.arm === arm.arm)));
  const recommended: PtcAbArm[] = candidates.filter((candidate) => {
    const successNotDegraded = candidate.successRate >= baseline.successRate;
    const inputTokensWin = baseline.avgInputTokens > 0
      && candidate.avgInputTokens <= baseline.avgInputTokens * 0.9;
    const latencyWin = baseline.avgDurationMs > 0
      && candidate.avgDurationMs <= baseline.avgDurationMs * 0.85;
    const sdkWin = candidate.avgSdkChars > 0
      && candidate.avgSdkChars <= Math.max(1, baseline.avgSdkChars) * 0.75;
    return successNotDegraded && (inputTokensWin || latencyWin || sdkWin);
  }).map((candidate) => candidate.arm);
  return {
    family: rows[0]!.family,
    baseline,
    candidates,
    ...(recommended.length > 0 ? { recommendedDefault: recommended } : {}),
    rationale: recommended.length > 0
      ? `Success is not degraded and a meaningful cost/latency/SDK win was measured for: ${recommended.join(', ')}.`
      : 'No presentation beat or matched Native with a meaningful win; keep Native as the default and PTC optional.',
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const runConfig = runConfigFor(options.provider);
  if (!runConfig.apiKey) {
    throw new Error(`No API key for provider ${options.provider} in bench/.bench-keys.json; add one before running P4.`);
  }
  const selectedCases = options.cases
    ? PTC_AB_CASES.filter((entry) => options.cases!.includes(entry.id))
    : [...PTC_AB_CASES];
  const reportDir = path.join(process.cwd(), 'bench', 'reports', 'ptc-ab');
  await mkdir(reportDir, { recursive: true });
  const reportId = `${options.provider}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const jsonlPath = path.join(reportDir, `${reportId}.jsonl`);
  const summaryPath = path.join(reportDir, `${reportId}.json`);
  const rows: PtcAbTrialRow[] = [];

  const workItems = selectedCases.flatMap((testCase) =>
    PTC_AB_ARMS.flatMap((arm) =>
      Array.from({ length: options.trials }, (_, index) => ({ testCase, arm, trial: index + 1 })),
    ),
  );
  console.log(`PTC A/B: provider=${options.provider} model=${runConfig.model} cases=${selectedCases.length} arms=${PTC_AB_ARMS.length} trials=${options.trials} total=${workItems.length}`);

  await withConcurrency(workItems, options.concurrency, async ({ testCase, arm, trial }) => {
    const sourceWorkspace = await mkdtemp(path.join(os.tmpdir(), `hadamard-ptc-ab-src-${testCase.id}-`));
    await testCase.setup(sourceWorkspace);
    const row = await runPtcAbTrial({ runConfig, testCase, arm, trial, sourceWorkspace });
    await rm(sourceWorkspace, { recursive: true, force: true }).catch(() => undefined);
    rows.push(row);
    await writeFile(jsonlPath, `${JSON.stringify(row)}\n`, { flag: 'a' });
    console.log(`[${row.passed ? 'PASS' : 'FAIL'}] ${row.caseId}/${row.arm}/${row.trial} requests=${row.requestCount} tools=${row.toolCallCount} errors=${row.toolErrors} in=${row.inputTokens} out=${row.outputTokens} cache=${row.cacheReadTokens} ms=${row.durationMs}${row.error ? ` error=${row.error}` : ''}`);
  });

  const families: PtcAbFamilyDecision[] = selectedCases.map((testCase) =>
    decideFamily(rows.filter((row) => row.caseId === testCase.id)),
  );
  const recommendedCount = families.filter((family) => family.recommendedDefault?.length).length;
  const report: PtcAbReport = {
    generatedAt: new Date().toISOString(),
    provider: runConfig.provider,
    model: runConfig.model,
    arms: PTC_AB_ARMS,
    rows,
    families,
    conclusion: recommendedCount === 0
      ? 'Native stays the default; PTC stays optional until a provider/task family shows a non-degraded success rate with a meaningful cost or latency win.'
      : `${recommendedCount}/${families.length} families recommend a non-Native default (see family decisions); keep Native as the global default and consider per-profile overrides.`,
  };
  await writeFile(summaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Report: ${summaryPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

