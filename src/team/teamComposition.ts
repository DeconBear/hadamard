import type { TeamDefinition, WorkflowNode } from '../types.js';
import { loadTeamDefinition } from './teamDefinitions.js';

export interface TeamCompositionValidationOptions {
  projectDir?: string;
  homeDir?: string;
  ancestorStack?: readonly string[];
  loadDefinition?: (name: string) => TeamDefinition | null;
}

function collectWorkflowTeamRefs(node: WorkflowNode | undefined, refs: Set<string>): void {
  if (!node) return;
  if (node.targetRef?.kind === 'team' && node.targetRef.name.trim()) {
    refs.add(node.targetRef.name.trim());
  }
  for (const child of node.children ?? []) collectWorkflowTeamRefs(child, refs);
}

/** Return every Agents-page Graph/Workflow referenced as an executor. */
export function collectNestedTeamRefs(definition: TeamDefinition): string[] {
  const refs = new Set<string>();
  for (const node of definition.nodes ?? []) {
    const name = node.targetRef?.kind === 'team'
      ? node.targetRef.name
      : node.type === 'team'
        ? node.teamRef
        : undefined;
    if (name?.trim()) refs.add(name.trim());
  }
  collectWorkflowTeamRefs(definition.workflowTree, refs);
  return [...refs];
}

/**
 * Validate nested Graph/Workflow references before any model call starts.
 * The complete reachable composition is checked so indirect cycles and broken
 * definitions fail deterministically instead of surfacing halfway through a run.
 */
export function validateTeamComposition(
  definition: TeamDefinition,
  options: TeamCompositionValidationOptions = {},
): string[] {
  const problems: string[] = [];
  const checked = new Set<string>();
  const load = options.loadDefinition ?? ((name: string) =>
    loadTeamDefinition(name, options.projectDir, options.homeDir)?.definition ?? null);

  const visit = (current: TeamDefinition, ancestors: readonly string[]): void => {
    const name = current.name.trim() || '(unnamed)';
    const cycleAt = ancestors.indexOf(name);
    if (cycleAt >= 0) {
      problems.push(`Team composition cycle: ${[...ancestors.slice(cycleAt), name].join(' -> ')}`);
      return;
    }

    const stack = [...ancestors, name];
    const key = `${name}\0${stack.slice(0, -1).join('\0')}`;
    if (checked.has(key)) return;
    checked.add(key);

    for (const ref of collectNestedTeamRefs(current)) {
      const nestedCycleAt = stack.indexOf(ref);
      if (nestedCycleAt >= 0) {
        problems.push(`Team composition cycle: ${[...stack.slice(nestedCycleAt), ref].join(' -> ')}`);
        continue;
      }
      const nested = load(ref);
      if (!nested) {
        problems.push(`Broken reference: team "${ref}" does not exist (from "${name}")`);
        continue;
      }
      visit(nested, stack);
    }
  };

  visit(definition, options.ancestorStack ?? []);
  return [...new Set(problems)];
}

export function assertValidTeamComposition(
  definition: TeamDefinition,
  options: TeamCompositionValidationOptions = {},
): void {
  const problems = validateTeamComposition(definition, options);
  if (problems.length > 0) {
    throw new Error(`Invalid team composition for "${definition.name}": ${problems.join('; ')}`);
  }
}
