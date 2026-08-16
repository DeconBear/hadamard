import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition, CreateToolOptions } from '../types.js';
import type { CodeCellExecutionResult } from './types.js';

/** Wire-tool name for the stateless PTC presentation (reserved like dsh run_code). */
export const RUN_CODE_TOOL_NAME = 'run_code';

export type RunCodeLanguage = 'python' | 'typescript';

export interface ProgrammaticToolService {
  run(input: {
    code: string;
    context: import('../types.js').ToolExecutionContext;
    hostTools: readonly AgentToolDefinition[];
  }): Promise<CodeCellExecutionResult>;
}

interface RunCodeFlavor {
  description: string;
  codeDescription: string;
}

/**
 * The TypeScript flavor: the program body of an async function; host tools
 * are called as await tools.<name>(args); a failed host call rejects with
 * ToolCallError carrying the tool name on `toolName`.
 */
const TYPESCRIPT_FLAVOR: RunCodeFlavor = {
  description: [
    'Executes one stateless TypeScript program against the available tools. Takes two required',
    'arguments: `code`, the BODY of an async function (top-level `await` and `return` work), and',
    '`description`, a short summary of what the program does. Call host tools as',
    '`await tools.<name>(args)` per the typed SDK in the system prompt. Only what you print or',
    'return comes back — curate it. A failed host call rejects with ToolCallError carrying the',
    'tool name on `toolName`.',
  ].join(' '),
  codeDescription: 'The program: the body of an async TypeScript function.',
};

/** The Python flavor: same contract through the `hadamard` host object. */
const PYTHON_FLAVOR: RunCodeFlavor = {
  description: [
    'Executes one stateless Python program that can compose multiple host tool calls (hadamard.<tool>(...) or hadamard.tool("<name>", {...})).',
    'The program runs in a fresh environment every call; only print() output and the final expression value are returned.',
  ].join(' '),
  codeDescription: 'The program: the body of an async Python function.',
};

export function createRunCodeTool(options: {
  service: ProgrammaticToolService;
  hostTools: readonly AgentToolDefinition[];
  /** Program language the service executes; drives the model-facing schema flavor. */
  language?: RunCodeLanguage;
}): AgentToolDefinition {
  const flavor = options.language === 'typescript' ? TYPESCRIPT_FLAVOR : PYTHON_FLAVOR;
  const config: CreateToolOptions<{ code: string; description?: string }, CodeCellExecutionResult>
    & { codeLanguage?: 'python' | 'typescript' } = {
      name: RUN_CODE_TOOL_NAME,
      description: flavor.description,
      inputSchema: z.strictObject({
        code: z.string().min(1).max(1_000_000).describe(flavor.codeDescription),
        description: z.string().max(500).optional(),
      }),
      isDestructive: () => true,
      interruptBehavior: 'cancel',
      maxResultSizeChars: 80_000,
      serialize: serializePtcResult,
      getToolUseSummary: (input) => 'run_code (' + input.code.length + ' chars)',
      codeLanguage: options.language ?? 'python',
  };
  return tool(
    config,
    async (input, context) => options.service.run({
      code: input.code,
      context,
      hostTools: options.hostTools,
    }),
  );
}

export function serializePtcResult(record: CodeCellExecutionResult): string {
  return JSON.stringify({
    executionId: record.executionId,
    status: record.status,
    stdout: record.stdout,
    stderr: record.stderr,
    result: record.result,
    error: record.error,
    durationMs: record.durationMs,
    resourceUsage: record.resourceUsage,
    artifacts: record.artifacts,
    ...(record.outputLimit ? { outputLimit: record.outputLimit } : {}),
    ...(record.failureKind ? { failureKind: record.failureKind } : {}),
  }, null, 2);
}
