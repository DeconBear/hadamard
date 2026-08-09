import { describe, expect, it } from 'vitest';

import {
  collectNestedTeamRefs,
  validateTeamComposition,
} from '../src/team/teamComposition.js';
import type { TeamDefinition } from '../src/types.js';

function workflow(name: string, target?: string): TeamDefinition {
  return {
    name,
    mode: 'graph',
    version: 3,
    orchestration: 'graph',
    squadType: 'workflow',
    members: [],
    nodes: [],
    edges: [],
    workflowTree: {
      id: `${name}-root`,
      type: 'agent',
      ...(target ? { targetRef: { kind: 'team' as const, name: target } } : {}),
      children: [],
    },
  };
}

describe('Graph/Workflow composition validation', () => {
  it('collects graph and workflow nested targets', () => {
    const definition = workflow('root', 'child-workflow');
    definition.nodes = [
      { id: 'graph-child', type: 'team', teamRef: 'child-graph' },
      { id: 'typed-child', targetRef: { kind: 'team', name: 'typed-graph' } },
    ];
    expect(collectNestedTeamRefs(definition).sort()).toEqual([
      'child-graph',
      'child-workflow',
      'typed-graph',
    ]);
  });

  it('reports broken references before execution', () => {
    expect(validateTeamComposition(workflow('A', 'missing'), {
      loadDefinition: () => null,
    })).toEqual([
      'Broken reference: team "missing" does not exist (from "A")',
    ]);
  });

  it('reports the complete direct and indirect cycle path', () => {
    const a = workflow('A', 'B');
    const b = workflow('B', 'C');
    const c = workflow('C', 'A');
    const definitions = new Map([a, b, c].map(definition => [definition.name, definition]));

    expect(validateTeamComposition(a, {
      loadDefinition: name => definitions.get(name) ?? null,
    })).toContain('Team composition cycle: A -> B -> C -> A');
    expect(validateTeamComposition(workflow('Self', 'Self'), {
      loadDefinition: name => name === 'Self' ? workflow('Self', 'Self') : null,
    })).toContain('Team composition cycle: Self -> Self');
  });
});
