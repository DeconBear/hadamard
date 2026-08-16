import { z } from 'zod';

import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';
import type { CodeActToolOptions, CodeCellExecutionRecord } from './types.js';

export const CODE_CELL_TOOL_NAME = 'CodeCell';

export function createCodeCellTool(options: CodeActToolOptions): AgentToolDefinition {
  return tool(
    {
      name: CODE_CELL_TOOL_NAME,
      description: [
        'Executes one Python code cell in the persistent kernel for this Hadamard session.',
        'Variables persist between cells until the kernel restarts. stdout, stderr, the final expression,',
        'resource usage, artifacts, and state-loss markers are returned as an auditable tool result.',
      ].join(' '),
      inputSchema: z.strictObject({
        language: z.literal('python').optional().default('python'),
        code: z.string().min(1).max(1_000_000),
        timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
      }),
      isDestructive: () => true,
      interruptBehavior: 'cancel',
      maxResultSizeChars: 80_000,
      serialize: serializeCodeCellResult,
      getToolUseSummary: input => `Python cell (${input.code.length} chars)`,
    },
    async (input, context) => options.service.execute({
      language: input.language,
      code: input.code,
      timeoutMs: input.timeoutMs,
      context,
      hostTools: options.hostTools,
    }),
  );
}

function serializeCodeCellResult(record: CodeCellExecutionRecord): string {
  // Model-facing projection: host-side bookkeeping (execution/generation/
  // source hash/record path) stays in the audit record on disk, not in the
  // prompt (C8: dsh RunCodeOutput.render shape — only the curated outcome).
  return JSON.stringify({
    status: record.status,
    stdout: record.stdout,
    stderr: record.stderr,
    result: record.result,
    error: record.error,
    durationMs: record.durationMs,
    stateLost: record.stateLost ?? false,
    outputLimit: record.outputLimit ?? false,
    ...(record.failureKind ? { failureKind: record.failureKind } : {}),
    artifacts: record.artifacts,
  }, null, 2);
}
