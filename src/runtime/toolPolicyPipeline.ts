/**
 * Composable per-tool policy pipeline (dsh tools/pre-execute +
 * tools/post-execute shape, Hadamard-owned):
 * - PRE stage: ordered listeners mutate one monotonic state. A deny is
 *   sticky - once set, no later listener (including the permission
 *   machinery) runs, so a policy listener can only tighten, never widen.
 * - POST stage: a waterfall over the settled execution result. Listeners
 *   delegate with next() and may accept/replace/enrich or block; the
 *   built-ins keep the current behavior (spill shaping + PostToolUse
 *   lifecycle hooks).
 *
 * @module src/runtime/toolPolicyPipeline
 */
import type { ToolResultBlockParam } from '../provider/types.js';
import type {
  HadamardPermissionDecision,
  ResolvedToolAdapter,
  ResolvedToolExecutionResult,
} from '../types.js';
import { decideHadamardToolPermission } from './hadamardPermissions.js';
import {
  hasLifecycleBlock,
  lifecycleBlockReason,
  runTypedLifecycleHooks,
} from './conversationLifecycle.js';
import type { ExecuteConversationOptions, ToolPolicyPort } from './conversationPorts.js';
import { artifactToolExecutionIfLarge } from './toolResultArtifactStore.js';
import { defineContributionServiceKey } from '../contrib/contributionHost.js';
import type { ContributionApplyContext, HadamardRuntimeContribution } from '../contrib/contributionHost.js';

/** Per-call facts a policy listener reasons over. */
export interface ToolPolicyCall {
  iteration: number;
  toolUseId: string;
  /** Registered (source) tool name. */
  toolName: string;
  /** Model-facing tool name. */
  publicName: string;
  input: unknown;
  adapter: ResolvedToolAdapter;
  workDir: string;
  prompt: string;
  onPermissionDecision?: (decision: HadamardPermissionDecision) => void;
  /** Execution input after the pre stage (set by the executor before the post stage). */
  executionInput?: unknown;
}

/** Monotonic pre-stage state: behavior can only tighten toward deny. */
export interface ToolPrePolicyState {
  behavior: 'allow' | 'deny' | 'ask';
  updatedInput?: unknown;
  reason?: string;
  /** The permission decision, when the built-in permission listener ran. */
  decision?: HadamardPermissionDecision;
  /** A per-call approval came from an interactive approver. */
  explicitApproval?: boolean;
}

export type ToolPrePolicyListener = (call: ToolPolicyCall, state: ToolPrePolicyState) => Promise<void>;

export type ToolPostPolicyDecision =
  | {
      kind: 'accept';
      content?: ToolResultBlockParam['content'];
      additionalContexts?: { type: 'text'; text: string }[];
    }
  | { kind: 'block'; reason: string };

export type ToolPostPolicyListener = (
  call: ToolPolicyCall,
  execution: ResolvedToolExecutionResult,
  next: () => Promise<ToolPostPolicyDecision>,
) => Promise<ToolPostPolicyDecision>;

/**
 * Ordered pre listeners plus a post waterfall. Stateless itself: built-in
 * listeners close over the engine options, so one pipeline instance is
 * per-run and carries no cross-call state.
 */
export class ToolPolicyPipeline implements ToolPolicyPort {
  constructor(
    readonly pre: readonly ToolPrePolicyListener[],
    readonly post: readonly ToolPostPolicyListener[],
  ) {}

  async runPre(call: ToolPolicyCall): Promise<ToolPrePolicyState> {
    const state: ToolPrePolicyState = { behavior: 'allow' };
    for (const listener of this.pre) {
      // Monotonic deny: a denied call never reaches a later listener, so no
      // policy can widen what an earlier one already refused.
      if (state.behavior === 'deny') break;
      await listener(call, state);
    }
    return state;
  }

  async runPost(
    call: ToolPolicyCall,
    execution: ResolvedToolExecutionResult,
  ): Promise<ToolPostPolicyDecision> {
    const base: ToolPostPolicyDecision = { kind: 'accept', content: execution.content };
    let index = 0;
    const next = (): Promise<ToolPostPolicyDecision> => {
      const listener = this.post[index++];
      return listener ? listener(call, execution, next) : Promise.resolve(base);
    };
    return next();
  }
}


/** Contribution seam: resolves a per-run pipeline (same pattern as the conversation extensions). */
export const toolPolicyFactoryKey = defineContributionServiceKey<
  (options: ExecuteConversationOptions) => ToolPolicyPort
>('hadamard.toolPolicy');

/**
 * Registry seam for policy listeners contributed outside the built-in set
 * (built-in extensions, plugins). The pipeline factory reads it live per run,
 * so listeners added or removed later take effect on the next run.
 */
export interface ToolPolicyListenerRegistry {
  addPre(listener: ToolPrePolicyListener): void;
  removePre(listener: ToolPrePolicyListener): boolean;
  addPost(listener: ToolPostPolicyListener): void;
  removePost(listener: ToolPostPolicyListener): boolean;
  pre(): readonly ToolPrePolicyListener[];
  post(): readonly ToolPostPolicyListener[];
}

export class InMemoryToolPolicyListenerRegistry implements ToolPolicyListenerRegistry {
  private readonly preListeners: ToolPrePolicyListener[] = [];
  private readonly postListeners: ToolPostPolicyListener[] = [];

  addPre(listener: ToolPrePolicyListener): void {
    if (!this.preListeners.includes(listener)) this.preListeners.push(listener);
  }

  removePre(listener: ToolPrePolicyListener): boolean {
    const index = this.preListeners.indexOf(listener);
    if (index < 0) return false;
    this.preListeners.splice(index, 1);
    return true;
  }

  addPost(listener: ToolPostPolicyListener): void {
    if (!this.postListeners.includes(listener)) this.postListeners.push(listener);
  }

  removePost(listener: ToolPostPolicyListener): boolean {
    const index = this.postListeners.indexOf(listener);
    if (index < 0) return false;
    this.postListeners.splice(index, 1);
    return true;
  }

  pre(): readonly ToolPrePolicyListener[] {
    return [...this.preListeners];
  }

  post(): readonly ToolPostPolicyListener[] {
    return [...this.postListeners];
  }
}

/** Global listener registry the built-in pipeline factory composes into every per-run pipeline. */
export const toolPolicyListenerRegistryKey = defineContributionServiceKey<ToolPolicyListenerRegistry>(
  'hadamard.toolPolicyListeners',
);

/** Built-in contribution: registers the behavior-preserving pipeline factory. */
export function createBuiltInToolPolicyContribution(): HadamardRuntimeContribution {
  return {
    id: 'hadamard.tool-policy',
    async apply(ctx: ContributionApplyContext) {
      // Optional: tests may load this contribution without the registry.
      const registry = ctx.services.get(toolPolicyListenerRegistryKey);
      const factory = (options: ExecuteConversationOptions): ToolPolicyPipeline =>
        createBuiltInToolPolicyPipeline(options, { pre: registry?.pre(), post: registry?.post() });
      ctx.services.register(toolPolicyFactoryKey, factory);
      return () => { ctx.services.unregister(toolPolicyFactoryKey); };
    },
  };
}


/**
 * Default pipeline preserving the current executor behavior exactly:
 * PreToolUse hooks, then the permission decision (with PermissionDecision
 * hooks), then deny stops; post: spill shaping then PostToolUse hooks.
 * Contributed listeners (`extra`) run before the built-in pre listeners
 * (monotonic deny: they can only tighten) and after the built-in post
 * listeners in the waterfall.
 */
export function createBuiltInToolPolicyPipeline(
  options: ExecuteConversationOptions,
  extra?: { pre?: readonly ToolPrePolicyListener[]; post?: readonly ToolPostPolicyListener[] },
): ToolPolicyPipeline {
  const preToolUseListener: ToolPrePolicyListener = async (call, state) => {
    const outputs = await runTypedLifecycleHooks(
      options,
      'PreToolUse',
      { iteration: call.iteration, input: call.input },
      call.toolName,
    );
    if (hasLifecycleBlock(outputs)) {
      state.behavior = 'deny';
      state.reason = lifecycleBlockReason('PreToolUse', outputs);
    }
  };

  const permissionListener: ToolPrePolicyListener = async (call, state) => {
    if (state.behavior === 'deny') return;
    const decision = await decideHadamardToolPermission({
      mode: options.permissionMode ?? 'default',
      rules: options.permissions ?? [],
      classifier: options.classifier,
      approver: options.approver,
      canUseTool: options.canUseTool,
      adapter: {
        isReadOnly: call.adapter.isReadOnly as ((input?: unknown) => boolean) | undefined,
        isDestructive: call.adapter.isDestructive as ((input?: unknown) => boolean) | undefined,
        isPlanReadOnly: call.adapter.isPlanReadOnly as ((input?: unknown) => boolean) | undefined,
        requiresUserInteraction: call.adapter.requiresUserInteraction,
        checkPermissions: call.adapter.checkPermissions,
      },
      runId: options.runId,
      sessionId: options.sessionId,
      workDir: call.workDir,
      toolName: call.toolName,
      publicName: call.publicName,
      prompt: call.prompt,
      toolInput: call.input,
      iteration: call.iteration,
    });
    call.onPermissionDecision?.(decision);
    options.emit?.({
      type: 'tool.permission',
      runId: options.runId,
      iteration: call.iteration,
      decision,
      timestamp: decision.timestamp,
    });
    const hookOutputs = await runTypedLifecycleHooks(
      options,
      'PermissionDecision',
      { iteration: call.iteration, decision },
      call.toolName,
    );
    if (hasLifecycleBlock(hookOutputs)) {
      state.behavior = 'deny';
      state.reason = lifecycleBlockReason('PermissionDecision', hookOutputs);
      return;
    }
    state.decision = decision;
    state.behavior = decision.behavior;
    if (decision.behavior === 'deny') state.reason = decision.reason;
    // Only override a custom pre-listener's rewrite when the decision itself
    // updated the input; an earlier listener's value stays authoritative.
    if (decision.updatedInput !== undefined) state.updatedInput = decision.updatedInput;
    state.explicitApproval = decision.source === 'approver';
  };

  const postToolUseListener: ToolPostPolicyListener = async (call, execution, next) => {
    const outputs = await runTypedLifecycleHooks(
      options,
      'PostToolUse',
      { iteration: call.iteration, input: call.executionInput, output: execution.rawOutput, isError: execution.isError ?? false },
      call.toolName,
    );
    if (hasLifecycleBlock(outputs)) {
      return { kind: 'block', reason: lifecycleBlockReason('PostToolUse', outputs) };
    }
    return next();
  };

  const spillListener: ToolPostPolicyListener = async (call, execution, next) => {
    const inner = await next();
    if (inner.kind !== 'accept' || execution.isError === true) return inner;
    const artifactMaxChars = Math.min(
      call.adapter.maxResultSizeChars ?? Number.POSITIVE_INFINITY,
      options.config.compact.toolResultArtifactMaxChars ?? 80_000,
    );
    const shaped = await artifactToolExecutionIfLarge(execution, {
      runId: options.runId,
      iteration: call.iteration,
      toolUseId: call.toolUseId,
      toolName: call.publicName,
      workDir: call.workDir,
      maxChars: artifactMaxChars,
    });
    return { kind: 'accept', content: shaped.content, additionalContexts: inner.additionalContexts };
  };

  return new ToolPolicyPipeline(
    [...(extra?.pre ?? []), preToolUseListener, permissionListener],
    [spillListener, postToolUseListener, ...(extra?.post ?? [])],
  );
}


