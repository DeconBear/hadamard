import { describe, expect, it } from 'vitest';

import { createTeamTool } from '../src/team/modelTeam.js';
import { BUILT_IN_TEAM_DEFINITIONS, listTeamAgentLabels } from '../src/team/teamDefinitions.js';
import { isSingleAgentSquadType } from '../src/team/teamPropose.js';

describe('askTeamDefinition squad dispatch', () => {
  it('treats agent and subagent as single-agent squad types', () => {
    expect(isSingleAgentSquadType('agent')).toBe(true);
    expect(isSingleAgentSquadType('subagent')).toBe(true);
    expect(isSingleAgentSquadType('workflow')).toBe(false);
    expect(isSingleAgentSquadType('graph')).toBe(false);
  });

  it('built-in analysis/reviewer/quick-review keep non-graph squad types', () => {
    expect(BUILT_IN_TEAM_DEFINITIONS.analysis?.squadType).toBe('workflow');
    expect(BUILT_IN_TEAM_DEFINITIONS.reviewer?.squadType).toBe('agent');
    expect(BUILT_IN_TEAM_DEFINITIONS['quick-review']?.squadType).toBe('agent');
    expect(BUILT_IN_TEAM_DEFINITIONS['panel-analysis']?.squadType || 'graph').toBe('graph');
    expect(BUILT_IN_TEAM_DEFINITIONS['security-audit']?.squadType || 'graph').toBe('graph');
  });

  it('lists workflow and agent labels without graph nodes', () => {
    expect(listTeamAgentLabels(BUILT_IN_TEAM_DEFINITIONS.analysis!)).toEqual(['researcher', 'skeptic']);
    expect(listTeamAgentLabels(BUILT_IN_TEAM_DEFINITIONS.reviewer!)).toEqual(['reviewer']);
    expect(listTeamAgentLabels(BUILT_IN_TEAM_DEFINITIONS['quick-review']!)).toEqual(['quick-reviewer']);
  });

  it('createTeamTool accepts agent and workflow built-ins without graph migration', () => {
    const reviewer = createTeamTool(BUILT_IN_TEAM_DEFINITIONS.reviewer!);
    expect(reviewer.name).toBe('reviewer');
    expect(reviewer.inputJsonSchema).toMatchObject({
      required: ['task'],
    });

    const analysis = createTeamTool(BUILT_IN_TEAM_DEFINITIONS.analysis!);
    expect(analysis.name).toBe('analysis');
    expect(analysis.inputJsonSchema).toMatchObject({
      required: ['prompt'],
    });
  });
});
