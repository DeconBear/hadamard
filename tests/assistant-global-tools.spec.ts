import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createAssistantGlobalTools,
  buildAssistantGlobalSystemPrompt,
  readAssistantConfig,
  writeAssistantConfig,
  listAssistantProjectBriefs,
  isAssistantScope,
} from '../src/manager/assistantGlobalTools.js';
import { rememberWorkspace } from '../src/gui/workspaceRegistry.js';
import { writeWorkspaceNote } from '../src/gui/workspaceNote.js';
import { writeProjectMeta } from '../src/gui/projectMeta.js';
import { addBridgeConfig } from '../src/parity/bridgeConfigs.js';
import type { AgentToolDefinition } from '../src/types.js';
import { TeamProposalStore } from '../src/team/teamProposalService.js';

let workDir: string;
let homeDir: string;
let otherProject: string;

beforeEach(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-work-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-home-'));
  otherProject = fs.mkdtempSync(path.join(os.tmpdir(), 'asst-other-'));
  await rememberWorkspace(otherProject, homeDir);
  await writeWorkspaceNote(otherProject, homeDir, 'Other project brief');
  await writeProjectMeta(otherProject, homeDir, { status: 'in_progress' });
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(otherProject, { recursive: true, force: true });
});

async function callTool(tool: AgentToolDefinition, input: unknown = {}) {
  return (tool.execute as (i: unknown, c: unknown) => Promise<unknown>)(input, {});
}

describe('assistant global helpers', () => {
  it('recognizes AssistantScope values', () => {
    expect(isAssistantScope('global')).toBe(true);
    expect(isAssistantScope('project')).toBe(true);
    expect(isAssistantScope('other')).toBe(false);
  });

  it('persists assistant.json model/bridgeConfig', async () => {
    await writeAssistantConfig({
      model: 'gpt-test',
      bridgeConfig: 'demo',
      activeSessionId: 'global-session-2',
    }, homeDir);
    await expect(readAssistantConfig(homeDir)).resolves.toEqual({
      model: 'gpt-test',
      bridgeConfig: 'demo',
      activeSessionId: 'global-session-2',
    });
  });

  it('lists project briefs with notes and status', async () => {
    const briefs = await listAssistantProjectBriefs(homeDir, workDir);
    expect(briefs.some(item => path.resolve(item.path) === path.resolve(otherProject))).toBe(true);
    const other = briefs.find(item => path.resolve(item.path) === path.resolve(otherProject))!;
    expect(other.note).toContain('Other project brief');
    expect(other.status).toBe('in_progress');
  });
});

describe('createAssistantGlobalTools', () => {
  it('exposes overview + settings tools and never Write/Edit/Bash', async () => {
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
    });
    const names = tools.map(tool => tool.name);
    expect(names).toContain('ListProjects');
    expect(names).toContain('GetProjectOverview');
    expect(names).toContain('UpdateGuiPreferences');
    expect(names).toContain('UpdateRuntimeEnv');
    expect(names).toContain('UpsertBridgeConfig');
    expect(names).toContain('ListRouterProfiles');
    expect(names).toContain('UpsertRouterProfile');
    expect(names).toContain('DeleteRouterProfile');
    expect(names).toContain('OpenProject');
    expect(names).toContain('GetCurrentEditorContext');
    expect(names).toContain('SearchProductCapabilities');
    expect(names).toContain('ReadProductCapability');
    for (const forbidden of ['Bash', 'Write', 'Edit', 'Task', 'TeamAsk']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('ListProjects and GetProjectOverview return registered workspaces', async () => {
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
    });
    const list = await callTool(tools.find(tool => tool.name === 'ListProjects')!);
    expect(JSON.stringify(list)).toContain(JSON.stringify(otherProject).slice(1, -1));
    const overview = await callTool(tools.find(tool => tool.name === 'GetProjectOverview')!, {
      projectPath: otherProject,
    });
    expect(JSON.stringify(overview)).toContain('Other project brief');
    expect(JSON.stringify(overview)).toContain('in_progress');
  });

  it('rejects unknown projectPath', async () => {
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
    });
    const unknown = path.join(os.tmpdir(), `asst-unknown-${Date.now()}`);
    fs.mkdirSync(unknown);
    try {
      await expect(
        callTool(tools.find(tool => tool.name === 'GetProjectOverview')!, {
          projectPath: unknown,
        }),
      ).rejects.toThrow(/Unknown project path/i);
    } finally {
      fs.rmSync(unknown, { recursive: true, force: true });
    }
  });

  it('redacts bridge API keys in list/upsert results', async () => {
    addBridgeConfig({
      name: 'secret-bridge',
      runtime: 'hadamard',
      provider: 'anthropic',
      apiKey: 'sk-secret-should-not-leak',
      model: 'claude-test',
    }, homeDir);
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
    });
    const listed = await callTool(tools.find(tool => tool.name === 'ListBridgeConfigs')!);
    const listedText = JSON.stringify(listed);
    expect(listedText).toContain('secret-bridge');
    expect(listedText).toContain('"hasApiKey":true');
    expect(listedText).not.toContain('sk-secret-should-not-leak');

    const upserted = await callTool(tools.find(tool => tool.name === 'UpsertBridgeConfig')!, {
      name: 'secret-bridge-2',
      runtime: 'hadamard',
      provider: 'anthropic',
      apiKey: 'sk-another-secret',
      model: 'claude-test',
    });
    const upsertText = JSON.stringify(upserted);
    expect(upsertText).toContain('secret-bridge-2');
    expect(upsertText).not.toContain('sk-another-secret');
  });

  it('UpdateRuntimeEnv does not echo API keys', async () => {
    const patches: Record<string, unknown>[] = [];
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
      applySettings: async (patch) => {
        patches.push(patch);
        return { ok: true, detail: 'saved' };
      },
    });
    const result = await callTool(tools.find(tool => tool.name === 'UpdateRuntimeEnv')!, {
      defaultModel: 'demo-model',
      apiKey: 'sk-write-only',
    });
    expect(patches[0]).toMatchObject({ defaultModel: 'demo-model', apiKey: 'sk-write-only' });
    expect(JSON.stringify(result)).not.toContain('sk-write-only');
    expect(result).toMatchObject({ ok: true, apiKeySet: true });
  });

  it('uses the capability registry for grounded product instructions', async () => {
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
      getEditorContext: () => ({
        activeRegion: 'team',
        entityKind: 'workflow',
        entityName: 'release-flow',
        dirty: true,
        baseDigest: 'draft-v1',
        draft: { name: 'release-flow', squadType: 'workflow' },
      }),
    });
    const editor = await callTool(tools.find(tool => tool.name === 'GetCurrentEditorContext')!);
    expect(editor).toMatchObject({ context: { entityKind: 'workflow', baseDigest: 'draft-v1' } });
    const searched = await callTool(tools.find(tool => tool.name === 'SearchProductCapabilities')!, {
      query: 'create workflow agent model configuration',
    });
    expect(JSON.stringify(searched)).toContain('gui.agents');
    const read = await callTool(tools.find(tool => tool.name === 'ReadProductCapability')!, { id: 'gui.agents' });
    expect(JSON.stringify(read)).toContain('Agents');
    expect(JSON.stringify(read)).toContain('prerequisites');
    expect(JSON.stringify(read)).toContain('limitations');
  });

  it('round-trips every provider configuration field without exposing its key', async () => {
    const tools = await createAssistantGlobalTools({ homeDir, currentWorkDir: workDir });
    await callTool(tools.find(tool => tool.name === 'UpsertBridgeConfig')!, {
      name: 'complete-config',
      runtime: 'claude',
      execution: 'cli',
      authSource: 'apiKey',
      credentialProvider: 'openai',
      trustProjectResources: true,
      provider: 'openai',
      baseURL: 'https://example.invalid/v1',
      apiKey: '$COMPLETE_CONFIG_KEY',
      model: 'vision-model',
      models: [{
        name: 'vision-model',
        modality: 'multimodal',
        contextWindowTokens: 200000,
        maxContextWindowTokens: 1000000,
        effectiveContextWindowPercent: 90,
        autoCompactTokenLimit: 170000,
      }],
    });
    const listed = await callTool(tools.find(tool => tool.name === 'ListBridgeConfigs')!);
    expect(listed).toMatchObject({ configs: [expect.objectContaining({
      name: 'complete-config',
      authSource: 'apiKey',
      credentialProvider: 'openai',
      trustProjectResources: true,
      models: [expect.objectContaining({
        contextWindowTokens: 200000,
        maxContextWindowTokens: 1000000,
        effectiveContextWindowPercent: 90,
        autoCompactTokenLimit: 170000,
      })],
    })] });
    expect(JSON.stringify(listed)).not.toContain('$COMPLETE_CONFIG_KEY');
  });

  it('stages Workflow changes against the active unsaved editor digest', async () => {
    const proposals = new TeamProposalStore();
    const base = {
      name: 'release-flow', mode: 'graph', squadType: 'workflow', members: [],
      workflowTree: { id: 'root', type: 'agent', prompt: 'old', model: 'm1', children: [] },
    } as const;
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
      assistantSessionId: 'assistant-1',
      teamProposals: proposals,
      getEditorContext: () => ({
        activeRegion: 'team', entityKind: 'workflow', entityName: 'release-flow', dirty: true,
        baseDigest: 'editor-v1', draft: base as any,
      }),
    });
    const staged = await callTool(tools.find(tool => tool.name === 'UpsertTeam')!, {
      baseDigest: 'editor-v1',
      definition: {
        ...base,
        workflowTree: { ...base.workflowTree, prompt: 'new' },
      },
      explanation: 'Update the active Workflow prompt',
    }) as { proposalId: string };
    const proposal = proposals.get(staged.proposalId)!;
    expect(proposal.editorBaseDigest).toBe('editor-v1');
    expect(proposal.draft.squadType).toBe('workflow');
    expect(proposal.diff.changedNodes).toEqual(['root']);
    await expect(proposals.apply(staged.proposalId, homeDir, { editorBaseDigest: 'stale' }))
      .rejects.toThrow(/editor changed/i);
  });

  it('lists personal, project, and inherit-session Agent definitions with source', async () => {
    const personalDir = path.join(homeDir, 'agents');
    const projectDir = path.join(workDir, '.hadamard', 'agents');
    fs.mkdirSync(personalDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(personalDir, 'personal.md'), [
      '---', 'name: personal', 'description: Personal agent', 'bridgeConfig: cfg', 'model: m1', '---', '', 'Personal prompt.', '',
    ].join('\n'));
    fs.writeFileSync(path.join(projectDir, 'inherit.md'), [
      '---', 'name: inherit', 'description: Project inherit agent', '---', '', 'Project prompt.', '',
    ].join('\n'));
    const tools = await createAssistantGlobalTools({ homeDir, currentWorkDir: workDir });
    const listed = await callTool(tools.find(tool => tool.name === 'ListAgentProfiles')!);
    expect(listed).toMatchObject({ definitions: expect.arrayContaining([
      expect.objectContaining({ name: 'personal', source: 'user', inheritSessionModel: false }),
      expect.objectContaining({ name: 'inherit', source: 'project', inheritSessionModel: true }),
    ]) });
  });

  it('updates Agents-page team preferences through the shared host writer', async () => {
    let preferences = { autoInvoke: false, defaultAttached: null as string | null, confirmBeforeRun: true };
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
      readTeamPreferences: () => preferences,
      writeTeamPreferences: async next => { preferences = next; },
    });
    const result = await callTool(tools.find(tool => tool.name === 'UpdateTeamPreferences')!, {
      autoInvoke: true,
      confirmBeforeRun: false,
    });
    expect(result).toMatchObject({ ok: true, preferences: { autoInvoke: true, confirmBeforeRun: false } });
    expect(preferences).toEqual({ autoInvoke: true, defaultAttached: null, confirmBeforeRun: false });
  });

  it('creates, lists, and deletes router profiles without exposing secrets', async () => {
    const tools = await createAssistantGlobalTools({
      homeDir,
      currentWorkDir: workDir,
    });
    const created = await callTool(tools.find(tool => tool.name === 'UpsertRouterProfile')!, {
      name: 'smart-router',
      scope: 'personal',
      routerModel: { model: 'leader-model', apiKey: '$ROUTER_API_KEY' },
      routes: [{ role: 'fast', when: 'Simple requests', model: 'fast-model' }],
    });
    expect(JSON.stringify(created)).not.toContain('$ROUTER_API_KEY');

    const listed = await callTool(tools.find(tool => tool.name === 'ListRouterProfiles')!);
    expect(JSON.stringify(listed)).toContain('smart-router');
    expect(JSON.stringify(listed)).not.toContain('$ROUTER_API_KEY');

    await callTool(tools.find(tool => tool.name === 'DeleteRouterProfile')!, {
      name: 'smart-router',
    });
    const afterDelete = await callTool(tools.find(tool => tool.name === 'ListRouterProfiles')!);
    expect(JSON.stringify(afterDelete)).not.toContain('smart-router');
  });

  it('builds a Global system prompt with hard rules', () => {
    const prompt = buildAssistantGlobalSystemPrompt(workDir);
    expect(prompt).toContain('Global scope');
    expect(prompt).toContain('ListProjects');
    expect(prompt).toMatch(/no Write\/Edit\/Bash/i);
  });
});
