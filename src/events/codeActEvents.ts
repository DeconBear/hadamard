export interface AgentCodeCellResult {
  executionId: string;
  sessionId: string;
  generation: number;
  status: 'completed' | 'failed' | 'interrupted';
  stdout: string;
  stderr: string;
  result?: { type: string; value?: unknown; repr?: string };
  error?: string;
  durationMs: number;
  resourceUsage?: Record<string, number>;
  artifacts: Array<{
    id: string;
    name: string;
    mediaType: string;
    path?: string;
    sizeBytes?: number;
  }>;
  stateLost?: boolean;
}

interface CodeActEventBase {
  runId: string;
  sessionId: string;
  generation: number;
  timestamp: string;
}

export type CodeActAgentEvent =
  | (CodeActEventBase & {
      type: 'code_cell.started';
      executionId: string;
      language: 'python';
      sourceHash: string;
    })
  | (CodeActEventBase & {
      type: 'code_cell.delta';
      executionId: string;
      stream: 'stdout' | 'stderr';
      delta: string;
    })
  | (CodeActEventBase & {
      type: 'code_cell.completed' | 'code_cell.failed' | 'code_cell.interrupted';
      executionId: string;
      result: AgentCodeCellResult;
    })
  | (CodeActEventBase & {
      type: 'kernel.started' | 'kernel.restarted' | 'kernel.stopped';
      reason?: string;
    });
