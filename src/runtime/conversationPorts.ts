import type { MessageParam } from '../provider/types.js';
import type { HookRunner } from '../hooks/hookRunner.js';
import type {
  AgentEvent,
  AgentMcpServerDefinition,
  AgentRunOptions,
  AgentToolDefinition,
  HadamardHooks,
  ModelApi,
  ResolvedRuntimeConfig,
  ToolExecutionContext,
} from '../types.js';
import type { McpConnectionManager } from '../mcp/connectionManager.js';

export interface ConversationInputOptions {
  runId: string;
  input: string | MessageParam['content'];
  messages?: MessageParam[];
  prefixedMessages?: MessageParam[];
  sessionId?: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  toolChoice?: AgentRunOptions['toolChoice'];
  userId?: string;
  metadata?: Record<string, unknown>;
  projectInstructions?: AgentRunOptions['projectInstructions'];
  effort?: AgentRunOptions['effort'];
  signal?: AbortSignal;
  streaming: boolean;
  skipRunStartedEvent?: boolean;
  skipInitialInput?: boolean;
}

export interface ConversationToolOptions {
  tools?: AgentToolDefinition[];
  mcpServers?: AgentMcpServerDefinition[];
  permissionMode?: AgentRunOptions['permissionMode'];
  permissions?: AgentRunOptions['permissions'];
  classifier?: AgentRunOptions['classifier'];
  approver?: AgentRunOptions['approver'];
  canUseTool?: AgentRunOptions['canUseTool'];
  fileChangeJournal?: ToolExecutionContext['fileChangeJournal'];
  sandboxExecutor?: ToolExecutionContext['sandboxExecutor'];
}

export interface ConversationLifecycleOptions {
  hooks?: HadamardHooks;
  typedHookRunner?: HookRunner;
  emit?: (event: AgentEvent) => void;
  /** Per-iteration request-config proposal hook (dsh agent/request equivalent). */
  onRequestProposal?: (context: import('../types.js').HadamardRequestProposalContext) =>
    | import('../types.js').HadamardRequestProposal
    | void
    | Promise<import('../types.js').HadamardRequestProposal | void>;
}

export interface ConversationQueueOptions {
  drainQueuedInputs?: () => string[] | Promise<string[]>;
  drainFollowUpInputs?: () => string[];
}

export interface ConversationPersistenceOptions {
  onConversationCheckpoint?: (messages: MessageParam[]) => void | Promise<void>;
  onTranscriptMessages?: (messages: MessageParam[]) => void | Promise<void>;
  takePendingConversationRestore?: () => MessageParam[] | undefined;
  sessionWorkDir?: string;
  onSessionWorkDirChange?: (workDir: string) => void;
}

export interface ConversationRuntimeDependencies {
  modelApi: ModelApi;
  config: ResolvedRuntimeConfig;
  mcpManager: McpConnectionManager;
}

/** Compatibility composite; collaborators consume the smaller role interfaces above. */
export interface ExecuteConversationOptions
  extends ConversationInputOptions,
    ConversationToolOptions,
    ConversationLifecycleOptions,
    ConversationQueueOptions,
    ConversationPersistenceOptions,
    ConversationRuntimeDependencies {}
