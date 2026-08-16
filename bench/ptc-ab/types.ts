import type { ToolPresentationMode } from '../../src/codeact/presentationTypes.js';

/** P4 A/B: compare Native, PTC, and persistent CodeAct presentations on identical local tasks. */

export type PtcAbArm = 'native' | 'ptc' | 'codeact';

export type PtcAbFamily =
  | 'serial-dependency'
  | 'parallel-reads'
  | 'large-result-filtering'
  | 'permission-denial'
  | 'tool-failure-recovery'
  | 'mutating-barrier'
  | 'context-compaction';

export interface PtcAbCase {
  id: string;
  family: PtcAbFamily;
  /** Runtime under test (harness rule: every case declares its runtimeTarget). */
  runtimeTarget: 'clean-sdk';
  prompt: string;
  setup(workDir: string): Promise<void>;
  grader(workDir: string): Promise<{ passed: boolean; detail: string }>;
  /** Turn budget applied identically across arms (harness rule: consistent budgets). */
  maxToolIterations?: number;
  /** Small context window to force mid-run compaction (compaction family only). */
  contextWindowTokens?: number;
}

export interface PtcAbArmConfig {
  arm: PtcAbArm;
  toolPresentation: ToolPresentationMode;
  agentMode?: 'react' | 'codeact';
}

export const PTC_AB_ARMS: readonly PtcAbArmConfig[] = [
  { arm: 'native', toolPresentation: 'native', agentMode: 'react' },
  { arm: 'ptc', toolPresentation: 'ptc', agentMode: 'react' },
  { arm: 'codeact', toolPresentation: 'native', agentMode: 'codeact' },
];

export interface PtcAbTrialRow {
  provider: string;
  model: string;
  caseId: string;
  family: PtcAbFamily;
  arm: PtcAbArm;
  trial: number;
  passed: boolean;
  detail: string;
  durationMs: number;
  requestCount: number;
  toolCallCount: number;
  toolErrors: number;
  codeDispatchCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  promptCacheHitTokens: number;
  fixedSystemToolTokens: number;
  sdkChars: number;
  answerLength: number;
  error?: string;
}

export interface PtcAbArmSummary {
  arm: PtcAbArm;
  trials: number;
  passed: number;
  successRate: number;
  avgDurationMs: number;
  avgRequestCount: number;
  avgToolCallCount: number;
  avgToolErrors: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCacheReadTokens: number;
  avgFixedSystemToolTokens: number;
  avgSdkChars: number;
}

export interface PtcAbFamilyDecision {
  family: PtcAbFamily;
  baseline: PtcAbArmSummary;
  candidates: PtcAbArmSummary[];
  /** Arm(s) with non-degraded success and a meaningful cost or latency win. */
  recommendedDefault?: PtcAbArm[];
  rationale: string;
}

export interface PtcAbReport {
  generatedAt: string;
  provider: string;
  model: string;
  arms: readonly PtcAbArmConfig[];
  rows: PtcAbTrialRow[];
  families: PtcAbFamilyDecision[];
  conclusion: string;
}

