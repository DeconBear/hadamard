import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { z } from 'zod';

import {
  CodeActService,
  buildAgentModePrompt,
  createAgentSdk,
  createCodeCellTool,
  filterToolsForExecutionPolicy,
  resolveAgentExecutionPolicy,
  tool,
  type AgentEvent,
  type AgentMode,
  type ModelApi,
  type ModelRequest,
  type ModelStreamHandle,
} from '../../src/index.js';
import type { Message, MessageStreamEvent } from '../../src/provider/types.js';

interface BenchmarkCase {
  id: string;
  domain: string;
  runtimeTarget: 'clean-sdk';
  agentMode: Extract<AgentMode, 'codeact' | 'hybrid'>;
  prompt: string;
  python: string;
  expected: unknown;
  behaviorExpectations: {
    minimumCodeCellCalls: number;
    minimumPermissionDecisions: number;
  };
}

interface PlaneResult {
  plane: 'react' | 'codeact' | 'hybrid';
  actual: unknown;
  passed: boolean;
  durationMs: number;
  toolCalls: number;
  permissionDecisions: number;
  codeCellEvents: number;
  artifactPaths: string[];
  trajectory: Array<{ type: string; timestamp: string }>;
}

let messageSequence = 0;

async function main(): Promise<void> {
  const outputArg = process.argv.indexOf('--output');
  const outputPath = outputArg >= 0 && process.argv[outputArg + 1]
    ? path.resolve(process.argv[outputArg + 1]!)
    : path.resolve('tmp/codeact-benchmark-smoke.json');
  const cases = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8')) as BenchmarkCase[];
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'hadamard-codeact-bench-'));
  const artifactOutputDirectory = path.join(path.dirname(outputPath), 'codeact-benchmark-artifacts');
  const service = new CodeActService({
    enabled: true,
    pythonCommand: process.platform === 'win32' ? 'python' : 'python3',
    executionTimeoutMs: 10_000,
  });
  try {
    const results = [];
    for (const benchmarkCase of cases) {
      const codeact = await runPlane(
        benchmarkCase, benchmarkCase.agentMode, workspace, service, artifactOutputDirectory,
      );
      const react = await runPlane(
        benchmarkCase, 'react', workspace, service, artifactOutputDirectory,
      );
      results.push({ caseId: benchmarkCase.id, domain: benchmarkCase.domain, codeact, react });
    }
    const report = {
      schemaVersion: 1,
      suite: 'hadamard-codeact',
      runtimeTarget: 'clean-sdk',
      generatedAt: new Date().toISOString(),
      status: results.every(result => result.codeact.passed && result.react.passed) ? 'passed' : 'failed',
      results,
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({ status: report.status, cases: results.length, outputPath }));
    if (report.status !== 'passed') process.exitCode = 1;
  } finally {
    await service.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runPlane(
  benchmarkCase: BenchmarkCase,
  mode: AgentMode,
  workspace: string,
  service: CodeActService,
  artifactOutputDirectory: string,
): Promise<PlaneResult> {
  const sessionDirectory = await mkdtemp(path.join(os.tmpdir(), `hadamard-${mode}-sessions-`));
  const calculator = createCaseTool(benchmarkCase);
  const codeCell = createCodeCellTool({ service });
  const policy = resolveAgentExecutionPolicy({
    agentMode: mode,
    ordinaryTools: [calculator.name],
    codeActEnabled: true,
  });
  const tools = filterToolsForExecutionPolicy([calculator, codeCell], policy);
  const selectedTool = mode === 'react' ? calculator.name : codeCell.name;
  const selectedInput = mode === 'react'
    ? { caseId: benchmarkCase.id }
    : { language: 'python', code: benchmarkCase.python };
  const modelApi = new ScriptedToolModel(selectedTool, selectedInput);
  const sdk = await createAgentSdk({
    model: 'codeact-benchmark-model',
    modelApi,
    workDir: workspace,
    sessionDirectory,
    permissionMode: 'bypassPermissions',
  });
  const events: AgentEvent[] = [];
  const started = performance.now();
  try {
    const stream = sdk.stream(benchmarkCase.prompt, {
      tools,
      systemPrompt: buildAgentModePrompt(policy, { hostCapabilities: [] }),
    });
    for await (const event of stream) events.push(event);
    const result = await stream.result;
    const raw = result.toolCalls[0]?.output as Record<string, unknown> | undefined;
    const actual = mode === 'react'
      ? raw?.value
      : (raw?.result as Record<string, unknown> | undefined)?.value;
    const permissionDecisions = events.filter(event => event.type === 'tool.permission').length;
    const codeCellEvents = events.filter(event => event.type.startsWith('code_cell.')).length;
    const recordPath = typeof raw?.recordPath === 'string' ? raw.recordPath : undefined;
    let evidencePath: string | undefined;
    if (recordPath) {
      await mkdir(artifactOutputDirectory, { recursive: true });
      evidencePath = path.join(artifactOutputDirectory, `${benchmarkCase.id}-${mode}.json`);
      await copyFile(recordPath, evidencePath);
    }
    const passed = JSON.stringify(actual) === JSON.stringify(benchmarkCase.expected)
      && (mode === 'react' || (
        result.toolCalls.length >= benchmarkCase.behaviorExpectations.minimumCodeCellCalls
        && permissionDecisions >= benchmarkCase.behaviorExpectations.minimumPermissionDecisions
        && codeCellEvents >= 2
        && Boolean(recordPath)
      ));
    return {
      plane: mode,
      actual,
      passed,
      durationMs: performance.now() - started,
      toolCalls: result.toolCalls.length,
      permissionDecisions,
      codeCellEvents,
      artifactPaths: evidencePath ? [evidencePath] : [],
      trajectory: events.map(event => ({ type: event.type, timestamp: event.timestamp })),
    };
  } finally {
    await sdk.close();
    await rm(sessionDirectory, { recursive: true, force: true });
  }
}

function createCaseTool(benchmarkCase: BenchmarkCase) {
  return tool(
    {
      name: 'CaseCompute',
      description: 'Deterministically computes the benchmark case.',
      inputSchema: z.strictObject({ caseId: z.literal(benchmarkCase.id) }),
      isReadOnly: () => true,
    },
    async () => ({ value: reactValue(benchmarkCase.id) }),
  );
}

function reactValue(caseId: string): unknown {
  switch (caseId) {
    case 'codeact-math-modeling': return { slope: 2, intercept: 1 };
    case 'codeact-data-processing': return { a: 8, b: 5 };
    case 'codeact-ai4s-experiment': return { concentration: 0.348678, steps: 10 };
    case 'codeact-circuit-calculation': return { equivalentOhms: 66.666667, sourceCurrentAmps: 0.18 };
    default: throw new Error(`Unknown benchmark case: ${caseId}`);
  }
}

class ScriptedToolModel implements ModelApi {
  private callCount = 0;

  constructor(private readonly toolName: string, private readonly input: unknown) {}

  async createMessage(request: ModelRequest): Promise<Message> {
    return this.next(request);
  }

  streamMessage(request: ModelRequest): ModelStreamHandle {
    const final = this.next(request);
    return {
      async finalMessage() { return final; },
      async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {},
    };
  }

  private next(request: ModelRequest): Message {
    this.callCount += 1;
    if (this.callCount === 1) {
      if (!request.tools?.some(tool => tool.name === this.toolName)) {
        throw new Error(`Expected tool ${this.toolName} was pruned incorrectly.`);
      }
      return makeMessage([{
        type: 'tool_use', id: `bench-tool-${messageSequence + 1}`, name: this.toolName, input: this.input,
      }], 'tool_use');
    }
    return makeMessage([{ type: 'text', text: 'Benchmark action completed.' }], 'end_turn');
  }
}

function makeMessage(content: unknown[], stopReason: 'tool_use' | 'end_turn'): Message {
  messageSequence += 1;
  return {
    id: `bench-message-${messageSequence}`,
    type: 'message',
    role: 'assistant',
    model: 'codeact-benchmark-model',
    content: content as Message['content'],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as Message;
}

await main();
