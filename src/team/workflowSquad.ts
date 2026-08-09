import type {
  ModelTeamResult,
  TeamAskOptions,
  TeamDefinition,
  TeamEvent,
  TeamMember,
  WorkflowNode,
} from '../types.js';
import { AgentPool } from './agentPool.js';
import { memberSignal, runMemberAgent } from './teamRuntime.js';
import { buildGraphNodeTools } from './teamGraph.js';
import { resolveTargetRef } from '../manager/resolveTargetRef.js';
import { resolveExecutorTarget } from './executorTarget.js';
import {
  resolveEffectiveAgentRunOptions,
  type EffectiveAgentRunOptions,
} from '../runtime/effectiveAgentRunOptions.js';

const MAX_WORKFLOW_NODES = 128;
const MAX_WORKFLOW_DEPTH = 32;

export function validateWorkflowSquad(
  definition: Pick<TeamDefinition, 'workflowTree'>,
): string[] {
  const root = definition.workflowTree;
  if (!root) return ['Workflow requires a root node'];

  const problems: string[] = [];
  const ids = new Set<string>();
  let nodeCount = 0;

  const visit = (node: WorkflowNode, depth: number): void => {
    nodeCount += 1;
    if (nodeCount > MAX_WORKFLOW_NODES) return;
    if (depth > MAX_WORKFLOW_DEPTH) {
      problems.push(`Workflow exceeds the maximum depth of ${MAX_WORKFLOW_DEPTH}`);
      return;
    }

    const id = typeof node.id === 'string' ? node.id.trim() : '';
    if (!id) problems.push('Every workflow node requires an id');
    else if (ids.has(id)) problems.push(`Duplicate workflow node id "${id}"`);
    else ids.add(id);

    const children = Array.isArray(node.children) ? node.children : [];
    if (!Array.isArray(node.children)) {
      problems.push(`Workflow node "${id || '(unnamed)'}" requires a children array`);
    }
    const type = String(node.type);
    if (type === 'agent' && children.length > 1) {
      problems.push(`Agent node "${id}" may have at most one continuation`);
    } else if (type === 'branch') {
      if (!node.condition?.trim()) problems.push(`Branch node "${id}" requires a condition`);
      if (children.length !== 2) problems.push(`Branch node "${id}" requires exactly two children`);
    } else if (type === 'parallel' && children.length < 2) {
      problems.push(`Parallel node "${id}" requires at least two children`);
    } else if (type !== 'agent' && type !== 'branch' && type !== 'parallel') {
      problems.push(`Workflow node "${id}" has unsupported type "${type}"`);
    }
    children.forEach(child => visit(child, depth + 1));
  };

  visit(root, 1);
  if (nodeCount > MAX_WORKFLOW_NODES) {
    problems.push(`Workflow exceeds the maximum size of ${MAX_WORKFLOW_NODES} nodes`);
  }
  return [...new Set(problems)];
}

export async function executeWorkflowTree(
  root: WorkflowNode,
  input: string,
  runAgent: (node: WorkflowNode, input: string) => Promise<string>,
): Promise<string> {
  const execute = async (node: WorkflowNode, nodeInput: string): Promise<string> => {
    if (node.type === 'agent') {
      const output = await runAgent(node, nodeInput);
      const continuation = node.children?.[0];
      return continuation ? execute(continuation, output) : output;
    }
    if (node.type === 'branch') {
      const matches = nodeInput.toLowerCase().includes((node.condition ?? '').toLowerCase());
      return execute(node.children[matches ? 0 : 1]!, nodeInput);
    }
    const outputs = await Promise.all(node.children.map(child => execute(child, nodeInput)));
    return outputs.filter(Boolean).join('\n\n');
  };

  return execute(root, input);
}

export interface WorkflowRunDependencies {
  runMember?: typeof runMemberAgent;
  loadTeam?: (name: string, workDir: string) => TeamDefinition | null;
  askTeam?: (
    definition: TeamDefinition,
    prompt: string,
    signal: AbortSignal,
    options: TeamAskOptions,
  ) => Promise<ModelTeamResult>;
}

function namespaceTeamEvent(event: TeamEvent, prefix: string): TeamEvent {
  switch (event.type) {
    case 'team.started':
      return { ...event, members: event.members.map(member => ({ ...member, id: `${prefix}/${member.id}` })) };
    case 'team.member.started':
    case 'team.member.tool':
    case 'team.member.completed':
      return { ...event, id: `${prefix}/${event.id}` };
    case 'team.edge.triggered':
      return { ...event, from: `${prefix}/${event.from}`, to: `${prefix}/${event.to}` };
    case 'team.returned':
      return { ...event, nodeId: `${prefix}/${event.nodeId}` };
    default:
      return event;
  }
}

function workflowAgentNodes(root: WorkflowNode): WorkflowNode[] {
  const result: WorkflowNode[] = [];
  const visit = (node: WorkflowNode): void => {
    if (node.type === 'agent') result.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return result;
}

export async function runWorkflowSquad(
  definition: TeamDefinition,
  prompt: string,
  signal: AbortSignal,
  workDir: string,
  onEvent?: (event: TeamEvent) => void,
  options: TeamAskOptions = {},
  dependencies: WorkflowRunDependencies = {},
): Promise<ModelTeamResult> {
  const problems = validateWorkflowSquad(definition);
  if (problems.length > 0) {
    throw new Error(`Invalid workflow "${definition.name}": ${problems.join('; ')}`);
  }

  const pool = new AgentPool();
  const startedAt = Date.now();
  const statuses: ModelTeamResult['memberStatuses'] = [];
  const reports: ModelTeamResult['reports'] = [];
  let totalInput = 0;
  let totalOutput = 0;
  const agentNodes = workflowAgentNodes(definition.workflowTree!);

  onEvent?.({
    type: 'team.started',
    mode: 'workflow',
    members: agentNodes.map(node => ({
      id: node.id,
      model: node.targetRef?.kind === 'model' ? node.targetRef.model : node.model || '',
      role: node.label || 'agent',
    })),
  });

  const answer = await executeWorkflowTree(definition.workflowTree!, prompt, async (node, input) => {
    const task = node.prompt ? node.prompt.replace(/\{\{input\}\}/gu, input) : input;

    if (node.targetRef?.kind === 'team') {
      const ref = node.targetRef.name.trim();
      const prefix = `${node.id}/${ref}`;
      const startedAt = Date.now();
      if ((options.teamStack ?? []).includes(ref)) {
        const cycle = [...(options.teamStack ?? []), ref].join(' -> ');
        const error = `team recursion: ${cycle}`;
        statuses.push({ id: node.id, model: '', role: node.label || 'agent', ok: false, error, toolCalls: 0, durationMs: 0 });
        return `[team recursion detected: ${cycle}]`;
      }
      let nested: TeamDefinition;
      try {
        const resolved = resolveExecutorTarget(node.targetRef, {
          projectDir: workDir,
          homeDir: options.homeDir,
          loadTeam: dependencies.loadTeam,
        });
        nested = resolved.definition;
      } catch {
        const error = `team "${ref}" not found`;
        statuses.push({ id: node.id, model: '', role: node.label || 'agent', ok: false, error, toolCalls: 0, durationMs: 0 });
        return `[${error}]`;
      }
      try {
        const askNested = dependencies.askTeam ?? (async (nestedDefinition, nestedPrompt, nestedSignal, nestedOptions) => {
          const { askTeamDefinition } = await import('./modelTeam.js');
          return askTeamDefinition(nestedDefinition, nestedPrompt, nestedSignal, nestedOptions);
        });
        const nestedSignal = memberSignal(signal, node.timeoutMs ?? definition.timeoutMs) ?? signal;
        const result = await askNested(nested, task, nestedSignal, {
          ...options,
          workDir,
          teamStack: options.teamStack,
          onEvent: onEvent ? event => onEvent(namespaceTeamEvent(event, prefix)) : undefined,
        });
        totalInput += result.cost.totalInputTokens;
        totalOutput += result.cost.totalOutputTokens;
        for (const status of result.memberStatuses ?? []) {
          statuses.push({ ...status, id: `${prefix}/${status.id}` });
        }
        for (const report of result.reports ?? []) {
          reports.push({ ...report, id: `${prefix}/${report.id ?? report.model}` });
        }
        statuses.push({
          id: node.id,
          model: '',
          role: node.label || 'agent',
          ok: !result.incompleteReason,
          error: result.incompleteReason,
          toolCalls: 0,
          durationMs: Date.now() - startedAt,
        });
        return result.answer;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        statuses.push({ id: node.id, model: '', role: node.label || 'agent', ok: false, error: message, toolCalls: 0, durationMs: Date.now() - startedAt });
        return `[team "${ref}" failed: ${message}]`;
      }
    }

    // P2: per-node executor/targetRef + system prompt + tools + limits.
    const member: TeamMember = {
      model: node.model || options.model || '',
      role: node.label || 'agent',
      systemPrompt: node.systemPrompt || '',
    };
    let targetAgentSource:
      | ReturnType<typeof resolveTargetRef>['agentDefinition']
      | ReturnType<typeof resolveTargetRef>['agentProfile'];
    let targetInheritsModel = false;
    if (node.targetRef) {
      try {
        const resolved = resolveExecutorTarget(node.targetRef, {
          projectDir: workDir,
          homeDir: options.homeDir,
        });
        if (resolved.model) member.model = resolved.model;
        if (resolved.provider) member.provider = resolved.provider;
        if (resolved.baseURL) member.baseURL = resolved.baseURL;
        if (resolved.apiKey) member.apiKey = resolved.apiKey;
        targetAgentSource = resolved.agentDefinition ?? resolved.agentProfile;
        targetInheritsModel = Boolean(targetAgentSource && !resolved.model);
      } catch (err) {
        return `[unavailable: ${err instanceof Error ? err.message : String(err)}]`;
      }
    }
    let effectiveAgentOptions: EffectiveAgentRunOptions | undefined;
    if (targetAgentSource) {
      effectiveAgentOptions = resolveEffectiveAgentRunOptions(targetAgentSource, {
        systemPrompt: node.systemPrompt || '',
        permissionModeOverride: options.permissionMode,
      });
      if (typeof node.maxIterations === 'number') {
        effectiveAgentOptions.maxToolIterations = node.maxIterations;
      }
    }
    const effectiveAllowedTools = effectiveAgentOptions?.allowedTools ?? node.allowedTools;
    const tools = effectiveAllowedTools?.length
      ? await buildGraphNodeTools({ id: node.id, allowedTools: effectiveAllowedTools }, workDir)
      : [];
    const systemPrompt = effectiveAgentOptions?.systemPrompt ?? node.systemPrompt ?? '';
    const run = await (dependencies.runMember ?? runMemberAgent)({
      identity: { id: node.id, model: member.model, role: node.label || node.type },
      member,
      task,
      systemPrompt,
      cwd: workDir,
      tools,
      maxIterations: node.maxIterations ?? definition.maxIterations ?? Infinity,
      timeoutMs: node.timeoutMs ?? effectiveAgentOptions?.timeoutMs ?? definition.timeoutMs ?? 300_000,
      signal,
      permissionMode: options.permissionMode,
      permissions: options.permissions,
      classifier: options.classifier,
      approver: options.approver,
      hooks: options.hooks,
      effectiveAgentOptions,
      workspaceAccess: node.workspaceAccess,
      modelApi: targetInheritsModel ? options.modelApi : undefined,
      pool,
      round: 1,
      onEvent,
    });
    statuses.push(run.status);
    totalInput += run.inputTokens;
    totalOutput += run.outputTokens;
    return run.report;
  });

  const failed = statuses.filter(status => !status.ok);
  const incompleteReason = failed.length > 0
    ? `${failed.length} of ${statuses.length} workflow node run(s) failed`
    : undefined;
  onEvent?.({ type: 'team.completed', mode: 'workflow', rounds: 1, incompleteReason });

  return {
    answer,
    mode: 'workflow',
    cost: {
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      estimatedCost: null,
      breakdown: [],
    },
    durationMs: Date.now() - startedAt,
    memberStatuses: statuses,
    reports,
    skippedNodes: [],
    incompleteReason,
  };
}

/** Run a single-agent squad (`squadType: agent` / legacy `subagent`). */
export async function runSingleAgentSquad(
  definition: TeamDefinition,
  prompt: string,
  signal: AbortSignal,
  workDir: string,
  onEvent?: (event: TeamEvent) => void,
  opts?: TeamAskOptions,
): Promise<ModelTeamResult> {
  const member = definition.members?.[0];
  if (!member) throw new Error(`Agent squad "${definition.name}" has no member`);
  // Unified reference model: a typed targetRef overrides the by-value fields.
  const effectiveMember: TeamMember = { ...member, model: member.model || opts?.model || '' };
  let targetAgentSource:
    | ReturnType<typeof resolveTargetRef>['agentDefinition']
    | ReturnType<typeof resolveTargetRef>['agentProfile'];
  let targetInheritsModel = false;
  if (member.targetRef && member.targetRef.kind !== 'team') {
    const resolved = resolveExecutorTarget(member.targetRef, {
      projectDir: workDir,
      homeDir: opts?.homeDir,
    });
    if (resolved.model) effectiveMember.model = resolved.model;
    if (resolved.provider) effectiveMember.provider = resolved.provider;
    if (resolved.baseURL) effectiveMember.baseURL = resolved.baseURL;
    if (resolved.apiKey) effectiveMember.apiKey = resolved.apiKey;
    targetAgentSource = resolved.agentDefinition ?? resolved.agentProfile;
    targetInheritsModel = Boolean(targetAgentSource && !resolved.model);
  }
  const pool = new AgentPool();
  const identity = {
    id: member.id || member.role || member.name || definition.name,
    model: effectiveMember.model,
    role: member.role || member.name || definition.name,
  };
  const startedAt = Date.now();
  const baseSystemPrompt = [member.systemPrompt || '', opts?.context?.trim() || '']
    .filter(Boolean)
    .join('\n\n');
  const effectiveAgentOptions = targetAgentSource
    ? resolveEffectiveAgentRunOptions(targetAgentSource, { systemPrompt: baseSystemPrompt })
    : undefined;
  const systemPrompt = effectiveAgentOptions?.systemPrompt ?? baseSystemPrompt;
  const effectiveAllowedTools = effectiveAgentOptions?.allowedTools ?? member.allowedTools;
  const tools = effectiveAllowedTools?.length
    ? await buildGraphNodeTools({ id: identity.id, allowedTools: effectiveAllowedTools }, workDir)
    : [];
  const run = await runMemberAgent({
    identity,
    member: effectiveMember,
    task: prompt,
    systemPrompt,
    cwd: workDir,
    tools,
    maxIterations: (member as { maxIterations?: number }).maxIterations
      ?? definition.maxIterations
      ?? Infinity,
    timeoutMs: effectiveAgentOptions?.timeoutMs ?? definition.timeoutMs ?? 300_000,
    signal,
    effectiveAgentOptions,
    workspaceAccess: member.workspaceAccess,
    modelApi: targetInheritsModel ? opts?.modelApi : undefined,
    pool,
    round: 1,
    onEvent,
  });
  return {
    answer: run.report,
    mode: 'graph',
    cost: {
      totalInputTokens: run.inputTokens,
      totalOutputTokens: run.outputTokens,
      estimatedCost: null,
      breakdown: [],
    },
    durationMs: Date.now() - startedAt,
    memberStatuses: [run.status],
    reports: [],
    skippedNodes: [],
    incompleteReason: run.status.error,
  };
}
