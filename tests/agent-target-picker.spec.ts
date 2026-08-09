import { describe, expect, it } from 'vitest';

import {
  buildAgentTargetPickerOptions,
  pickerValueToTargetRef,
  targetRefToPickerValue,
  teamDefinitionReaches,
} from '../src/gui/agentTargetPicker.js';
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

describe('Agents executor picker contract', () => {
  it('uses config + model as identity when model ids are duplicated', () => {
    const options = buildAgentTargetPickerOptions({
      modelGroups: [
        { config: 'primary', models: ['shared-model'] },
        { config: 'fallback', models: ['shared-model'] },
      ],
      profiles: [],
    });

    expect(options.map(option => option.value)).toEqual([
      'model:primary:shared-model',
      'model:fallback:shared-model',
    ]);
    expect(options.map(option => pickerValueToTargetRef(option.value))).toEqual([
      { kind: 'model', config: 'primary', model: 'shared-model' },
      { kind: 'model', config: 'fallback', model: 'shared-model' },
    ]);
  });

  it('round-trips model, Agent, Graph, Workflow, and legacy model values', () => {
    const refs = [
      { kind: 'model' as const, config: 'cfg', model: 'provider:model-v2' },
      { kind: 'agent' as const, name: 'coder' },
      { kind: 'team' as const, name: 'nested-workflow' },
    ];
    for (const ref of refs) {
      expect(pickerValueToTargetRef(targetRefToPickerValue(ref))).toEqual(ref);
    }
    expect(pickerValueToTargetRef('legacy-model')).toEqual({
      kind: 'model',
      config: '',
      model: 'legacy-model',
    });
  });

  it('disables an indirect cyclic Graph/Workflow choice', () => {
    const a = workflow('A');
    const b = workflow('B', 'C');
    const c = workflow('C', 'A');
    const teams = [a, b, c].map(definition => ({
      name: definition.name,
      squadType: definition.squadType,
      definition,
    }));

    expect(teamDefinitionReaches(teams, 'B', 'A')).toBe(true);
    const options = buildAgentTargetPickerOptions({
      modelGroups: [],
      profiles: [],
      teams,
      excludeTeam: 'A',
    });
    expect(options.find(option => option.value === 'team:B')).toMatchObject({
      disabled: true,
      label: 'B (would create cycle)',
      group: 'Workflows',
    });
    expect(options.some(option => option.value === 'team:A')).toBe(false);
  });
});
