import { describe, expect, it } from 'vitest';

import {
  executeWorkflowTree,
  runWorkflowSquad,
  validateWorkflowSquad,
} from '../src/team/workflowSquad.js';
import type { TeamDefinition, WorkflowNode } from '../src/types.js';

function agent(id: string, children: WorkflowNode[] = []): WorkflowNode {
  return { id, type: 'agent', label: id, prompt: id, children };
}

describe('Agent workflow squads', () => {
  it('passes each Agent result into its single continuation', async () => {
    const root = agent('first', [agent('second')]);
    const calls: string[] = [];

    const result = await executeWorkflowTree(root, 'input', async (node, input) => {
      calls.push(`${node.id}:${input}`);
      return `${node.id}(${input})`;
    });

    expect(calls).toEqual(['first:input', 'second:first(input)']);
    expect(result).toBe('second(first(input))');
  });

  it('routes a Branch from upstream output and supports nested Parallel continuations', async () => {
    const root: WorkflowNode = {
      id: 'route',
      type: 'branch',
      label: 'Route',
      condition: 'ship',
      children: [
        {
          id: 'parallel',
          type: 'parallel',
          label: 'Parallel checks',
          children: [agent('test', [agent('summarize-test')]), agent('review')],
        },
        agent('revise'),
      ],
    };

    const result = await executeWorkflowTree(root, 'ready to SHIP', async (node, input) =>
      `${node.id}<${input}>`);

    expect(result).toBe([
      'summarize-test<test<ready to SHIP>>',
      'review<ready to SHIP>',
    ].join('\n\n'));
  });

  it('rejects malformed trees before save or execution', () => {
    const definition: TeamDefinition = {
      name: 'broken',
      mode: 'graph',
      version: 3,
      orchestration: 'graph',
      squadType: 'workflow',
      members: [],
      nodes: [],
      edges: [],
      workflowTree: {
        id: 'root',
        type: 'agent',
        children: [
          { id: 'duplicate', type: 'agent', children: [] },
          {
            id: 'duplicate',
            type: 'branch',
            children: [{ id: 'only-path', type: 'agent', children: [] }],
          },
        ],
      },
    };

    expect(validateWorkflowSquad(definition)).toEqual(expect.arrayContaining([
      expect.stringContaining('Agent node "root" may have at most one continuation'),
      expect.stringContaining('Duplicate workflow node id "duplicate"'),
      expect.stringContaining('Branch node "duplicate" requires a condition'),
      expect.stringContaining('Branch node "duplicate" requires exactly two children'),
    ]));
  });

  it('executes a referenced Graph or Workflow as an executor node', async () => {
    const definition: TeamDefinition = {
      name: 'parent-workflow',
      mode: 'graph',
      version: 3,
      orchestration: 'graph',
      squadType: 'workflow',
      members: [],
      nodes: [],
      edges: [],
      workflowTree: {
        id: 'nested',
        type: 'agent',
        prompt: 'nested: {{input}}',
        targetRef: { kind: 'team', name: 'child-graph' },
        children: [],
      },
    };
    const child: TeamDefinition = {
      name: 'child-graph',
      mode: 'graph',
      version: 3,
      orchestration: 'graph',
      members: [],
      nodes: [],
      edges: [],
    };
    const calls: string[] = [];

    const result = await runWorkflowSquad(
      definition,
      'input',
      new AbortController().signal,
      process.cwd(),
      undefined,
      { teamStack: ['parent-workflow'] },
      {
        loadTeam: name => name === child.name ? child : null,
        askTeam: async (nested, prompt) => {
          calls.push(`${nested.name}:${prompt}`);
          return {
            answer: 'nested answer',
            mode: 'graph',
            cost: { totalInputTokens: 2, totalOutputTokens: 3, estimatedCost: null, breakdown: [] },
            durationMs: 1,
            memberStatuses: [],
            reports: [],
            skippedNodes: [],
          };
        },
      },
    );

    expect(calls).toEqual(['child-graph:nested: input']);
    expect(result.answer).toBe('nested answer');
    expect(result.mode).toBe('workflow');
    expect(result.cost.totalInputTokens).toBe(2);
    expect(result.cost.totalOutputTokens).toBe(3);
  });
});
