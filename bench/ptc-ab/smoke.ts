#!/usr/bin/env npx tsx
/**
 * P4 A/B gold-mode smoke: validates the metric plumbing (events, requests,
 * usage, grader, report writing) with a scripted in-process model — no API
 * keys or network required. Real-model runs use run.ts.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ModelApi, ModelRequest } from '../../src/index.js';
import type { Message } from '../../src/provider/types.js';
import { runPtcAbTrial, findCaseById } from './runner.js';
import { PTC_AB_CASES } from './cases.js';
import type { PtcAbArmConfig } from './types.js';

let messageId = 0;

class SmokeModel implements ModelApi {
  readonly calls: ModelRequest[] = [];
  private index = 0;
  constructor(private readonly workDir: string) {}
  private buildMessage(request: ModelRequest): Message {
    this.calls.push(structuredClone(request));
    this.index += 1;
    const content: unknown[] = this.index === 1
      ? [{ type: 'tool_use', id: 'smoke_read', name: 'Read', input: { file_path: `${this.workDir}\\input.txt` } }]
      : this.index === 2
        ? [{ type: 'tool_use', id: 'smoke_write', name: 'Write', input: { file_path: `${this.workDir}\\output.txt`, content: '34' } }]
        : [{ type: 'text', text: 'sum written.' }];
    return {
      id: `smoke-${messageId += 1}`,
      type: 'message',
      role: 'assistant',
      model: 'smoke-model',
      content: content as Message['content'],
      stop_reason: (content[0] as { type?: string }).type === 'tool_use' ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 40 },
    } as Message;
  }
  async createMessage(request: ModelRequest): Promise<Message> {
    return this.buildMessage(request);
  }
  streamMessage(request: ModelRequest) {
    const message = this.buildMessage(request);
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<never> {
        // Smoke streams carry no granular events; finalMessage is authoritative.
      },
      finalMessage: () => Promise.resolve(message),
    };
  }
}

async function smokeNative(): Promise<void> {
  const testCase = findCaseById('serial-dependency');
  const sourceWorkspace = await mkdtemp(path.join(os.tmpdir(), 'hadamard-ptc-ab-smoke-src-'));
  await testCase.setup(sourceWorkspace);
  try {
    const row = await runPtcAbTrial({
      runConfig: {
        provider: 'smoke',
        model: 'smoke-model',
        baseURL: 'https://example.invalid/v1',
        apiKey: '',
        maxTokens: 8_000,
        modelApiFactory: (workDir) => new SmokeModel(workDir) as ModelApi,
      },
      testCase,
      arm: { arm: 'native', toolPresentation: 'native', agentMode: 'react' } as PtcAbArmConfig,
      trial: 1,
      sourceWorkspace,
    });
    console.log('SMOKE_ROW', JSON.stringify(row));
    if (!row.passed) throw new Error(`smoke grader failed: ${row.detail}${row.error ? ` (${row.error})` : ''}`);
    if (row.requestCount < 2) throw new Error('smoke expected >= 2 requests');
    if (row.toolCallCount < 1) throw new Error('smoke expected >= 1 tool call');
    console.log('PTC A/B smoke native: OK', JSON.stringify(row));
  } finally {
    await rm(sourceWorkspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function smokeCasesStatic(): Promise<void> {
  for (const testCase of PTC_AB_CASES) {
    const probeDir = await mkdtemp(path.join(os.tmpdir(), `hadamard-ptc-ab-probe-${testCase.id}-`));
    await testCase.setup(probeDir);
    const grade = await testCase.grader(probeDir);
    if (grade.passed) throw new Error(`case ${testCase.id} grader must fail before the agent acts`);
    await rm(probeDir, { recursive: true, force: true });
    console.log(`PTC A/B case static check: ${testCase.id} OK (${grade.detail})`);
  }
}

async function main(): Promise<void> {
  await smokeNative();
  await smokeCasesStatic();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

