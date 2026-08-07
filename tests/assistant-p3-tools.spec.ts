import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAssistantGlobalTools } from '../src/manager/assistantGlobalTools.js';
import { AssistantProposalStore } from '../src/manager/assistantProposals.js';
import { TeamProposalStore } from '../src/team/teamProposalService.js';
import { loadTeamDefinition, saveTeamDefinition } from '../src/team/teamDefinitions.js';
import { addBridgeConfig, findBridgeConfig } from '../src/parity/bridgeConfigs.js';
import { listAgentProfiles, upsertAgentProfile, writeAgentProfiles } from '../src/config/agentProfiles.js';
import { loadRouterProfile, saveRouterProfile } from '../src/router/modelRouter.js';
import { saveWorkflow } from '../src/workflow/workflowPersistence.js';
import { upsertScheduledAutomationTask } from '../src/scheduling/taskPersistence.js';
import type { AgentToolDefinition, TeamDefinition } from '../src/types.js';

let workDir: string;
let homeDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-work-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-home-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

async function callTool(tool: AgentToolDefinition, input: unknown = {}) {
  return (tool.execute as (i: unknown, c: unknown) => Promise<unknown>)(input, {});
}

function byName(tools: AgentToolDefinition[], name: string): AgentToolDefinition {
  const found = tools.find(tool => tool.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

function graph(name: string): TeamDefinition {
  return {
    name,
    mode: 'graph',
    version: 3,
    orchestration: 'graph',
    members: [],
    nodes: [
      { kind: 'task', id: 'task' },
      { kind: 'agent', id: 'worker', model: 'model-a' },
      { kind: 'return', id: 'return', returnMode: 'payload' },
    ],
    edges: [
      { from: 'task', to: 'worker' },
      { from: 'worker', to: 'return' },
    ],
  };
}

/** Graph whose middle node invokes another team via a typed targetRef. */
function graphWithTeamRef(name: string, teamRef: string): TeamDefinition {
  return {
    name,
    mode: 'graph',
    version: 3,
    orchestration: 'graph',
    members: [],
    nodes: [
      { kind: 'task', id: 'task' },
      { kind: 'agent', id: 'worker', model: 'model-a' },
      { kind: 'agent', id: 'nested', model: 'model-b', targetRef: { kind: 'team', name: teamRef } },
      { kind: 'return', id: 'return', returnMode: 'payload' },
    ],
    edges: [
      { from: 'task', to: 'worker' },
      { from: 'worker', to: 'nested' },
      { from: 'nested', to: 'return' },
    ],
  };
}

function seedConfig(name: string): void {
  addBridgeConfig({ name, runtime: 'hadamard', provider: 'anthropic', model: 'm1' }, homeDir);
}

const WORKFLOW_SCRIPT = [
  'export const meta = { name: "wf", description: "demo", phases: [] };',
  'export async function run() { return "ok"; }',
  '',
].join('\n');

describe('P3 tool surface', () => {
  it('exposes the new tools', async () => {
    const tools = await createAssistantGlobalTools({ homeDir, currentWorkDir: workDir });
    const names = tools.map(tool => tool.name);
    for (const expected of [
      'ListReferences',
      'ListBrokenReferences',
      'RenameBridgeConfig',
      'RenameAgentProfile',
      'RenameRouterProfile',
      'RenameTeam',
      'DeleteBridgeConfig',
      'DeleteTeam',
      'UpsertTeam',
      'UpsertWorkflow',
      'DeleteWorkflow',
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe('rename tools', () => {
  it('RenameBridgeConfig runs the transaction and rewrites profile references', async () => {
    addBridgeConfig({ name: 'cfg-a', runtime: 'hadamard', provider: 'anthropic', model: 'm1' }, homeDir);
    upsertAgentProfile({ name: 'agent-a', bridgeConfig: 'cfg-a', model: 'm1' }, homeDir);
    const tools = await createAssistantGlobalTools({ homeDir, currentWorkDir: workDir });

    const result = await callTool(byName(tools, 'RenameBridgeConfig'), {
      oldName: 'cfg-a',
      newName: 'cfg-b',
    }) as { ok: boolean; rewritten: string[] };

    expect(result.ok).toBe(true);
    expect(result.rewritten.length).toBeGreaterThan(0);
    expect(findBridgeConfig('cfg-a', homeDir)).toBeUndefined();
    expect(findBridgeConfig('cfg-b', homeDir)).toBeDefined();
    expect(listAgentProfiles(homeDir).find(profile => profile.name === 'agent-a')?.bridgeConfig)
      .toBe('cfg-b');
  });

  it('RenameAgentProfile rewrites router targets', async () => {
    seedConfig('cfg-x');
    upsertAgentProfile({ name: 'agent-old', bridgeConfig: 'cfg-x', model: 'm1' }, homeDir);
    await saveRouterProfile({
      name: 'r1',
      routerModel: { model: 'leader' },
      routes: [{ model: 'm1', when: 'always', target: { kind: 'agent', name: 'agent-old' } }],
    }, { projectDir: workDir, homeDir, overwrite: true });
    const tools = await createAssistantGlobalTools({ homeDir, currentWorkDir: workDir });

    await callTool(byName(tools, 'RenameAgentProfile'), { oldName: 'agent-old', newName: 'agent-new' });

    expect(listAgentProfiles(homeDir).some(profile => profile.name === 'agent-new')).toBe(true);
    const router = loadRouterProfile('r1', workDir, homeDir);
    expect(router?.profile.routes[0]?.target).toEqual({ kind: 'agent', name: 'agent-new' });
  });

  it('RenameTeam renames the definition file and refuses built-ins', async () => {
    await saveTeamDefinition(graph('custom-team'), { projectDir: workDir, homeDir });
    const tools = await createAssistantGlobalTools({ homeDir, currentWorkDir: workDir });

    await callTool(byName(tools, 'RenameTeam'), { oldName: 'custom-team', newName: 'renamed-team' });

    expect(loadTeamDefinition('custom-team', workDir, homeDir)).toBeNull();
    expect(loadTeamDefinition('renamed-team', workDir, homeDir)?.definition.name).toBe('renamed-team');
    await expect(
      callTool(byName(tools, 'RenameTeam'), { oldName: 'reviewer', newName: 'whatever' }),
    ).rejects.toThrow(/built-in/i);
  });
});

describe('reference tools', () => {
  it('ListReferences returns usage edges for a config', async () => {
    addBridgeConfig({ name: 'cfg-r', runtime: 'hadamard', provider: 'anthropic', model: 'm1' }, homeDir);
    upsertAgentProfile({ name: 'agent-r', bridgeConfig: 'cfg-r', model: 'm1' }, homeDir);
    const tools = await createAssistantGlobalTools({ homeDir, currentWorkDir: workDir });

    const result = await callTool(byName(tools, 'ListReferences'), {
      kind: 'config',
      name: 'cfg-r',
    }) as { count: number; references: Array<{ from: { kind: string; name: string }; to: { kind: string; name: string }; field: string }> };

    expect(result.count).toBe(1);
    expect(result.references[0]).toEqual({
      from: { kind: 'agent', name: 'agent-r' },
      to: { kind: 'config', name: 'cfg-r' },
      field: 'bridgeConfig',
    });
  });

  it('ListBrokenReferences reports edges to missing targets', async () => {
    // Write the profile store directly: upsertAgentProfile validates that the
    // referenced config exists, but a broken edge is exactly what we need here.
    writeAgentProfiles({
      version: 1,
      profiles: [{ name: 'agent-ghost', bridgeConfig: 'ghost-config', model: 'm1' }],
    }, homeDir);
    const tools = await createAssistantGlobalTools({ homeDir, currentWorkDir: workDir });

    const result = await callTool(byName(tools, 'ListBrokenReferences')) as {
      count: number;
      broken: Array<{ to: { kind: string; name: string } }>;
    };

    expect(result.count).toBeGreaterThan(0);
    expect(result.broken.some(edge => edge.to.kind === 'config' && edge.to.name === 'ghost-config'))
      .toBe(true);
  });
});

describe('delete tools with confirmation', () => {
  it('DeleteAgentProfile deletes immediately when unreferenced', async () => {
    seedConfig('cfg-x');
    upsertAgentProfile({ name: 'agent-solo', bridgeConfig: 'cfg-x', model: 'm1' }, homeDir);
    const tools = await createAssistantGlobalTools({ homeDir, currentWorkDir: workDir });

    const result = await callTool(byName(tools, 'DeleteAgentProfile'), { name: 'agent-solo' }) as {
      deleted: boolean;
    };

    expect(result.deleted).toBe(true);
    expect(listAgentProfiles(homeDir).some(profile => profile.name === 'agent-solo')).toBe(false);
  });

  it('DeleteAgentProfile with references stages a proposal and does not delete; Apply executes', async () => {
    seedConfig('cfg-x');
    upsertAgentProfile({ name: 'agent-ref', bridgeConfig: 'cfg-x', model: 'm-ref' }, homeDir);
    await saveRouterProfile({
      name: 'r-ref',
      routerModel: { model: 'leader' },
      routes: [{ model: 'm1', when: 'always', target: { kind: 'agent', name: 'agent-ref' } }],
    }, { projectDir: workDir, homeDir, overwrite: true });
    const proposals = new AssistantProposalStore();
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
      proposals,
      assistantSessionId: 'asst-1',
    });

    const staged = await callTool(byName(tools, 'DeleteAgentProfile'), { name: 'agent-ref' }) as {
      deleted: boolean;
      staged: boolean;
      proposalId: string;
      references: unknown[];
      strategies: Array<{ type: string }>;
    };

    expect(staged.deleted).toBe(false);
    expect(staged.staged).toBe(true);
    expect(staged.references.length).toBeGreaterThan(0);
    expect(staged.strategies.map(option => option.type)).toContain('degrade-model');
    // Not deleted while the proposal is pending.
    expect(listAgentProfiles(homeDir).some(profile => profile.name === 'agent-ref')).toBe(true);

    const applied = await proposals.apply(
      staged.proposalId,
      { homeDir, projectDir: workDir },
      { strategy: { type: 'degrade-model' } },
    );
    expect(applied.proposal.status).toBe('applied');
    expect(applied.rewritten.length).toBeGreaterThan(0);
    expect(listAgentProfiles(homeDir).some(profile => profile.name === 'agent-ref')).toBe(false);
    // Router reference degraded to a raw model ref keeping the model name.
    const router = loadRouterProfile('r-ref', workDir, homeDir);
    expect(router?.profile.routes[0]?.target).toEqual({ kind: 'model', config: '', model: 'm-ref' });
  });

  it('DeleteBridgeConfig with references stages; Apply with repoint rewrites profiles', async () => {
    addBridgeConfig({ name: 'cfg-del', runtime: 'hadamard', provider: 'anthropic', model: 'm1' }, homeDir);
    addBridgeConfig({ name: 'cfg-keep', runtime: 'hadamard', provider: 'anthropic', model: 'm2' }, homeDir);
    upsertAgentProfile({ name: 'agent-cfg', bridgeConfig: 'cfg-del', model: 'm1' }, homeDir);
    const proposals = new AssistantProposalStore();
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
      proposals,
      assistantSessionId: 'asst-1',
    });

    const staged = await callTool(byName(tools, 'DeleteBridgeConfig'), { name: 'cfg-del' }) as {
      staged: boolean;
      proposalId: string;
    };
    expect(staged.staged).toBe(true);
    expect(findBridgeConfig('cfg-del', homeDir)).toBeDefined();

    await proposals.apply(
      staged.proposalId,
      { homeDir, projectDir: workDir },
      { strategy: { type: 'repoint', target: 'cfg-keep' } },
    );
    expect(findBridgeConfig('cfg-del', homeDir)).toBeUndefined();
    expect(listAgentProfiles(homeDir).find(profile => profile.name === 'agent-cfg')?.bridgeConfig)
      .toBe('cfg-keep');
  });

  it('DeleteBridgeConfig throws for unknown configs', async () => {
    const tools = await createAssistantGlobalTools({ homeDir, currentWorkDir: workDir });
    await expect(
      callTool(byName(tools, 'DeleteBridgeConfig'), { name: 'missing' }),
    ).rejects.toThrow(/not found/i);
  });

  it('DeleteTeam refuses built-ins, deletes unreferenced teams, stages referenced ones', async () => {
    const proposals = new AssistantProposalStore();
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
      proposals,
      assistantSessionId: 'asst-1',
    });

    await expect(
      callTool(byName(tools, 'DeleteTeam'), { name: 'reviewer' }),
    ).rejects.toThrow(/built-in/i);

    await saveTeamDefinition(graph('solo-team'), { projectDir: workDir, homeDir });
    const direct = await callTool(byName(tools, 'DeleteTeam'), { name: 'solo-team' }) as {
      deleted: boolean;
    };
    expect(direct.deleted).toBe(true);
    expect(loadTeamDefinition('solo-team', workDir, homeDir)).toBeNull();

    // Referenced team: another team's graph node points at it.
    await saveTeamDefinition(graph('inner-team'), { projectDir: workDir, homeDir });
    await saveTeamDefinition(graphWithTeamRef('outer-team', 'inner-team'), { projectDir: workDir, homeDir });
    const staged = await callTool(byName(tools, 'DeleteTeam'), { name: 'inner-team' }) as {
      staged: boolean;
      proposalId: string;
      strategies: Array<{ type: string }>;
    };
    expect(staged.staged).toBe(true);
    expect(staged.strategies.map(option => option.type)).toContain('remove-nodes');
    expect(loadTeamDefinition('inner-team', workDir, homeDir)).not.toBeNull();

    await proposals.apply(
      staged.proposalId,
      { homeDir, projectDir: workDir },
      { strategy: { type: 'remove-nodes' } },
    );
    expect(loadTeamDefinition('inner-team', workDir, homeDir)).toBeNull();
    // The referencing node (and its edges) was removed from the outer team.
    const outerRaw = JSON.parse(fs.readFileSync(
      path.join(workDir, '.hadamard', 'teams', 'outer-team.json'),
      'utf8',
    )) as TeamDefinition;
    expect(outerRaw.nodes?.some(node => node.id === 'nested')).toBe(false);
    expect(outerRaw.edges?.some(edge => edge.from === 'nested' || edge.to === 'nested')).toBe(false);
  });

  it('staged deletes throw without a proposal store instead of deleting', async () => {
    seedConfig('cfg-x');
    upsertAgentProfile({ name: 'agent-nochan', bridgeConfig: 'cfg-x', model: 'm1' }, homeDir);
    await saveRouterProfile({
      name: 'r-nochan',
      routerModel: { model: 'leader' },
      routes: [{ model: 'm1', when: 'always', target: { kind: 'agent', name: 'agent-nochan' } }],
    }, { projectDir: workDir, homeDir, overwrite: true });
    const tools = await createAssistantGlobalTools({ homeDir, currentWorkDir: workDir });

    await expect(
      callTool(byName(tools, 'DeleteAgentProfile'), { name: 'agent-nochan' }),
    ).rejects.toThrow(/Refusing to delete/);
    expect(listAgentProfiles(homeDir).some(profile => profile.name === 'agent-nochan')).toBe(true);
  });
});

describe('ActivateAgent target kinds', () => {
  it('routes profile/router/team activation to the right host callbacks', async () => {
    const calls: Array<[string, string]> = [];
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
      activateAgent: async (name) => {
        calls.push(['profile', name]);
        return { ok: true };
      },
      activateTarget: async (kind, name) => {
        calls.push([kind, name]);
        return { ok: true };
      },
    });

    await callTool(byName(tools, 'ActivateAgent'), { name: 'agent-1' });
    await callTool(byName(tools, 'ActivateAgent'), { name: 'router-1', kind: 'router' });
    await callTool(byName(tools, 'ActivateAgent'), { name: 'team-1', kind: 'team' });

    expect(calls).toEqual([
      ['profile', 'agent-1'],
      ['router', 'router-1'],
      ['team', 'team-1'],
    ]);
  });

  it('throws for router/team activation without host support', async () => {
    const tools = await createAssistantGlobalTools({ homeDir, currentWorkDir: workDir });
    await expect(
      callTool(byName(tools, 'ActivateAgent'), { name: 'r', kind: 'router' }),
    ).rejects.toThrow(/unavailable/i);
  });
});

describe('UpsertTeam', () => {
  it('stages a Team proposal and writes only after Apply', async () => {
    const teamProposals = new TeamProposalStore();
    const seen: string[] = [];
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
      teamProposals,
      assistantSessionId: 'asst-1',
      onTeamProposal: proposal => seen.push(proposal.id),
    });

    const staged = await callTool(byName(tools, 'UpsertTeam'), {
      definition: graph('assistant-team') as unknown as Record<string, unknown>,
      explanation: 'new team',
    }) as { proposalId: string; teamName: string; problems: string[] };

    expect(staged.teamName).toBe('assistant-team');
    expect(staged.problems).toEqual([]);
    expect(seen).toEqual([staged.proposalId]);
    expect(loadTeamDefinition('assistant-team', workDir, homeDir)).toBeNull();

    const applied = await teamProposals.apply(staged.proposalId, homeDir);
    expect(fs.existsSync(applied.filePath)).toBe(true);
    expect(loadTeamDefinition('assistant-team', workDir, homeDir)?.definition.name)
      .toBe('assistant-team');
  });
});

describe('workflow tools', () => {
  it('UpsertWorkflow stages a proposal; Apply writes the script', async () => {
    const proposals = new AssistantProposalStore();
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
      proposals,
      assistantSessionId: 'asst-1',
    });

    const staged = await callTool(byName(tools, 'UpsertWorkflow'), {
      name: 'wf-a',
      script: WORKFLOW_SCRIPT,
      scope: 'personal',
    }) as { staged: boolean; proposalId: string; problems: string[] };

    expect(staged.staged).toBe(true);
    expect(staged.problems).toEqual([]);
    const target = path.join(homeDir, '.hadamard', 'workflows', 'wf-a.js');
    expect(fs.existsSync(target)).toBe(false);

    const applied = await proposals.apply(staged.proposalId, { homeDir, projectDir: workDir });
    expect(applied.filePath).toBe(target);
    expect(fs.readFileSync(target, 'utf8')).toBe(WORKFLOW_SCRIPT);
  });

  it('UpsertWorkflow flags banned script constructs and Apply refuses them', async () => {
    const proposals = new AssistantProposalStore();
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
      proposals,
      assistantSessionId: 'asst-1',
    });

    const staged = await callTool(byName(tools, 'UpsertWorkflow'), {
      name: 'wf-bad',
      script: 'export const meta = { name: "x", description: "y" };\nconst t = Date.now();\n',
    }) as { proposalId: string; problems: string[] };

    expect(staged.problems.some(problem => problem.includes('Date.now'))).toBe(true);
    await expect(
      proposals.apply(staged.proposalId, { homeDir, projectDir: workDir }),
    ).rejects.toThrow(/invalid/i);
  });

  it('DeleteWorkflow deletes unreferenced workflows and refuses referenced ones', async () => {
    const tools = await createAssistantGlobalTools({ homeDir, currentWorkDir: workDir });
    await saveWorkflow('wf-solo', WORKFLOW_SCRIPT, { projectDir: workDir, homeDir });

    const direct = await callTool(byName(tools, 'DeleteWorkflow'), { name: 'wf-solo' }) as {
      deleted: boolean;
    };
    expect(direct.deleted).toBe(true);

    await saveWorkflow('wf-ref', WORKFLOW_SCRIPT, { projectDir: workDir, homeDir });
    await upsertScheduledAutomationTask(workDir, {
      name: 'nightly',
      kind: 'workflow',
      workflowName: 'wf-ref',
      workflowSource: 'script',
      cron: '0 0 * * *',
    });
    await expect(
      callTool(byName(tools, 'DeleteWorkflow'), { name: 'wf-ref' }),
    ).rejects.toThrow(/referenced by automation/i);
    expect(fs.existsSync(path.join(workDir, '.hadamard', 'workflows', 'wf-ref.js'))).toBe(true);
  });
});
