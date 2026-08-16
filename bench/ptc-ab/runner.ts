#!/usr/bin/env npx tsx
/**
 * P4 A/B runner: one trial of one case under one presentation arm, with the
 * full metric set the plan requires (fixed system/tool/SDK tokens, per-step
 * history tokens via request summaries, cache hits, latency, success, and
 * cost-ready usage). Workspaces are isolated copies (harness rule) and the
 * grader sees only final observable state.
 */
import { mkdtemp, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createAgentSdk,
  createHadamardCoreTools,
  renderCodeActHostSdk,
} from '../../src/index.js';
import type { AgentEvent, AgentRunOptions, AgentRunResult } from '../../src/index.js';
import { PTC_AB_CASES, caseMaxToolIterations } from './cases.js';
import type { PtcAbArmConfig, PtcAbCase, PtcAbTrialRow } from './types.js';

export interface PtcAbRunConfig {
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
  maxTokens: number;
  /** Scripted in-process model for gold-mode smoke (no network/keys). */
  modelApi?: import('../../src/index.js').ModelApi;
  /** Factory form so a smoke model can learn the isolated trial workspace path. */
  modelApiFactory?: (workDir: string) => import('../../src/index.js').ModelApi;
}

/** Wire SDK size for one arm: native presents raw schemas, codeact/ptc present the generated SDK. */
function armSdkChars(
  arm: PtcAbArmConfig,
  tools: ReturnType<typeof createHadamardCoreTools>,
): number {
  const presentsNative = arm.agentMode !== 'codeact' && arm.toolPresentation === 'native';
  return presentsNative
    ? JSON.stringify(tools.map((entry) => entry.inputJsonSchema)).length
    : renderCodeActHostSdk(tools).length;
}

export async function runPtcAbTrial(options: {
  runConfig: PtcAbRunConfig;
  testCase: PtcAbCase;
  arm: PtcAbArmConfig;
  trial: number;
  sourceWorkspace: string;
}): Promise<PtcAbTrialRow> {
  const started = Date.now();
  const trialRoot = await mkdtemp(path.join(os.tmpdir(), `hadamard-ptc-ab-${options.testCase.id}-`));
  // Copy the source CONTENTS into a fresh non-existent workspace dir (Node's
  // cp nests the source when the destination already exists).
  const workDir = path.join(trialRoot, 'workspace');
  const homeDir = path.join(trialRoot, 'home');
  const sessionDirectory = path.join(trialRoot, 'sessions');
  // Hoisted metric inputs: a mid-trial provider failure still reports the
  // partial metrics recorded before the failure (harness guideline).
  const events: AgentEvent[] = [];
  let tools: ReturnType<typeof createHadamardCoreTools> = [];
  let sdk: Awaited<ReturnType<typeof createAgentSdk>> | undefined;
  let result: AgentRunResult | undefined;
  let sdkChars = 0;
  try {
    await cp(options.sourceWorkspace, workDir, { recursive: true });
    tools = createHadamardCoreTools({ cwd: workDir });
    sdkChars = armSdkChars(options.arm, tools);
    sdk = await createAgentSdk({
      workDir,
      homeDir,
      sessionDirectory,
      model: options.runConfig.model,
      ...(options.runConfig.modelApi ?? options.runConfig.modelApiFactory?.(workDir)
        ? { modelApi: options.runConfig.modelApi ?? options.runConfig.modelApiFactory!(workDir) }
        : {}),
      provider: 'anthropic',
      baseURL: options.runConfig.baseURL,
      apiKey: options.runConfig.apiKey,
      maxTokens: options.runConfig.maxTokens,
      toolPresentation: options.arm.toolPresentation,
      permissionMode: 'bypassPermissions',
      tools,
      ...(options.testCase.contextWindowTokens !== undefined
        ? { contextWindowTokens: options.testCase.contextWindowTokens }
        : {}),
    });
    // The permission-denial family disables Bash at the tool registry via
    // the internal run option: permission deny rules are unreachable under
    // bypassPermissions, which is the only mode a deterministic local
    // harness can run unattended.
    const streamOptions: AgentRunOptions & { __hadamardDisallowedTools?: string[] } = {
      permissionMode: 'bypassPermissions',
      maxToolIterations: caseMaxToolIterations(options.testCase),
      agentMode: options.arm.agentMode ?? 'react',
      toolPresentation: options.arm.toolPresentation,
      ...(options.testCase.family === 'permission-denial'
        ? { __hadamardDisallowedTools: ['Bash'] }
        : {}),
    };
    const stream = sdk.stream(options.testCase.prompt, streamOptions as AgentRunOptions);
    const collector = (async () => {
      for await (const event of stream) events.push(event);
    })();
    result = await stream.result;
    await collector;
    const requestStarted = events.find(
      (event): event is Extract<AgentEvent, { type: 'request.started' }> => event.type === 'request.started',
    );
    const dispatchCount = events.filter((event) => event.type === 'tool.code_dispatch').length;
    const inputTokens = result.usage?.input_tokens ?? 0;
    const outputTokens = result.usage?.output_tokens ?? 0;
    const cacheReadTokens = result.usage?.cache_read_input_tokens ?? 0;
    // DeepSeek reports prompt_cache_hit_tokens; the runtime mirrors it into
    // cache_read_input_tokens, so the mirrored field is the hit metric.
    const promptCacheHitTokens = cacheReadTokens;
    // Build the metric row BEFORE grading so a grader failure never wipes the
    // run metrics (a failed trial must still report its behavior traces).
    const row: PtcAbTrialRow = {
      provider: options.runConfig.provider,
      model: options.runConfig.model,
      caseId: options.testCase.id,
      family: options.testCase.family,
      arm: options.arm.arm,
      trial: options.trial,
      passed: false,
      detail: 'grader pending',
      durationMs: Date.now() - started,
      requestCount: result.requests.length,
      toolCallCount: result.toolCalls.length,
      toolErrors: result.toolCalls.filter((call) => call.isError).length,
      codeDispatchCount: dispatchCount,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      promptCacheHitTokens,
      fixedSystemToolTokens: requestStarted
        ? (requestStarted.systemTokenEstimate ?? 0) + (requestStarted.toolTokenEstimate ?? 0)
        : 0,
      sdkChars,
      answerLength: result.text.length,
    };
    try {
      const grade = await options.testCase.grader(workDir);
      row.passed = grade.passed;
      row.detail = grade.detail;
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
      row.detail = 'grader error';
    }
    return row;
  } catch (error) {
    // Rebuild partial metrics from whatever the failed run already recorded.
    const requestStarted = events.find(
      (event): event is Extract<AgentEvent, { type: 'request.started' }> => event.type === 'request.started',
    );
    return {
      provider: options.runConfig.provider,
      model: options.runConfig.model,
      caseId: options.testCase.id,
      family: options.testCase.family,
      arm: options.arm.arm,
      trial: options.trial,
      passed: false,
      detail: 'run error',
      durationMs: Date.now() - started,
      requestCount: result?.requests.length ?? 0,
      toolCallCount: result?.toolCalls.length ?? 0,
      toolErrors: result?.toolCalls.filter((call) => call.isError).length ?? 0,
      codeDispatchCount: events.filter((event) => event.type === 'tool.code_dispatch').length,
      inputTokens: result?.usage?.input_tokens ?? 0,
      outputTokens: result?.usage?.output_tokens ?? 0,
      cacheReadTokens: result?.usage?.cache_read_input_tokens ?? 0,
      promptCacheHitTokens: result?.usage?.cache_read_input_tokens ?? 0,
      fixedSystemToolTokens: requestStarted
        ? (requestStarted.systemTokenEstimate ?? 0) + (requestStarted.toolTokenEstimate ?? 0)
        : 0,
      sdkChars,
      answerLength: result?.text.length ?? 0,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
    };
  } finally {
    // A close failure must never wipe an otherwise completed trial.
    if (sdk) await sdk.close().catch(() => undefined);
    await rm(trialRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function findCaseById(caseId: string): PtcAbCase {
  const found = PTC_AB_CASES.find((entry) => entry.id === caseId);
  if (!found) throw new Error(`Unknown PTC A/B case: ${caseId}`);
  return found;
}

