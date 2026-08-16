import type { AgentToolDefinition, ToolExecutionContext } from '../types.js';

export type CodeActLanguage = 'python';
export type CodeActBackend = 'process' | 'container';
/** Stateless run_code backend selector: the kernel backends plus the zero-dependency worker thread. */
export type CodeActPtcBackend = CodeActBackend | 'worker-thread';
export type CodeActSecurityMode = 'trusted' | 'enforce';

/** Orthogonal cell-run failure kinds (dsh CodeRunFailure equivalent): the error is a result field, never a rejection. */
export type CodeRunFailureKind = 'exception' | 'timeout' | 'interrupt' | 'kernel-exit' | 'output-limit' | 'invalid-output';

export interface CodeActSettings {
  enabled: boolean;
  backend?: CodeActBackend;
  /** Backend for the stateless run_code transport; defaults to `backend` when unset. */
  ptcBackend?: CodeActPtcBackend;
  securityMode?: CodeActSecurityMode;
  pythonCommand?: string;
  idleTimeoutMs?: number;
  executionTimeoutMs?: number;
  maxOutputChars?: number;
  /** Hard outer-output byte budget (stdout/stderr + host RPC payloads + final result envelope); exceeding it hard-stops the cell with a single output-limit failure. Defaults to 4× maxOutputChars. */
  maxOutputBytes?: number;
  environmentAllowlist?: string[];
  containerImage?: string;
  containerMemoryMb?: number;
  containerCpuLimit?: number;
  /** Upper bound for in-flight parallel host-tool sub-calls made from a cell. */
  maxParallelSubCalls?: number;
}

export interface ResolvedCodeActSettings {
  enabled: boolean;
  backend: CodeActBackend;
  ptcBackend: CodeActPtcBackend;
  securityMode: CodeActSecurityMode;
  pythonCommand: string;
  idleTimeoutMs: number;
  executionTimeoutMs: number;
  maxOutputChars: number;
  /** Hard outer-output byte budget (stdout/stderr + host RPC payloads + final result envelope); exceeding it hard-stops the cell with a single output-limit failure. */
  maxOutputBytes: number;
  environmentAllowlist: string[];
  containerImage: string;
  containerMemoryMb: number;
  containerCpuLimit: number;
  /** Upper bound for in-flight parallel host-tool sub-calls made from a cell. */
  maxParallelSubCalls: number;
}

export interface CodeActBackendStatus {
  backend: CodeActBackend;
  available: boolean;
  isolation: 'trusted-only' | 'strong';
  detail: string;
}

export interface CodeActArtifactReference {
  id: string;
  name: string;
  mediaType: string;
  path?: string;
  sizeBytes?: number;
}

export interface CodeCellStructuredResult {
  type: string;
  value?: unknown;
  repr?: string;
}

export interface CodeCellExecutionRequest {
  executionId: string;
  sessionId: string;
  language: CodeActLanguage;
  code: string;
  workDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Abort the per-cell controller from inside the adapter so started nested calls observe settlement abort before drain. */
  abort?: (reason: Error) => void;
  hostRpc?: CodeActHostRpcHandler;
  onDelta?: (stream: 'stdout' | 'stderr', delta: string) => void;
  /** Sanitized method name → real host tool name, for typed `hadamard.<name>` dispatch. */
  toolNameMap?: Record<string, string>;
}

export interface CodeCellExecutionResult {
  executionId: string;
  sessionId: string;
  generation: number;
  status: 'completed' | 'failed' | 'interrupted';
  stdout: string;
  stderr: string;
  result?: CodeCellStructuredResult;
  error?: string;
  durationMs: number;
  resourceUsage?: Record<string, number>;
  artifacts: CodeActArtifactReference[];
  stateLost?: boolean;
  /** Present only with status 'failed' + failureKind 'output-limit': the hard outer-output budget was exceeded. */
  outputLimit?: boolean;
  /** Structured failure classification for the settled cell run. */
  failureKind?: CodeRunFailureKind;
}

export interface CodeCellExecutionRecord extends CodeCellExecutionResult {
  sourceHash: string;
  code: string;
  language: CodeActLanguage;
  startedAt: string;
  completedAt: string;
  recordPath?: string;
}

export interface CodeActHostRpcRequest {
  id: string;
  method: string;
  input: unknown;
}

export interface CodeActHostRpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  artifact?: CodeActArtifactReference;
}

export interface CodeActHostRpcHandler {
  /** Route one host request through the per-cell sub-dispatch scheduler. */
  dispatch(request: CodeActHostRpcRequest): Promise<CodeActHostRpcResponse>;
  /** Stop new dispatches, abandon queued-unstarted calls, and drain started ones. */
  drain(): Promise<void>;
}

export interface CodeActKernel {
  readonly sessionId: string;
  readonly generation: number;
  execute(request: CodeCellExecutionRequest): Promise<CodeCellExecutionResult>;
  interrupt(executionId: string): Promise<boolean>;
  stop(reason?: string): Promise<void>;
}

export interface CodeActKernelStartOptions {
  sessionId: string;
  generation: number;
  workDir: string;
  environment: Record<string, string>;
  maxOutputChars: number;
  maxOutputBytes: number;
}

export interface CodeActKernelAdapter {
  readonly backend: CodeActBackend;
  readonly isolation: 'trusted-only' | 'strong';
  selfCheck(): Promise<CodeActBackendStatus>;
  start(options: CodeActKernelStartOptions): Promise<CodeActKernel>;
}

export interface CodeActToolOptions {
  service: {
    execute(input: {
      language: CodeActLanguage;
      code: string;
      timeoutMs?: number;
      context: ToolExecutionContext;
      hostTools?: readonly AgentToolDefinition[];
    }): Promise<CodeCellExecutionRecord>;
  };
  hostTools?: readonly AgentToolDefinition[];
}
