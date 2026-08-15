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
import type { AgentEvent } from '../../src/index.js';
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
  try {
    await cp(options.sourceWorkspace, workDir, { recursive: true });
    const tools = createHadamardCoreTools({ cwd: workDir });
    const sdk = await createAgentSdk({
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
      permissions: options.testCase.family === 'permission-denial'
        ? [{ toolName: 'Bash', behavior: 'deny' }]
        : [],
      tools,
      ...(options.testCase.contextWindowTokens !== undefined
        ? { contextWindowTokens: options.testCase.contextWindowTokens }
        : {}),
    });
    const events: AgentEvent[] = [];
    const stream = sdk.stream(options.testCase.prompt, {
      permissionMode: 'bypassPermissions',
      permissions: options.testCase.family === 'permission-denial'
        ? [{ toolName: 'Bash', behavior: 'deny' }]
        : [],
      maxToolIterations: caseMaxToolIterations(options.testCase),
      agentMode: options.arm.agentMode ?? 'react',
      toolPresentation: options.arm.toolPresentation,
    });
    const collector = (async () => {
      for await (const event of stream) events.push(event);
    })();
    const result = await stream.result;
    await collector;
    await sdk.close();
    const requestStarted = events.find(
      (event): event is Extract<AgentEvent, { type: 'request.started' }> => event.type === 'request.started',
    );
    const dispatchCount = events.filter((event) => event.type === 'tool.code_dispatch').length;
    const sdkChars = options.arm.toolPresentation === 'native'
      ? JSON.stringify(tools.map((entry) => entry.inputJsonSchema)).length
      : renderCodeActHostSdk(tools).length;
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
      requestCount: 0,
      toolCallCount: 0,
      toolErrors: 0,
      codeDispatchCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      promptCacheHitTokens: 0,
      fixedSystemToolTokens: 0,
      sdkChars: 0,
      answerLength: 0,
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
    };
  } finally {
    await rm(trialRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function findCaseById(caseId: string): PtcAbCase {
  const found = PTC_AB_CASES.find((entry) => entry.id === caseId);
  if (!found) throw new Error(`Unknown PTC A/B case: ${caseId}`);
  return found;
}

