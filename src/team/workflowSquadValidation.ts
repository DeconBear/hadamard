import type { TeamDefinition, WorkflowNode } from '../types.js';

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
