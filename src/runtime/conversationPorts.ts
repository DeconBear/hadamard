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
  /**
   * Injected step context (dsh inject target): delivered at the NEXT step
   * boundary inside the tool-results user message, and — unlike steering —
   * never keeps a turn alive on its own (no wake).
   */
  drainInjectInputs?: () => string[] | Promise<string[]>;
}

export interface ConversationPersistenceOptions {
  onConversationCheckpoint?: (messages: MessageParam[]) => void | Promise<void>;
  onTranscriptMessages?: (messages: MessageParam[]) => void | Promise<void>;
  /** Structured append-only trajectory events (audit/replay channel). */
  onTrajectoryEvent?: (event: import('./trajectoryEvents.js').TrajectoryEvent) => void | Promise<void>;
  takePendingConversationRestore?: () => MessageParam[] | undefined;
  sessionWorkDir?: string;
  onSessionWorkDirChange?: (workDir: string) => void;
}

export interface ConversationRuntimeDependencies {
  modelApi: ModelApi;
  config: ResolvedRuntimeConfig;
  mcpManager: McpConnectionManager;
}

export interface ConversationStrategyOptions {
  /** Swappable strategies (compaction/request-error/repeat-guard/todo-reminder); defaults to the built-ins. */
  extensions?: import('../types.js').ConversationExtensionPoints;
  /** How tools are presented on the wire: native JSON schemas, one stateless run_code wire tool, or both. */
  toolPresentation?: import('../codeact/presentationTypes.js').ToolPresentationMode;
  /** Per-run tool policy pipeline (pre/post waterfalls); defaults to the built-ins. */
  toolPolicy?: ToolPolicyPort;
  /** Factory resolving the tool policy pipeline for this run (contribution seam). */
  toolPolicyFactory?: (options: ExecuteConversationOptions) => ToolPolicyPort;
}

/** Compatibility composite; collaborators consume the smaller role interfaces above. */
export interface ExecuteConversationOptions
  extends ConversationInputOptions,
    ConversationToolOptions,
    ConversationLifecycleOptions,
    ConversationQueueOptions,
    ConversationPersistenceOptions,
    ConversationStrategyOptions,
    ConversationRuntimeDependencies {}
/**
 * Structural port for the per-tool policy pipeline. Declared here (no
 * imports) so the pipeline module can implement it without a cycle:
 * conversationPorts stays a leaf of the import graph.
 */
export interface ToolPolicyPort {
  runPre(call: unknown): Promise<{
    behavior: 'allow' | 'deny' | 'ask';
    updatedInput?: unknown;
    reason?: string;
    decision?: { behavior?: 'allow' | 'deny'; source?: string; updatedInput?: unknown };
    explicitApproval?: boolean;
  }>;
  runPost(call: unknown, execution: unknown): Promise<
    | { kind: 'accept'; content?: unknown; additionalContexts?: { type: 'text'; text: string }[] }
    | { kind: 'block'; reason: string }
  >;
}
