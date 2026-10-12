import type { CodeActService } from '../codeact/codeActService.js';
import type { CodeActBackend, CodeActSecurityMode, CodeRunFailureKind } from '../codeact/types.js';
import type { GoalEvidence } from '../goal/types.js';

export type ResearchJson = null | boolean | number | string | ResearchJson[] | { [key: string]: ResearchJson };
export interface ResearchInput { path: string }
export interface ResearchPinnedFile { path: string; sha256: string; sizeBytes: number }
export type ResearchAcceptanceCriterion =
  | { id: string; kind: 'numeric'; artifact: string; path: string; expected: number; tolerance: number }
  | { id: string; kind: 'file'; artifact: string; minBytes?: number; sha256?: string };
export interface ResearchBudget {
  timeoutMs: number;
  maxArtifactBytes: number;
  maxRuns: number;
}
export interface ResearchManifestInput {
  title: string;
  objective: string;
  code: string;
  inputs?: ResearchInput[];
  parameters?: Record<string, ResearchJson>;
  seeds?: number[];
  acceptanceCriteria: ResearchAcceptanceCriterion[];
  budget?: Partial<ResearchBudget>;
  environment?: { lockFiles?: string[]; pythonVersion?: string };
}
export interface ResearchRuntimeFingerprint {
  pythonVersion: string;
  implementation: string;
  platform: string;
  packages: [string, string][];
}
export interface ResearchEnvironment {
  backend: CodeActBackend | null;
  securityMode: CodeActSecurityMode | null;
  settingsDigest: string | null;
  runtime: ResearchRuntimeFingerprint | null;
  runtimeDigest: string | null;
  requiredPythonVersion: string | null;
  lockFiles: ResearchPinnedFile[];
  sha256: string;
}
export interface ResearchManifest {
  version: 1;
  id: string;
  createdAt: string;
  title: string;
  objective: string;
  code: string;
  codeDigest: string;
  codeCommit: string | null;
  codeDirty: boolean | null;
  inputs: ResearchPinnedFile[];
  parameters: Record<string, ResearchJson>;
  seeds: number[];
  acceptanceCriteria: ResearchAcceptanceCriterion[];
  budget: ResearchBudget;
  environment: ResearchEnvironment;
  digest: string;
}
export type ResearchRunStatus = 'queued' | 'running' | 'validating' | 'passed' | 'failed' | 'blocked' | 'cancelled' | 'timed_out';
export interface ResearchArtifact {
  id: string;
  runId: string;
  manifestId: string;
  manifestDigest: string;
  codeDigest: string;
  environmentDigest: string;
  inputDigests: string[];
  path: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
}
export interface ResearchCriterionResult {
  criterionId: string;
  passed: boolean;
  reason: string;
  observed?: number;
  artifactDigest?: string;
}
export interface ResearchRun {
  version: 1;
  id: string;
  manifestId: string;
  manifestDigest: string;
  rerunOf: string | null;
  idempotencyKey: string | null;
  sessionId: string;
  ownerPid: number;
  ownerStartedAt: number;
  status: ResearchRunStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  reason: string | null;
  execution: {
    status: 'not_started' | 'running' | 'completed' | 'failed' | 'interrupted';
    executionId: string | null;
    durationMs: number;
    stdout: string;
    stderr: string;
    error: string | null;
    failureKind: CodeRunFailureKind | null;
  };
  validation: {
    status: 'not_run' | 'passed' | 'failed';
    criteria: ResearchCriterionResult[];
    summary: string;
  };
  artifacts: ResearchArtifact[];
  runtimeDigest: string | null;
  /** Process kernels isolate namespaces, not host filesystem access. */
  isolation: 'trusted-only' | 'strong' | 'unavailable';
}
export interface ResearchServiceOptions {
  codeAct?: Pick<CodeActService, 'settings' | 'execute' | 'selfCheck' | 'stop'>;
  onRunSettled?: (run: ResearchRun, manifest: ResearchManifest, evidence: GoalEvidence) => void | Promise<void>;
}
export interface ResearchStartOptions { idempotencyKey?: string }
export const RESEARCH_TERMINAL_STATES: ReadonlySet<ResearchRunStatus> = new Set([
  'passed', 'failed', 'blocked', 'cancelled', 'timed_out',
]);
export class ResearchError extends Error {
  constructor(message: string, readonly code: 'invalid_manifest' | 'not_found' | 'conflict' | 'unsafe_path' | 'integrity' | 'unavailable') {
    super(message);
    this.name = 'ResearchError';
  }
}
