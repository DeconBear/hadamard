export type ExternalCliRuntime =
  | 'claude'
  | 'codex'
  | 'pi'
  | 'codewhale'
  | 'reasonix'
  | 'crush'
  | 'cursor';

export type ExternalCliSessionRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ExternalCliToolMetadata {
  kind: 'call' | 'result';
  id?: string;
  name?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
}

export interface ExternalCliSessionMessage {
  role: ExternalCliSessionRole;
  text: string;
  timestamp?: string;
  model?: string;
  tools?: ExternalCliToolMetadata[];
}

export interface ExternalCliSessionSummary {
  runtime: ExternalCliRuntime;
  nativeSessionId: string;
  title: string;
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  path: string;
  /** True when messageCount was produced by a bounded scan rather than a full transcript scan. */
  truncated?: boolean;
}

export interface ExternalCliSession {
  summary: ExternalCliSessionSummary;
  messages: ExternalCliSessionMessage[];
  /** True when the configured byte or message limit stopped the detail scan early. */
  truncated?: boolean;
}
