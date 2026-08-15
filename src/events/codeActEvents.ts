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
  /** Present only with status 'failed' + failureKind 'output-limit'. */
  outputLimit?: boolean;
  failureKind?: 'exception' | 'timeout' | 'interrupt' | 'kernel-exit' | 'output-limit';
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

/** Structured audit record for one host-tool sub-dispatch made from inside a code cell. */
export interface ToolCodeDispatchEvent {
  type: 'tool.code_dispatch';
  runId: string;
  iteration: number;
  /** Outer CodeCell tool-use id anchoring this sub-call. */
  rootCallId: string;
  /** Correlated sub-call id: `${rootCallId}:host:${requestId}`. */
  subCallId: string;
  /** Host tool name (or the raw RPC method, e.g. artifact.put). */
  name: string;
  phase: 'start' | 'settle';
  isError?: boolean;
  /** Brief lossless-JSON argument or result summary (bounded). */
  summary?: string;
  timestamp: string;
}

