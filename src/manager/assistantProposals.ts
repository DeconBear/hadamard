/**
 * Assistant staged-action proposals (Agents panel redesign, P3) — the generic
 * sibling of TeamProposalStore for destructive Assistant actions.
 *
 * When a delete-class Assistant tool finds references to its target it does
 * NOT delete; it stages a proposal carrying the reference list and the
 * fallback strategy options. The GUI renders it as a confirmation card (same
 * Apply/Reject interaction as Team graph proposals) and only Apply executes
 * the transaction: `applyDeleteFallback` rewrites referencers, then the
 * definition itself is deleted.
 *
 * `workflow-upsert` proposals stage a workflow script draft; Apply writes it
 * via `saveWorkflow` (project or personal scope).
 */
import { randomUUID } from 'node:crypto';

import type { ReferenceEdge } from './referenceIndex.js';
import {
  applyDeleteFallback,
  type DeleteFallbackStrategy,
  type ReferenceDefinitionKind,
  type ReferenceOperationContext,
} from './referenceOperations.js';
import { deleteAgentProfile } from '../config/agentProfiles.js';
import { removeBridgeConfig } from '../parity/bridgeConfigs.js';
import { deleteRouterProfile } from '../router/modelRouter.js';
import { deleteTeamDefinition, getBuiltInTeamDefinition } from '../team/teamDefinitions.js';
import { saveWorkflow } from '../workflow/workflowPersistence.js';

export type AssistantProposalKind = 'delete-definition' | 'workflow-upsert';
export type AssistantProposalStatus = 'pending' | 'applied' | 'rejected';

/** Strategy option descriptor shown on the confirmation card. */
export interface DeleteFallbackOption {
  type: DeleteFallbackStrategy['type'];
  label: string;
  /** True when Apply must supply a target name (repoint). */
  needsTarget?: boolean;
}

export interface AssistantDeletePayload {
  kind: ReferenceDefinitionKind;
  name: string;
  references: ReferenceEdge[];
  strategies: DeleteFallbackOption[];
}

export interface AssistantWorkflowUpsertPayload {
  name: string;
  description?: string;
  script: string;
  scope: 'project' | 'personal';
  projectPath?: string;
  problems: string[];
}

export interface AssistantProposal {
  id: string;
  assistantSessionId: string;
  kind: AssistantProposalKind;
  title: string;
  explanation: string;
  status: AssistantProposalStatus;
  createdAt: string;
  appliedAt?: string;
  delete?: AssistantDeletePayload;
  workflow?: AssistantWorkflowUpsertPayload;
}

export interface StageDeleteProposalInput {
  assistantSessionId: string;
  kind: ReferenceDefinitionKind;
  name: string;
  references: ReferenceEdge[];
  explanation?: string;
}

export interface StageWorkflowUpsertInput {
  assistantSessionId: string;
  name: string;
  script: string;
  scope: 'project' | 'personal';
  projectPath?: string;
  description?: string;
  explanation?: string;
}

export interface ApplyAssistantProposalContext {
  homeDir?: string;
  /** Project dir for project-scoped routers/teams/workflows and referencers. */
  projectDir?: string;
  /** Full reference-operation context (teamPreferences etc.); defaults to projectDir/homeDir. */
  referenceContext?: ReferenceOperationContext;
}

export interface ApplyAssistantProposalResult {
  proposal: AssistantProposal;
  /** Referencers rewritten by the chosen delete fallback strategy. */
  rewritten: string[];
  /** Written workflow file path (workflow-upsert only). */
  filePath?: string;
}

const WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Fallback strategy options per definition kind (mirrors the P1 impact dialog). */
export function deleteFallbackOptionsForKind(kind: ReferenceDefinitionKind): DeleteFallbackOption[] {
  const leave: DeleteFallbackOption = {
    type: 'leave',
    label: 'Leave references pointing at the deleted name (they show as broken)',
  };
  switch (kind) {
    case 'config':
      return [
        { type: 'repoint', label: 'Re-point references to another config', needsTarget: true },
        leave,
      ];
    case 'agent':
      return [
        { type: 'degrade-model', label: 'Degrade references to a raw model ref (keeps the model name)' },
        { type: 'repoint', label: 'Re-point references to another agent', needsTarget: true },
        leave,
      ];
    case 'team':
      return [
        { type: 'remove-nodes', label: 'Remove referencing nodes (and edges) from other teams' },
        leave,
      ];
    case 'router':
      return [leave];
  }
}

function assertStrategyAllowed(kind: ReferenceDefinitionKind, strategy: DeleteFallbackStrategy): void {
  const allowed = new Set(deleteFallbackOptionsForKind(kind).map(option => option.type));
  if (!allowed.has(strategy.type)) {
    throw new Error(`Fallback strategy "${strategy.type}" is not valid for a ${kind} delete.`);
  }
}

/**
 * Light static checks for staged workflow scripts — mirrors the runtime bans
 * in workflowScriptRuntime (determinism) without executing anything.
 */
export function workflowScriptProblems(name: string, script: string): string[] {
  const problems: string[] = [];
  if (!WORKFLOW_NAME_PATTERN.test(name)) {
    problems.push('Invalid workflow name (use letters, digits, . _ -).');
  }
  if (!script.trim()) {
    problems.push('Workflow script is empty.');
    return problems;
  }
  if (/Date\.now\s*\(/.test(script)) {
    problems.push('Date.now() is not allowed in workflow scripts (breaks resume determinism).');
  }
  if (/Math\.random\s*\(/.test(script)) {
    problems.push('Math.random() is not allowed in workflow scripts (breaks resume determinism).');
  }
  if (/new\s+Date\s*\(/.test(script)) {
    problems.push('new Date() is not allowed in workflow scripts (breaks resume determinism).');
  }
  if (!/export\s+const\s+meta\s*=/.test(script)) {
    problems.push('Workflow script must export const meta = { name, description, phases }.');
  }
  return problems;
}

export class AssistantProposalStore {
  private readonly proposals = new Map<string, AssistantProposal>();

  stageDelete(input: StageDeleteProposalInput): AssistantProposal {
    const name = input.name.trim();
    if (!name) throw new Error('Delete proposal requires a non-empty name.');
    const proposal: AssistantProposal = {
      id: randomUUID(),
      assistantSessionId: input.assistantSessionId,
      kind: 'delete-definition',
      title: `Delete ${input.kind} · ${name}`,
      explanation: input.explanation?.trim() ?? '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      delete: {
        kind: input.kind,
        name,
        references: structuredClone(input.references),
        strategies: deleteFallbackOptionsForKind(input.kind),
      },
    };
    this.proposals.set(proposal.id, proposal);
    return structuredClone(proposal);
  }

  stageWorkflowUpsert(input: StageWorkflowUpsertInput): AssistantProposal {
    const name = input.name.trim();
    const problems = workflowScriptProblems(name, input.script);
    const proposal: AssistantProposal = {
      id: randomUUID(),
      assistantSessionId: input.assistantSessionId,
      kind: 'workflow-upsert',
      title: `${input.scope === 'project' ? 'Project' : 'Personal'} workflow · ${name || '(unnamed)'}`,
      explanation: input.explanation?.trim() ?? '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      workflow: {
        name,
        description: input.description?.trim() || undefined,
        script: input.script,
        scope: input.scope,
        projectPath: input.projectPath,
        problems,
      },
    };
    this.proposals.set(proposal.id, proposal);
    return structuredClone(proposal);
  }

  get(id: string): AssistantProposal | null {
    const proposal = this.proposals.get(id);
    return proposal ? structuredClone(proposal) : null;
  }

  listForSession(assistantSessionId: string): AssistantProposal[] {
    return [...this.proposals.values()]
      .filter(item => item.assistantSessionId === assistantSessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(item => structuredClone(item));
  }

  reject(id: string): AssistantProposal {
    const proposal = this.requirePending(id);
    proposal.status = 'rejected';
    return structuredClone(proposal);
  }

  async apply(
    id: string,
    ctx: ApplyAssistantProposalContext = {},
    opts: { strategy?: DeleteFallbackStrategy } = {},
  ): Promise<ApplyAssistantProposalResult> {
    const proposal = this.requirePending(id);

    if (proposal.kind === 'delete-definition') {
      const del = proposal.delete!;
      if (del.kind === 'team' && getBuiltInTeamDefinition(del.name)) {
        throw new Error(`"${del.name}" is a built-in Team and cannot be deleted.`);
      }
      const strategy = opts.strategy ?? { type: 'leave' as const };
      assertStrategyAllowed(del.kind, strategy);
      const rewritten = strategy.type === 'leave'
        ? []
        : (await applyDeleteFallback(del.kind, del.name, strategy,
          ctx.referenceContext ?? { projectDir: ctx.projectDir, homeDir: ctx.homeDir })).rewritten;
      if (del.kind === 'config') {
        removeBridgeConfig(del.name, ctx.homeDir);
      } else if (del.kind === 'agent') {
        deleteAgentProfile(del.name, ctx.homeDir);
      } else if (del.kind === 'router') {
        const deleted = await deleteRouterProfile(del.name, ctx.projectDir, ctx.homeDir);
        if (!deleted) throw new Error(`Router profile not found: ${del.name}`);
      } else {
        const deleted = await deleteTeamDefinition(del.name, ctx.projectDir, ctx.homeDir);
        if (!deleted) throw new Error(`Team not found: ${del.name}`);
      }
      proposal.status = 'applied';
      proposal.appliedAt = new Date().toISOString();
      return { proposal: structuredClone(proposal), rewritten };
    }

    const workflow = proposal.workflow!;
    if (workflow.problems.length) {
      throw new Error(`Workflow proposal is invalid: ${workflow.problems.join('; ')}`);
    }
    const filePath = await saveWorkflow(workflow.name, workflow.script, {
      projectDir: workflow.scope === 'project'
        ? (workflow.projectPath ?? ctx.projectDir)
        : undefined,
      homeDir: ctx.homeDir,
      overwrite: true,
    });
    proposal.status = 'applied';
    proposal.appliedAt = new Date().toISOString();
    return { proposal: structuredClone(proposal), rewritten: [], filePath };
  }

  private requirePending(id: string): AssistantProposal {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error(`Unknown Assistant proposal: ${id}`);
    if (proposal.status !== 'pending') {
      throw new Error(`Assistant proposal ${id} is already ${proposal.status}.`);
    }
    return proposal;
  }
}
