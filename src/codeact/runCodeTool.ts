import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';
import type { CodeCellExecutionResult } from './types.js';

/** Wire-tool name for the stateless PTC presentation (reserved like dsh run_code). */
export const RUN_CODE_TOOL_NAME = 'run_code';

export interface ProgrammaticToolService {
  run(input: {
    code: string;
    context: import('../types.js').ToolExecutionContext;
    hostTools: readonly AgentToolDefinition[];
  }): Promise<CodeCellExecutionResult>;
}

export function createRunCodeTool(options: {
  service: ProgrammaticToolService;
  hostTools: readonly AgentToolDefinition[];
}): AgentToolDefinition {
  return tool(
    {
      name: RUN_CODE_TOOL_NAME,
      description: [
        'Executes one stateless Python program that can compose multiple host tool calls (hadamard.<tool>(...) or hadamard.tool("<name>", {...})).',
        'The program runs in a fresh environment every call; only print() output and the final expression value are returned.',
      ].join(' '),
      inputSchema: z.strictObject({
        code: z.string().min(1).max(1_000_000),
        description: z.string().max(500).optional(),
      }),
      isDestructive: () => true,
      interruptBehavior: 'cancel',
      maxResultSizeChars: 80_000,
      serialize: serializePtcResult,
      getToolUseSummary: (input) => `run_code (${input.code.length} chars)`,
    },
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

