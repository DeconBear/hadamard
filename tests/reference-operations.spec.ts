/**
 * P1 cascade operations tests: transactional rename, force-delete fallback
 * strategies, config-model re-point, and the fallback preference default.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyDeleteFallback,
  degradeAgentRefsInRouter,
  removeTeamRefNodes,
  renameDefinitionAndReferences,
  repointConfigModel,
  rewriteRouterFileRefs,
  rewriteTeamFileRefs,
} from '../src/manager/referenceOperations.js';
import { resolveHadamardHome } from '../src/config/hadamardHome.js';
import { findAgentProfile, readAgentProfiles } from '../src/config/agentProfiles.js';
import {
  DEFAULT_MANAGER_CONFIG,
  writeManagerConfig,
} from '../src/manager/projectManager.js';
import { upsertScheduledAutomationTask } from '../src/scheduling/taskPersistence.js';
import { readGuiPreferences } from '../src/gui/hadamardGui.js';
import type { RouterProfile, TeamDefinition } from '../src/types.js';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hadamard-refops-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}
function readJson(filePath: string): any {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function seedHome(): { home: string; project: string } {
  const home = tempDir();
  const project = tempDir();
  writeJson(path.join(home, '.hadamard', 'bridge-configs.json'), {
    configs: [
      { name: 'cfg', runtime: 'claude', provider: 'anthropic', apiKey: '$CFG_KEY', model: 'm1', models: [{ name: 'm1' }, { name: 'm2' }] },
      { name: 'other', runtime: 'claude', provider: 'anthropic', model: 'm9' },
    ],
  });
  writeJson(path.join(home, '.hadamard', 'agent-configs.json'), {
    version: 1,
    profiles: [
      { name: 'coder', bridgeConfig: 'cfg', model: 'm1' },
      { name: 'writer', bridgeConfig: 'cfg', model: 'm2' },
    ],
  });
  return { home, project };
}

// ── pure rewrite helpers ────────────────────────────────────────────

describe('rewriteRouterFileRefs', () => {
  it('rewrites typed agent targets and fallbackTarget', () => {
    const raw: RouterProfile = {
      name: 'r',
      routerModel: { model: 'lead' },
      routes: [
        { model: 'm1', when: 'code', target: { kind: 'agent', name: 'coder' } },
        { model: 'm2', when: 'misc', target: { kind: 'model', config: 'cfg', model: 'm2' } },
      ],
      fallbackTarget: { kind: 'agent', name: 'coder' },
    };
    expect(rewriteRouterFileRefs(raw, 'agent', 'coder', 'coder2', new Set(['coder', 'writer']))).toBe(true);
    expect(raw.routes[0]?.target).toEqual({ kind: 'agent', name: 'coder2' });
    expect(raw.routes[1]?.target).toEqual({ kind: 'model', config: 'cfg', model: 'm2' });
    expect(raw.fallbackTarget).toEqual({ kind: 'agent', name: 'coder2' });
  });

  it('follows legacy role-matched routes on agent rename', () => {
    const raw: RouterProfile = {
      name: 'r',
      routerModel: { model: 'lead' },
      routes: [{ role: 'coder', model: 'm1', when: 'code' }],
    };
    expect(rewriteRouterFileRefs(raw, 'agent', 'coder', 'coder2', new Set(['coder']))).toBe(true);
    expect(raw.routes[0]?.role).toBe('coder2');
  });

  it('does not touch role when the old name was not a known agent', () => {
    const raw: RouterProfile = {
      name: 'r',
      routerModel: { model: 'lead' },
      routes: [{ role: 'coder', model: 'm1', when: 'code' }],
    };
    expect(rewriteRouterFileRefs(raw, 'agent', 'coder', 'coder2', new Set())).toBe(false);
    expect(raw.routes[0]?.role).toBe('coder');
  });

  it('rewrites config references on model targets', () => {
    const raw: RouterProfile = {
      name: 'r',
      routerModel: { model: 'lead' },
      routes: [{ model: 'm1', when: 'x', target: { kind: 'model', config: 'cfg', model: 'm1' } }],
    };
    expect(rewriteRouterFileRefs(raw, 'config', 'cfg', 'cfg2', new Set())).toBe(true);
    expect(raw.routes[0]?.target).toEqual({ kind: 'model', config: 'cfg2', model: 'm1' });
  });
});

describe('team file rewrites', () => {
  it('rewriteTeamFileRefs rewrites teamRef and typed targetRefs', () => {
    const raw = {
      name: 'g',
      mode: 'graph',
      members: [],
      nodes: [
        { id: 'sub', type: 'team', teamRef: 'child' },
        { id: 'a', model: 'm1', targetRef: { kind: 'team', name: 'child' } },
      ],
      workflowTree: {
        id: 'root', type: 'agent', model: 'm1',
        targetRef: { kind: 'agent', name: 'coder' },
        children: [],
      },
    } as unknown as TeamDefinition;
    expect(rewriteTeamFileRefs(raw, 'team', 'child', 'child2')).toBe(true);
    expect(raw.nodes?.[0]?.teamRef).toBe('child2');
    expect(raw.nodes?.[1]?.targetRef).toEqual({ kind: 'team', name: 'child2' });
    expect(rewriteTeamFileRefs(raw, 'agent', 'coder', 'coder2')).toBe(true);
    expect(raw.workflowTree?.targetRef).toEqual({ kind: 'agent', name: 'coder2' });
  });

  it('degradeAgentRefsInRouter turns agent targets into raw model refs', () => {
    const raw: RouterProfile = {
      name: 'r',
      routerModel: { model: 'lead' },
      routes: [{ model: 'm1', when: 'x', target: { kind: 'agent', name: 'coder' } }],
    };
    expect(degradeAgentRefsInRouter(raw, 'coder', 'm1')).toBe(true);
    expect(raw.routes[0]?.target).toEqual({ kind: 'model', config: '', model: 'm1' });
  });

  it('removeTeamRefNodes drops referencing nodes and their incident edges', () => {
    const raw = {
      name: 'g',
      mode: 'graph',
      members: [],
      nodes: [
        { id: 'task', kind: 'task' },
        { id: 'sub', type: 'team', teamRef: 'child' },
        { id: 'solo', model: 'm1' },
      ],
      edges: [
        { from: 'task', to: 'sub' },
        { from: 'task', to: 'solo' },
      ],
    } as unknown as TeamDefinition;
    expect(removeTeamRefNodes(raw, 'child')).toBe(true);
    expect(raw.nodes?.map((n) => n.id)).toEqual(['task', 'solo']);
    expect(raw.edges).toEqual([{ from: 'task', to: 'solo' }]);
  });
});

// ── rename transaction ──────────────────────────────────────────────

describe('renameDefinitionAndReferences', () => {
  it('renames an agent and rewrites router/team references, preserving $ENV_VAR keys', async () => {
    const { home, project } = seedHome();
    writeJson(path.join(project, '.hadamard', 'routers', 'r.json'), {
      name: 'r',
      routerModel: { model: 'lead' },
      routes: [
        { role: 'legacy', model: 'm1', when: 'a', apiKey: '$ROUTE_KEY', target: { kind: 'agent', name: 'coder' } },
        { role: 'writer', model: 'm2', when: 'b' }, // legacy role match
      ],
    });
    writeJson(path.join(project, '.hadamard', 'teams', 'g.json'), {
      name: 'g', mode: 'graph', squadType: 'graph', members: [],
      nodes: [{ id: 'a', model: 'm1', targetRef: { kind: 'agent', name: 'coder' } }],
      edges: [],
    });

    const report = await renameDefinitionAndReferences('agent', 'coder', 'coder2', { projectDir: project, homeDir: home });
    expect(report.rewritten.length).toBeGreaterThan(0);

    // Unified store (S1a): profiles live in agents/*.md post-migration;
    // assert through the compatibility view.
    const profiles = readAgentProfiles(home);
    expect(profiles.profiles.map((p) => p.name).sort()).toEqual(['coder2', 'writer']);

    const router = readJson(path.join(project, '.hadamard', 'routers', 'r.json'));
    expect(router.routes[0].target).toEqual({ kind: 'agent', name: 'coder2' });
    expect(router.routes[0].apiKey).toBe('$ROUTE_KEY'); // $ENV_VAR preserved
    expect(router.routes[1].role).toBe('writer'); // unchanged (different agent)
    const team = readJson(path.join(project, '.hadamard', 'teams', 'g.json'));
    expect(team.nodes[0].targetRef).toEqual({ kind: 'agent', name: 'coder2' });
  });

  it('renames a config and rewrites profile/manager/router references', async () => {
    const { home, project } = seedHome();
    await writeManagerConfig(project, resolveHadamardHome(home), { ...DEFAULT_MANAGER_CONFIG, bridgeConfig: 'cfg' });
    writeJson(path.join(project, '.hadamard', 'routers', 'r.json'), {
      name: 'r',
      routerModel: { model: 'm1' },
      routerModelTarget: { kind: 'model', config: 'cfg', model: 'm1' },
      routes: [{ model: 'm1', when: 'a', target: { kind: 'model', config: 'cfg', model: 'm1' } }],
      fallback: { model: 'm1' },
      fallbackTarget: { kind: 'model', config: 'cfg', model: 'm1' },
    });

    await renameDefinitionAndReferences('config', 'cfg', 'cfg2', {
      projectDir: project,
      homeDir: home,
      managerProjectPath: project,
    });

    const configs = readJson(path.join(home, '.hadamard', 'bridge-configs.json'));
    expect(configs.configs.map((c: any) => c.name).sort()).toEqual(['cfg2', 'other']);
    const profiles = readAgentProfiles(home);
    expect(profiles.profiles.every((p) => p.bridgeConfig === 'cfg2')).toBe(true);
    const router = readJson(path.join(project, '.hadamard', 'routers', 'r.json'));
    expect(router.routerModelTarget.config).toBe('cfg2');
    expect(router.routes[0].target.config).toBe('cfg2');
    expect(router.fallbackTarget.config).toBe('cfg2');
  });

  it('renames references stored by Issues and the global Assistant', async () => {
    const { home, project } = seedHome();
    let issueAgent: string | null = 'coder';
    let assistant = { bridgeConfig: 'cfg', model: 'm1' };

    await renameDefinitionAndReferences('agent', 'coder', 'coder2', {
      projectDir: project,
      homeDir: home,
      issues: {
        read: async () => [{ id: 'issue-1', number: 7, agentConfig: issueAgent ?? undefined }],
        writeAgentConfig: async (_id, value) => { issueAgent = value; },
      },
    });
    expect(issueAgent).toBe('coder2');

    await renameDefinitionAndReferences('config', 'cfg', 'cfg2', {
      projectDir: project,
      homeDir: home,
      assistantConfig: {
        read: async () => assistant,
        write: async (value) => { assistant = { ...assistant, ...value }; },
      },
    });
    expect(assistant.bridgeConfig).toBe('cfg2');
  });

  it('restores files and external Issue state when an atomic rename fails', async () => {
    const { home, project } = seedHome();
    writeJson(path.join(project, '.hadamard', 'routers', 'r.json'), {
      name: 'r',
      routerModel: { model: 'lead' },
      routes: [{ model: 'm1', when: 'a', target: { kind: 'agent', name: 'coder' } }],
    });
    let issueAgent: string | null = 'coder';
    await expect(renameDefinitionAndReferences('agent', 'coder', 'coder2', {
      projectDir: project,
      homeDir: home,
      issues: {
        read: async () => [{ id: 'issue-1', agentConfig: issueAgent ?? undefined }],
        writeAgentConfig: async (_id, value) => {
          issueAgent = value;
          if (value === 'coder2') throw new Error('simulated Issue storage failure');
        },
      },
    })).rejects.toThrow(/simulated Issue storage failure/);
    expect(issueAgent).toBe('coder');
    expect(readJson(path.join(project, '.hadamard', 'routers', 'r.json')).routes[0].target.name).toBe('coder');
    expect(readAgentProfiles(home).profiles.some(profile => profile.name === 'coder')).toBe(true);
  });

  it('renames a team: file, other teams, automation tasks, defaultAttached', async () => {
    const { home, project } = seedHome();
    writeJson(path.join(project, '.hadamard', 'teams', 'child.json'), { name: 'child', mode: 'graph', members: [] });
    writeJson(path.join(project, '.hadamard', 'teams', 'parent.json'), {
      name: 'parent', mode: 'graph', squadType: 'graph', members: [],
      nodes: [{ id: 'sub', type: 'team', teamRef: 'child' }],
      edges: [],
    });
    await upsertScheduledAutomationTask(project, {
      name: 'nightly', kind: 'workflow', workflowSource: 'agent', workflowName: 'child',
      cron: '0 9 * * *', enabled: true,
    });
    let captured: string | null = null;
    const report = await renameDefinitionAndReferences('team', 'child', 'renamed', {
      projectDir: project,
      homeDir: home,
      teamPreferences: {
        read: () => ({ autoInvoke: false, defaultAttached: 'child', confirmBeforeRun: true }),
        write: (prefs) => { captured = prefs.defaultAttached; },
      },
    });
    expect(report.rewritten.length).toBeGreaterThan(0);
    expect(readJson(path.join(project, '.hadamard', 'teams', 'renamed.json')).name).toBe('renamed');
    expect(() => readJson(path.join(project, '.hadamard', 'teams', 'child.json'))).toThrow();
    const parent = readJson(path.join(project, '.hadamard', 'teams', 'parent.json'));
    expect(parent.nodes[0].teamRef).toBe('renamed');
    const tasks = readJson(path.join(project, '.hadamard', 'scheduled-tasks.json'));
    expect(tasks.tasks[0].workflowName).toBe('renamed');
    expect(captured).toBe('renamed');
  });

  it('renames a router: file renamed, embedded name updated', async () => {
    const { home, project } = seedHome();
    writeJson(path.join(project, '.hadamard', 'routers', 'fast.json'), {
      name: 'fast', routerModel: { model: 'lead' }, routes: [{ model: 'm1', when: 'x' }],
    });
    await renameDefinitionAndReferences('router', 'fast', 'faster', { projectDir: project, homeDir: home });
    expect(readJson(path.join(project, '.hadamard', 'routers', 'faster.json')).name).toBe('faster');
    expect(() => readJson(path.join(project, '.hadamard', 'routers', 'fast.json'))).toThrow();
  });

  it('rejects renaming a built-in team and renaming onto an existing name', async () => {
    const { home, project } = seedHome();
    await expect(renameDefinitionAndReferences('team', 'reviewer', 'x', { projectDir: project, homeDir: home }))
      .rejects.toThrow(/built-in/);
    await expect(renameDefinitionAndReferences('agent', 'coder', 'writer', { projectDir: project, homeDir: home }))
      .rejects.toThrow(/already exists/);
    // failed rename leaves the profile store untouched
    const profiles = readAgentProfiles(home);
    expect(profiles.profiles.map((p) => p.name).sort()).toEqual(['coder', 'writer']);
  });
});

// ── force-delete fallbacks ──────────────────────────────────────────

describe('applyDeleteFallback', () => {
  it('config repoint rewrites profile bridgeConfig and router model targets', async () => {
    const { home, project } = seedHome();
    writeJson(path.join(project, '.hadamard', 'routers', 'r.json'), {
      name: 'r',
      routerModel: { model: 'lead' },
      routes: [{ model: 'm1', when: 'a', target: { kind: 'model', config: 'cfg', model: 'm1' } }],
    });
    await applyDeleteFallback('config', 'cfg', { type: 'repoint', target: 'other' }, { projectDir: project, homeDir: home });
    const profiles = readAgentProfiles(home);
    expect(profiles.profiles.every((p) => p.bridgeConfig === 'other')).toBe(true);
    const router = readJson(path.join(project, '.hadamard', 'routers', 'r.json'));
    expect(router.routes[0].target.config).toBe('other');
  });

  it('repoints Assistant config, clears Issue assignment, and clears a deleted default team', async () => {
    const { home, project } = seedHome();
    let assistant: { bridgeConfig?: string } = { bridgeConfig: 'cfg' };
    await applyDeleteFallback('config', 'cfg', { type: 'repoint', target: 'other' }, {
      projectDir: project,
      homeDir: home,
      assistantConfig: {
        read: async () => assistant,
        write: async value => { assistant = value; },
      },
    });
    expect(assistant.bridgeConfig).toBe('other');

    let issueAgent: string | null = 'coder';
    await applyDeleteFallback('agent', 'coder', { type: 'degrade-model' }, {
      projectDir: project,
      homeDir: home,
      issues: {
        read: async () => [{ id: 'issue-1', number: 3, agentConfig: issueAgent ?? undefined }],
        writeAgentConfig: async (_id, value) => { issueAgent = value; },
      },
    });
    expect(issueAgent).toBeNull();

    let defaultAttached: string | null = 'child';
    await applyDeleteFallback('team', 'child', { type: 'remove-nodes' }, {
      projectDir: project,
      homeDir: home,
      teamPreferences: {
        read: () => ({ autoInvoke: false, defaultAttached, confirmBeforeRun: true }),
        write: prefs => { defaultAttached = prefs.defaultAttached; },
      },
    });
    expect(defaultAttached).toBeNull();
  });

  it('agent degrade-model keeps the original model id as a raw model ref', async () => {
    const { home, project } = seedHome();
    writeJson(path.join(project, '.hadamard', 'routers', 'r.json'), {
      name: 'r',
      routerModel: { model: 'lead' },
      routes: [{ model: 'm1', when: 'a', target: { kind: 'agent', name: 'coder' } }],
    });
    writeJson(path.join(project, '.hadamard', 'teams', 'g.json'), {
      name: 'g', mode: 'graph', squadType: 'graph', members: [],
      nodes: [{ id: 'a', model: 'm1', targetRef: { kind: 'agent', name: 'coder' } }],
      edges: [],
    });
    await applyDeleteFallback('agent', 'coder', { type: 'degrade-model' }, { projectDir: project, homeDir: home });
    const router = readJson(path.join(project, '.hadamard', 'routers', 'r.json'));
    expect(router.routes[0].target).toEqual({ kind: 'model', config: '', model: 'm1' });
    const team = readJson(path.join(project, '.hadamard', 'teams', 'g.json'));
    expect(team.nodes[0].targetRef ?? null).toBeNull();
    expect(team.nodes[0].model).toBe('m1'); // legacy field remains the fallback
  });

  it('team remove-nodes drops referencing nodes; leave is a no-op', async () => {
    const { home, project } = seedHome();
    writeJson(path.join(project, '.hadamard', 'teams', 'parent.json'), {
      name: 'parent', mode: 'graph', squadType: 'graph', members: [],
      nodes: [
        { id: 'sub', type: 'team', teamRef: 'child' },
        { id: 'solo', model: 'm1' },
      ],
      edges: [{ from: 'sub', to: 'solo' }],
    });
    await applyDeleteFallback('team', 'child', { type: 'remove-nodes' }, { projectDir: project, homeDir: home });
    const parent = readJson(path.join(project, '.hadamard', 'teams', 'parent.json'));
    expect(parent.nodes.map((n: any) => n.id)).toEqual(['solo']);
    expect(parent.edges).toEqual([]);

    writeJson(path.join(project, '.hadamard', 'teams', 'parent.json'), {
      name: 'parent', mode: 'graph', squadType: 'graph', members: [],
      nodes: [{ id: 'sub', type: 'team', teamRef: 'child' }],
      edges: [],
    });
    const report = await applyDeleteFallback('team', 'child', { type: 'leave' }, { projectDir: project, homeDir: home });
    expect(report.rewritten).toEqual([]);
    expect(readJson(path.join(project, '.hadamard', 'teams', 'parent.json')).nodes[0].teamRef).toBe('child');
  });
});

// ── config model re-point ───────────────────────────────────────────

describe('repointConfigModel', () => {
  it('re-points profile models and typed model targets', async () => {
    const { home, project } = seedHome();
    writeJson(path.join(project, '.hadamard', 'routers', 'r.json'), {
      name: 'r',
      routerModel: { model: 'm1' },
      routerModelTarget: { kind: 'model', config: 'cfg', model: 'm1' },
      routes: [{ model: 'm1', when: 'a', target: { kind: 'model', config: 'cfg', model: 'm1' } }],
      fallback: { model: 'm1' },
      fallbackTarget: { kind: 'model', config: 'cfg', model: 'm1' },
    });
    await repointConfigModel('cfg', 'm1', 'm2', { projectDir: project, homeDir: home });
    expect(findAgentProfile('coder', home)?.model).toBe('m2');
    const router = readJson(path.join(project, '.hadamard', 'routers', 'r.json'));
    expect(router.routerModel).toEqual({ model: 'm2' });
    expect(router.routerModelTarget).toEqual({ kind: 'model', config: 'cfg', model: 'm2' });
    expect(router.routes[0].model).toBe('m2');
    expect(router.routes[0].target).toEqual({ kind: 'model', config: 'cfg', model: 'm2' });
    expect(router.fallback).toEqual({ model: 'm2' });
    expect(router.fallbackTarget).toEqual({ kind: 'model', config: 'cfg', model: 'm2' });
  });
});

// ── unified .md agent store (S3) ────────────────────────────────────

function writeAgentMd(dir: string, name: string, frontmatter: string[], body = 'Agent body.'): string {
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name + '.md');
  writeFileSync(filePath, ['---', 'name: ' + name, 'description: test agent', ...frontmatter, '---', '', body, ''].join('\n'), 'utf-8');
  return filePath;
}

describe('unified .md agent store (S3)', () => {
  it('renames a pure .md agent: frontmatter, file, and referencers', async () => {
    const { home, project } = seedHome();
    writeAgentMd(path.join(home, '.hadamard', 'agents'), 'mdagent', ['model: m-x']);
    writeJson(path.join(project, '.hadamard', 'routers', 'r.json'), {
      name: 'r',
      routerModel: { model: 'lead' },
      routes: [{ model: 'm1', when: 'a', target: { kind: 'agent', name: 'mdagent' } }],
    });
    writeJson(path.join(project, '.hadamard', 'teams', 'g.json'), {
      name: 'g', mode: 'graph', squadType: 'graph', members: [],
      nodes: [{ id: 'a', model: 'm1', targetRef: { kind: 'agent', name: 'mdagent' } }],
      edges: [],
    });

    const report = await renameDefinitionAndReferences('agent', 'mdagent', 'mdagent2', { projectDir: project, homeDir: home });
    expect(report.rewritten.some((entry: string) => entry.includes('mdagent2.md'))).toBe(true);

    const dir = path.join(home, '.hadamard', 'agents');
    expect(existsSync(path.join(dir, 'mdagent.md'))).toBe(false);
    const renamed = readFileSync(path.join(dir, 'mdagent2.md'), 'utf-8');
    expect(renamed).toContain('name: mdagent2');
    expect(renamed).toContain('model: m-x');
    const router = readJson(path.join(project, '.hadamard', 'routers', 'r.json'));
    expect(router.routes[0].target).toEqual({ kind: 'agent', name: 'mdagent2' });
    const team = readJson(path.join(project, '.hadamard', 'teams', 'g.json'));
    expect(team.nodes[0].targetRef).toEqual({ kind: 'agent', name: 'mdagent2' });
  });

  it('renames a project-scoped .md agent', async () => {
    const { home, project } = seedHome();
    writeAgentMd(path.join(project, '.hadamard', 'agents'), 'projagent', ['bridgeConfig: cfg', 'model: m1']);
    await renameDefinitionAndReferences('agent', 'projagent', 'projagent2', { projectDir: project, homeDir: home });
    const dir = path.join(project, '.hadamard', 'agents');
    expect(existsSync(path.join(dir, 'projagent.md'))).toBe(false);
    expect(readFileSync(path.join(dir, 'projagent2.md'), 'utf-8')).toContain('name: projagent2');
  });

  it('rejects renaming onto a built-in agent name and onto an existing .md name', async () => {
    const { home, project } = seedHome();
    await expect(renameDefinitionAndReferences('agent', 'coder', 'general-purpose', { projectDir: project, homeDir: home }))
      .rejects.toThrow(/already exists/);
    writeAgentMd(path.join(home, '.hadamard', 'agents'), 'taken', []);
    await expect(renameDefinitionAndReferences('agent', 'coder', 'taken', { projectDir: project, homeDir: home }))
      .rejects.toThrow(/already exists/);
    // The store is untouched by the failed renames.
    expect(readAgentProfiles(home).profiles.map((p) => p.name).sort()).toEqual(['coder', 'writer']);
    expect(existsSync(path.join(home, '.hadamard', 'agents', 'taken.md'))).toBe(true);
  });

  it('degrade-model reads the model from the .md definition', async () => {
    const { home, project } = seedHome();
    writeAgentMd(path.join(home, '.hadamard', 'agents'), 'mdonly', ['model: m-x'], 'Body.');
    writeJson(path.join(project, '.hadamard', 'routers', 'r.json'), {
      name: 'r',
      routerModel: { model: 'lead' },
      routes: [{ model: 'm1', when: 'a', target: { kind: 'agent', name: 'mdonly' } }],
    });
    await applyDeleteFallback('agent', 'mdonly', { type: 'degrade-model' }, { projectDir: project, homeDir: home });
    const router = readJson(path.join(project, '.hadamard', 'routers', 'r.json'));
    expect(router.routes[0].target).toEqual({ kind: 'model', config: '', model: 'm-x' });
  });
});

// ── fallback preference default (§3.5) ──────────────────────────────

describe('useDefaultModelAsFallback preference', () => {
  it('defaults to on and parses explicit values', () => {
    expect(readGuiPreferences({}).useDefaultModelAsFallback).toBe(true);
    expect(readGuiPreferences({ gui: {} }).useDefaultModelAsFallback).toBe(true);
    expect(readGuiPreferences({ gui: { useDefaultModelAsFallback: false } }).useDefaultModelAsFallback).toBe(false);
    expect(readGuiPreferences({ gui: { useDefaultModelAsFallback: true } }).useDefaultModelAsFallback).toBe(true);
  });
});
