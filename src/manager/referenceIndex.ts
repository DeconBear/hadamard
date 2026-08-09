/**
 * Reference index for the unified reference model (Agents panel redesign §2.3).
 *
 * Pure functions over already-loaded definitions: the caller supplies bridge
 * configs, agent profiles, router profiles, team definitions, automation
 * tasks, preferences and active-session state; the module emits the reference
 * edges between them. The GUI server builds this on demand for
 * `/api/references` (definition counts are small, so a full scan is cheap) and
 * the same edges power the broken-reference badges in the Agents panel.
 */
import type {
  AgentTargetRef,
  RouterProfile,
  ScheduledAutomationTask,
  TeamDefinition,
  WorkflowNode,
} from '../types.js';
import type { PersistedBridgeConfig } from '../parity/bridgeConfigs.js';
import type { AgentProfile } from '../config/agentProfiles.js';
import type { TeamPreferences } from '../team/teamPreferences.js';
import { migrateRouterRouteTarget } from '../router/modelRouter.js';

/** Who holds the reference. `preference`/`session` mark non-definition active-state edges. */
export type ReferenceSourceKind =
  | 'agent'
  | 'router'
  | 'team'
  | 'workflow'
  | 'automation'
  | 'assistant'
  | 'preference'
  | 'manager'
  | 'issue'
  | 'session';

/** What the reference points at. */
export type ReferenceTargetKind = 'config' | 'agent' | 'team' | 'router' | 'workflow-script';

export interface ReferenceEdge {
  from: { kind: ReferenceSourceKind; name: string };
  to: { kind: ReferenceTargetKind; name: string };
  /** Where the reference lives, e.g. `routes[2].target`, `bridgeConfig`, `teamRef`. */
  field: string;
}

export interface ReferenceIndexSessionState {
  /** Active composer agent (saved profile or selectable preset name). */
  activeAgent?: string | null;
  /** Active bridge config name. */
  activeConfig?: string | null;
  /** Active router profile name. */
  activeRouterName?: string | null;
  /** Attached team name. */
  activeTeamName?: string | null;
}

export interface ReferenceIndexInput {
  bridgeConfigs?: readonly PersistedBridgeConfig[];
  agentProfiles?: readonly AgentProfile[];
  routers?: readonly RouterProfile[];
  teams?: readonly TeamDefinition[];
  automationTasks?: readonly Pick<ScheduledAutomationTask, 'id' | 'name' | 'kind' | 'workflowName' | 'workflowSource'>[];
  teamPreferences?: TeamPreferences | null;
  /** Project Manager configs; `name` identifies the project (path or label). */
  managerConfigs?: readonly { name: string; bridgeConfig?: string }[];
  issues?: readonly { id: string; number?: number; title?: string; agentConfig?: string }[];
  assistantConfig?: { bridgeConfig?: string } | null;
  session?: ReferenceIndexSessionState | null;
}

/** Known-definition name sets used by {@link findBrokenRefs}. */
export interface ReferenceKnownSets {
  configs?: Iterable<string>;
  agents?: Iterable<string>;
  teams?: Iterable<string>;
  routers?: Iterable<string>;
  workflows?: Iterable<string>;
}

/** The index target of an `AgentTargetRef`; null for raw model refs (`config: ''`). */
function targetRefTarget(ref: AgentTargetRef): { kind: ReferenceTargetKind; name: string } | null {
  switch (ref.kind) {
    case 'agent':
      return { kind: 'agent', name: ref.name };
    case 'team':
      return { kind: 'team', name: ref.name };
    case 'model':
      // A raw legacy model ref (config: '') does not know its originating
      // config, so it produces no config edge.
      return ref.config ? { kind: 'config', name: ref.config } : null;
  }
}

function pushTargetRefEdge(
  edges: ReferenceEdge[],
  from: ReferenceEdge['from'],
  field: string,
  ref: AgentTargetRef | undefined,
): void {
  if (!ref) return;
  const to = targetRefTarget(ref);
  if (to) edges.push({ from, to, field });
}

function collectWorkflowNodeEdges(
  edges: ReferenceEdge[],
  from: ReferenceEdge['from'],
  node: WorkflowNode | undefined,
  pathPrefix: string,
): void {
  if (!node) return;
  if (node.type === 'agent') {
    pushTargetRefEdge(edges, from, `${pathPrefix}${node.id}.targetRef`, node.targetRef);
  }
  for (const child of node.children ?? []) {
    collectWorkflowNodeEdges(edges, from, child, pathPrefix);
  }
}

/** Build every reference edge across the supplied definitions and active state. */
export function buildReferenceIndex(input: ReferenceIndexInput): ReferenceEdge[] {
  const edges: ReferenceEdge[] = [];
  const agentNames = new Set((input.agentProfiles ?? []).map((profile) => profile.name));

  // config ← agent profile.bridgeConfig
  for (const profile of input.agentProfiles ?? []) {
    if (!profile.bridgeConfig) continue;
    edges.push({
      from: { kind: 'agent', name: profile.name },
      to: { kind: 'config', name: profile.bridgeConfig },
      field: 'bridgeConfig',
    });
  }

  // config ← project Manager (manager.json bridgeConfig)
  for (const manager of input.managerConfigs ?? []) {
    if (!manager.bridgeConfig) continue;
    edges.push({
      from: { kind: 'manager', name: manager.name },
      to: { kind: 'config', name: manager.bridgeConfig },
      field: 'bridgeConfig',
    });
  }

  const assistantConfig = input.assistantConfig?.bridgeConfig?.trim();
  if (assistantConfig) {
    edges.push({
      from: { kind: 'assistant', name: 'global' },
      to: { kind: 'config', name: assistantConfig },
      field: 'bridgeConfig',
    });
  }

  for (const issue of input.issues ?? []) {
    const agent = issue.agentConfig?.trim();
    if (!agent) continue;
    edges.push({
      from: { kind: 'issue', name: issue.id },
      to: { kind: 'agent', name: agent },
      field: 'agentConfig',
    });
  }

  // agent/team/config ← router route targets + fallback (post-migration)
  for (const router of input.routers ?? []) {
    const from = { kind: 'router' as const, name: router.name };
    router.routes.forEach((route, index) => {
      const migrated = migrateRouterRouteTarget(route, agentNames);
      pushTargetRefEdge(edges, from, `routes[${index}].target`, migrated.target);
    });
    const fallbackTarget = router.fallbackTarget
      ?? (router.fallback ? { kind: 'model' as const, config: '', model: router.fallback.model } : undefined);
    pushTargetRefEdge(edges, from, 'fallbackTarget', fallbackTarget);
  }

  // team ← graph teamRef nodes / typed targetRefs (graph nodes + workflow tree)
  for (const team of input.teams ?? []) {
    const from = { kind: 'team' as const, name: team.name };
    for (const node of team.nodes ?? []) {
      const nodeRef = node.id ?? node.name ?? node.role ?? '?';
      const ref = node.targetRef
        ?? (node.type === 'team' && node.teamRef
          ? { kind: 'team' as const, name: node.teamRef }
          : undefined);
      pushTargetRefEdge(edges, from, `nodes[${nodeRef}].${node.targetRef ? 'targetRef' : 'teamRef'}`, ref);
    }
    collectWorkflowNodeEdges(edges, from, team.workflowTree, 'workflowTree.');
  }

  // team ← automation tasks (Agent-page workflow squads referenced by name)
  for (const task of input.automationTasks ?? []) {
    if (task.kind !== 'workflow') continue;
    const name = task.workflowName?.trim();
    if (!name) continue;
    edges.push({
      from: { kind: 'automation', name: task.name || task.id },
      to: task.workflowSource === 'agent'
        ? { kind: 'team', name }
        : { kind: 'workflow-script', name },
      field: 'workflowName',
    });
  }

  // team ← teamPreferences.defaultAttached
  const defaultAttached = input.teamPreferences?.defaultAttached?.trim();
  if (defaultAttached) {
    edges.push({
      from: { kind: 'preference', name: 'team.defaultAttached' },
      to: { kind: 'team', name: defaultAttached },
      field: 'defaultAttached',
    });
  }

  // Active-state edges (composer/session activation) — distinct from.kind so
  // the UI can distinguish them from definition-level references.
  const session = input.session;
  if (session) {
    const from = { kind: 'session' as const, name: 'active' };
    if (session.activeAgent?.trim()) {
      edges.push({ from, to: { kind: 'agent', name: session.activeAgent.trim() }, field: 'activeAgent' });
    }
    if (session.activeConfig?.trim()) {
      edges.push({ from, to: { kind: 'config', name: session.activeConfig.trim() }, field: 'activeConfig' });
    }
    if (session.activeRouterName?.trim()) {
      edges.push({ from, to: { kind: 'router', name: session.activeRouterName.trim() }, field: 'activeRouterName' });
    }
    if (session.activeTeamName?.trim()) {
      edges.push({ from, to: { kind: 'team', name: session.activeTeamName.trim() }, field: 'activeTeamName' });
    }
  }

  return edges;
}

/** "Who uses this definition?" — all edges pointing at `kind`/`name`. */
export function findUsages(
  index: readonly ReferenceEdge[],
  kind: ReferenceTargetKind,
  name: string,
): ReferenceEdge[] {
  return index.filter((edge) => edge.to.kind === kind && edge.to.name === name);
}

/**
 * "Is what I reference still there?" — edges whose target name is absent from
 * the known set for that target kind. A target kind whose set is omitted from
 * `known` is not reported (unknown ≠ broken).
 */
export function findBrokenRefs(
  index: readonly ReferenceEdge[],
  known: ReferenceKnownSets,
): ReferenceEdge[] {
  const sets: Partial<Record<ReferenceTargetKind, Set<string>>> = {
    config: known.configs ? new Set(known.configs) : undefined,
    agent: known.agents ? new Set(known.agents) : undefined,
    team: known.teams ? new Set(known.teams) : undefined,
    router: known.routers ? new Set(known.routers) : undefined,
    'workflow-script': known.workflows ? new Set(known.workflows) : undefined,
  };
  return index.filter((edge) => {
    const set = sets[edge.to.kind];
    return set ? !set.has(edge.to.name) : false;
  });
}
