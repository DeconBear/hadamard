import type { AgentToolDefinition, ToolExecutionContext } from '../types.js';

export type CodeActLanguage = 'python';
export type CodeActBackend = 'process' | 'container';
export type CodeActSecurityMode = 'trusted' | 'enforce';

export interface CodeActSettings {
  enabled: boolean;
  backend?: CodeActBackend;
  securityMode?: CodeActSecurityMode;
  pythonCommand?: string;
  idleTimeoutMs?: number;
  executionTimeoutMs?: number;
  maxOutputChars?: number;
  environmentAllowlist?: string[];
  containerImage?: string;
  containerMemoryMb?: number;
  containerCpuLimit?: number;
}

export interface ResolvedCodeActSettings {
  enabled: boolean;
  backend: CodeActBackend;
  securityMode: CodeActSecurityMode;
  pythonCommand: string;
  idleTimeoutMs: number;
  executionTimeoutMs: number;
  maxOutputChars: number;
  environmentAllowlist: string[];
  containerImage: string;
  containerMemoryMb: number;
  containerCpuLimit: number;
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
  hostRpc?: CodeActHostRpcHandler;
  onDelta?: (stream: 'stdout' | 'stderr', delta: string) => void;
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

export type CodeActHostRpcHandler = (
  request: CodeActHostRpcRequest,
) => Promise<CodeActHostRpcResponse>;

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
