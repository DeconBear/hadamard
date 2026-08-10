import type {
  TeamDefinition,
  TeamEvent,
  TeamGraphEdge,
  TeamGraphNode,
  TeamGraphReturnMode,
  TeamMember,
} from '../types.js';
import type { MemberIdentity } from './teamMemberIdentity.js';

/** The ref a node is addressed by in edges/entryNodeIds: id → name → role → model. */
export function graphNodeRef(node: TeamMember | TeamGraphNode): string {
  const graphNode = node as TeamGraphNode;
  if (graphNode.kind === 'task') return (graphNode.id ?? 'task').trim() || 'task';
  if (graphNode.kind === 'return') return (graphNode.id ?? 'return').trim() || 'return';
  return (node.id ?? node.name ?? node.role ?? node.model ?? '').trim();
}

export function isUndirectedTeamGraphEdge(edge: TeamGraphEdge): boolean {
  return edge.direction === 'undirected';
}

export function formatTeamGraphEdgeLabel(
  edge: Pick<TeamGraphEdge, 'from' | 'to' | 'direction'>,
): string {
  const separator = isUndirectedTeamGraphEdge(edge) ? ' ↔ ' : ' → ';
  return `${edge.from}${separator}${edge.to}`;
}

export function expandTeamGraphEdges(edges: TeamGraphEdge[]): TeamGraphEdge[] {
  const expanded: TeamGraphEdge[] = [];
  for (const edge of edges) {
    expanded.push(edge);
    if (!isUndirectedTeamGraphEdge(edge) || edge.loop) continue;
    expanded.push({ ...edge, from: edge.to, to: edge.from, direction: 'directed' });
  }
  return expanded;
}

/** Pure legacy definition → graph v2 migration. */
export function migrateTeamDefinitionToV2(definition: TeamDefinition): TeamDefinition {
  if (definition.orchestration === 'graph' || definition.mode === 'graph') return definition;
  const nodes: TeamGraphNode[] = [];
  const edges: TeamGraphEdge[] = [];
  const isReviewer = definition.mode === 'reviewer' || definition.mode === 'executor-reviewer';
  if (isReviewer) {
    if (definition.reviewer) nodes.push({ ...definition.reviewer, entry: true });
  } else {
    for (const member of definition.members ?? []) nodes.push({ ...member, entry: true });
    if (definition.primary) {
      const primaryNode: TeamGraphNode = { ...definition.primary };
      nodes.push(primaryNode);
      const primaryRef = graphNodeRef(primaryNode) || 'primary';
      for (const member of definition.members ?? []) {
        const from = graphNodeRef(member);
        if (from) edges.push({ from, to: primaryRef, channel: 'message', trigger: 'on_complete' });
      }
    }
  }
  for (const reviewEdge of definition.reviewEdges ?? []) {
    if (!reviewEdge?.from || !reviewEdge?.to) continue;
    edges.push({
      from: reviewEdge.from,
      to: reviewEdge.to,
      channel: 'review',
      trigger: 'on_complete',
      note: reviewEdge.note,
    });
  }
  const migrated: TeamDefinition = {
    ...definition,
    mode: 'graph',
    version: 2,
    orchestration: 'graph',
    nodes,
    edges,
  };
  delete migrated.reviewEdges;
  return migrated;
}

export interface GraphNodeRunResult {
  report: string;
  ok: boolean;
  error?: string;
}

export interface GraphNotifyResult {
  ok: boolean;
  delivered: string[];
  error?: string;
}

export interface GraphNodeRunContext {
  commTargets: string[];
  notify: (to: string, message: string) => GraphNotifyResult;
}

export interface OrchestrateGraphOptions {
  prompt: string;
  definition: TeamDefinition;
  runNode: (
    node: TeamGraphNode,
    identity: MemberIdentity,
    task: string,
    ctx: GraphNodeRunContext,
  ) => Promise<GraphNodeRunResult>;
  onEvent?: (event: TeamEvent) => void;
}

export interface OrchestrateGraphResult {
  answer: string;
  skipped: string[];
  reports: Array<{ id: string; report: string; ok: boolean }>;
  returnValue?: string | null;
  returnMode?: TeamGraphReturnMode;
  returnNodeId?: string;
  rounds?: number;
  incompleteReason?: string;
  lastFromOutput?: string;
}

export function edgeConditionPasses(condition: string | undefined, output: string): boolean {
  if (!condition) return true;
  const trimmed = condition.trim();
  const regexMatch = trimmed.match(/^\/(.*)\/([a-z]*)$/);
  if (regexMatch) {
    try {
      return new RegExp(regexMatch[1]!, regexMatch[2]).test(output);
    } catch {
      return false;
    }
  }
  return output.includes(trimmed);
}
