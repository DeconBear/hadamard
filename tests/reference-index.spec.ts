/**
 * Unified reference model (P0) tests:
 *  - reference index edge discovery / findUsages / findBrokenRefs
 *  - router profile lazy migration (load + save round-trip)
 *  - team definition targetRef lazy migration
 *  - resolveTargetRef incl. BrokenReferenceError
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildReferenceIndex,
  findBrokenRefs,
  findUsages,
  type ReferenceEdge,
} from '../src/manager/referenceIndex.js';
import {
  BrokenReferenceError,
  resolveTargetRef,
} from '../src/manager/resolveTargetRef.js';
import {
  loadRouterProfile,
  saveRouterProfile,
} from '../src/router/modelRouter.js';
import {
  loadTeamDefinition,
  migrateTeamDefinitionTargetRefs,
  saveTeamDefinition,
} from '../src/team/teamDefinitions.js';
import {
  insertParallelAsNestedTeam,
  scaffoldMinimalGraphTeam,
} from '../src/team/teamGraphScaffold.js';
import type { RouterProfile, TeamDefinition } from '../src/types.js';

const tempDirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hadamard-refindex-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeBridgeConfigs(home: string, configs: unknown[]): void {
  const dir = path.join(home, '.hadamard');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'bridge-configs.json'), JSON.stringify({ configs }), 'utf-8');
}

function writeAgentProfiles(home: string, profiles: unknown[]): void {
  const dir = path.join(home, '.hadamard');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'agent-configs.json'), JSON.stringify({ version: 1, profiles }), 'utf-8');
}

// ── buildReferenceIndex ─────────────────────────────────────────────

function sampleIndex(): ReferenceEdge[] {
  return buildReferenceIndex({
    bridgeConfigs: [
      { name: 'cfg', runtime: 'claude', provider: 'anthropic', model: 'm1' },
    ],
    agentProfiles: [
      { name: 'coder', bridgeConfig: 'cfg', model: 'm1' },
      { name: 'lost', bridgeConfig: 'gone', model: 'm2' },
    ],
    routers: [
      {
        name: 'r1',
        routerModel: { model: 'lead' },
        routes: [
          // legacy route whose role matches a saved agent profile
          { role: 'coder', model: 'm1', when: 'coding work' },
          // explicit typed target to a team
          { model: 'm3', when: 'delegate', target: { kind: 'team', name: 't1' } },
          // raw model-only route (raw model ref → no config edge)
          { model: 'm4', when: 'misc' },
        ],
        fallback: { model: 'fb' },
      },
    ],
    teams: [
      {
        name: 'g1',
        mode: 'graph',
        members: [],
        nodes: [
          { id: 'sub', type: 'team', teamRef: 't1' },
          { id: 'a2', model: 'm1', targetRef: { kind: 'agent', name: 'coder' } },
          { id: 'a3', model: 'm1', targetRef: { kind: 'model', config: 'cfg', model: 'm1' } },
        ],
      },
      {
        name: 'wf-team',
        mode: 'graph',
        squadType: 'workflow',
        members: [],
        workflowTree: {
          id: 'root',
          type: 'agent',
          model: 'm1',
          targetRef: { kind: 'agent', name: 'coder' },
          children: [],
        },
      },
    ],
    automationTasks: [
      { id: 'a1', name: 'nightly', kind: 'workflow', workflowSource: 'agent', workflowName: 'wf-team' },
      // legacy script-runtime task: references a workflow script, not a team
      { id: 'a2', name: 'legacy', kind: 'workflow', workflowName: 'script-wf' },
    ],
    teamPreferences: { autoInvoke: false, defaultAttached: 'g1', confirmBeforeRun: true },
    managerConfigs: [{ name: '/proj', bridgeConfig: 'cfg' }],
    session: { activeAgent: 'coder', activeConfig: 'cfg', activeRouterName: 'r1', activeTeamName: 'g1' },
  });
}

describe('buildReferenceIndex', () => {
  it('discovers config references from agent profiles, manager configs, and session state', () => {
    const usages = findUsages(sampleIndex(), 'config', 'cfg');
    const froms = usages.map((edge) => `${edge.from.kind}:${edge.from.name}`).sort();
    expect(froms).toEqual(['agent:coder', 'manager:/proj', 'session:active', 'team:g1']);
    expect(usages.find((edge) => edge.from.kind === 'agent')?.field).toBe('bridgeConfig');
    expect(usages.find((edge) => edge.from.kind === 'team')?.field).toBe('nodes[a3].targetRef');
  });

  it('discovers agent references from router routes (role match), graph nodes, workflow nodes, session', () => {
    const usages = findUsages(sampleIndex(), 'agent', 'coder');
    const fields = usages.map((edge) => `${edge.from.kind}:${edge.field}`).sort();
    expect(fields).toEqual([
      'router:routes[0].target',
      'session:activeAgent',
      'team:nodes[a2].targetRef',
      'team:workflowTree.root.targetRef',
    ]);
  });

  it('discovers team references from router targets, teamRef nodes, automations, preferences, session', () => {
    const index = sampleIndex();
    expect(findUsages(index, 'team', 't1').map((edge) => `${edge.from.kind}:${edge.field}`).sort())
      .toEqual(['router:routes[1].target', 'team:nodes[sub].teamRef']);
    expect(findUsages(index, 'team', 'wf-team').map((edge) => edge.from.kind)).toEqual(['automation']);
    expect(findUsages(index, 'team', 'g1').map((edge) => edge.from.kind).sort())
      .toEqual(['preference', 'session']);
    // legacy script-runtime automation does not reference a team
    expect(findUsages(index, 'team', 'script-wf')).toEqual([]);
  });

  it('discovers router references from session state only', () => {
    const usages = findUsages(sampleIndex(), 'router', 'r1');
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ from: { kind: 'session' }, field: 'activeRouterName' });
  });

  it('raw model refs (config: "") produce no config edges', () => {
    const index = sampleIndex();
    expect(index.some((edge) => edge.field === 'fallbackTarget')).toBe(false);
    expect(index.some((edge) => edge.field === 'routes[2].target')).toBe(false);
  });
});

describe('findBrokenRefs', () => {
  it('reports edges whose target is missing from the known sets', () => {
    const broken = findBrokenRefs(sampleIndex(), {
      configs: ['cfg'],
      agents: ['coder'],
      teams: ['g1', 't1'],
      routers: ['r1'],
    });
    const summary = broken.map((edge) => `${edge.from.kind}:${edge.from.name}→${edge.to.kind}:${edge.to.name}`).sort();
    expect(summary).toEqual([
      'agent:lost→config:gone',
      'automation:nightly→team:wf-team',
    ]);
  });

  it('does not report target kinds whose known set is omitted', () => {
    expect(findBrokenRefs(sampleIndex(), { agents: ['coder'] })).toEqual([]);
  });
});

// ── router profile lazy migration ───────────────────────────────────

describe('router profile target migration', () => {
  function seedRouterHome(): string {
    const home = tempHome();
    writeAgentProfiles(home, [{ name: 'coder', bridgeConfig: 'cfg', model: 'gpt-x' }]);
    mkdirSync(path.join(home, '.hadamard', 'routers'), { recursive: true });
    writeFileSync(
      path.join(home, '.hadamard', 'routers', 'r.json'),
      JSON.stringify({
        name: 'r',
        routerModel: { model: 'lead' },
        routes: [
          { role: 'coder', model: 'gpt-x', when: 'coding' },
          { role: 'fast', model: 'haiku', when: 'quick' },
        ],
        fallback: { model: 'sonnet' },
      }),
      'utf-8',
    );
    return home;
  }

  it('migrates legacy routes on load: role match → agent, model-only → raw model ref', () => {
    const loaded = loadRouterProfile('r', undefined, seedRouterHome());
    expect(loaded).not.toBeNull();
    const [agentRoute, modelRoute] = loaded!.profile.routes;
    expect(agentRoute?.target).toEqual({ kind: 'agent', name: 'coder' });
    expect(modelRoute?.target).toEqual({ kind: 'model', config: '', model: 'haiku' });
    expect(loaded!.profile.fallbackTarget).toEqual({ kind: 'model', config: '', model: 'sonnet' });
  });

  it('round-trip save writes target and keeps the legacy fields', async () => {
    const home = seedRouterHome();
    const loaded = loadRouterProfile('r', undefined, home)!;
    const filePath = await saveRouterProfile(loaded.profile, { homeDir: home, overwrite: true });
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as RouterProfile;
    expect(raw.routes[0]?.target).toEqual({ kind: 'agent', name: 'coder' });
    expect(raw.routes[0]?.model).toBe('gpt-x'); // legacy field kept
    expect(raw.fallbackTarget).toEqual({ kind: 'model', config: '', model: 'sonnet' });
    expect(raw.fallback?.model).toBe('sonnet');

    // loading the migrated file keeps the typed targets
    const reloaded = loadRouterProfile('r', undefined, home)!;
    expect(reloaded.profile.routes[0]?.target).toEqual({ kind: 'agent', name: 'coder' });
  });

  it('saveRouterProfile migrates a fresh profile without targets', async () => {
    const home = tempHome();
    writeAgentProfiles(home, [{ name: 'coder', bridgeConfig: 'cfg', model: 'gpt-x' }]);
    const filePath = await saveRouterProfile(
      {
        name: 'fresh',
        routerModel: { model: 'lead' },
        routes: [{ role: 'coder', model: 'gpt-x', when: 'coding' }],
      },
      { homeDir: home, overwrite: true },
    );
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as RouterProfile;
    expect(raw.routes[0]?.target).toEqual({ kind: 'agent', name: 'coder' });
  });
});

// ── team definition targetRef migration ─────────────────────────────

describe('team definition targetRef migration', () => {
  it('migrates type:team + teamRef nodes to a typed targetRef', () => {
    const def = {
      name: 'g',
      mode: 'graph',
      members: [],
      nodes: [
        { id: 'sub', type: 'team', teamRef: 'other' },
        { id: 'plain', model: 'm1' },
        { id: 'kept', type: 'team', teamRef: 'x', targetRef: { kind: 'team', name: 'explicit' } },
      ],
    } as unknown as TeamDefinition;
    const migrated = migrateTeamDefinitionTargetRefs(def);
    expect(migrated.nodes?.[0]?.targetRef).toEqual({ kind: 'team', name: 'other' });
    expect(migrated.nodes?.[0]?.teamRef).toBe('other'); // legacy field kept
    expect(migrated.nodes?.[1]?.targetRef).toBeUndefined(); // raw model stays legacy
    expect(migrated.nodes?.[2]?.targetRef).toEqual({ kind: 'team', name: 'explicit' });
    // input not mutated
    expect(def.nodes?.[0]?.targetRef).toBeUndefined();
  });

  it('load → save round-trips targetRef for nested-team graph nodes', async () => {
    const project = tempHome();
    const parent = scaffoldMinimalGraphTeam('parent-p');
    const { definition } = insertParallelAsNestedTeam(parent, {
      nestedName: 'parent-p-parallel',
      members: [{ id: 'researcher' }, { id: 'skeptic' }],
    });
    // simulate a legacy on-disk file: strip targetRef, keep teamRef
    const legacy = {
      ...definition,
      nodes: definition.nodes?.map((node) => {
        if (node.type !== 'team') return node;
        const { targetRef: _drop, ...rest } = node;
        return rest;
      }),
    } as TeamDefinition;
    await saveTeamDefinition(legacy, { projectDir: project, overwrite: true });

    const loaded = loadTeamDefinition('parent-p', project)!;
    const teamNode = loaded.definition.nodes?.find((node) => node.type === 'team');
    expect(teamNode?.teamRef).toBe('parent-p-parallel');
    expect(teamNode?.targetRef).toEqual({ kind: 'team', name: 'parent-p-parallel' });

    const filePath = await saveTeamDefinition(loaded.definition, { projectDir: project, overwrite: true });
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as TeamDefinition;
    const rawNode = raw.nodes?.find((node) => node.type === 'team');
    expect(rawNode?.targetRef).toEqual({ kind: 'team', name: 'parent-p-parallel' });
    expect(rawNode?.teamRef).toBe('parent-p-parallel');
  });
});

// ── resolveTargetRef ────────────────────────────────────────────────

describe('resolveTargetRef', () => {
  function seededHome(): string {
    const home = tempHome();
    writeBridgeConfigs(home, [
      { name: 'cfg', runtime: 'claude', provider: 'anthropic', apiKey: '$MY_KEY', baseURL: 'https://api.example', model: 'm1' },
    ]);
    writeAgentProfiles(home, [
      { name: 'coder', bridgeConfig: 'cfg', model: 'm2' },
      { name: 'broken', bridgeConfig: 'nope', model: 'm3' },
    ]);
    return home;
  }

  it('expands a config-scoped model ref (apiKey passed through unresolved)', () => {
    const resolved = resolveTargetRef({ kind: 'model', config: 'cfg', model: 'm1' }, { homeDir: seededHome() });
    expect(resolved).toMatchObject({
      model: 'm1',
      provider: 'anthropic',
      baseURL: 'https://api.example',
      apiKey: '$MY_KEY',
    });
  });

  it('expands a raw model ref (config: "") to just the model', () => {
    const resolved = resolveTargetRef({ kind: 'model', config: '', model: 'raw-model' }, { homeDir: seededHome() });
    expect(resolved.model).toBe('raw-model');
    expect(resolved.provider).toBeUndefined();
  });

  it('expands an agent ref through its profile and bridge config', () => {
    const resolved = resolveTargetRef({ kind: 'agent', name: 'coder' }, { homeDir: seededHome() });
    expect(resolved).toMatchObject({ model: 'm2', provider: 'anthropic', baseURL: 'https://api.example', label: 'coder' });
  });

  it('throws BrokenReferenceError for a missing agent', () => {
    try {
      resolveTargetRef({ kind: 'agent', name: 'ghost' }, { homeDir: seededHome() });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BrokenReferenceError);
      expect((err as BrokenReferenceError).kind).toBe('agent');
      expect((err as BrokenReferenceError).targetName).toBe('ghost');
    }
  });

  it('throws BrokenReferenceError for a missing config (direct and via agent)', () => {
    const home = seededHome();
    try {
      resolveTargetRef({ kind: 'model', config: 'nope', model: 'm' }, { homeDir: home });
      expect.unreachable();
    } catch (err) {
      expect((err as BrokenReferenceError).kind).toBe('config');
      expect((err as BrokenReferenceError).targetName).toBe('nope');
    }
    try {
      resolveTargetRef({ kind: 'agent', name: 'broken' }, { homeDir: home });
      expect.unreachable();
    } catch (err) {
      expect((err as BrokenReferenceError).kind).toBe('config');
      expect((err as BrokenReferenceError).targetName).toBe('nope');
    }
  });

  it('validates team refs against the provided team names', () => {
    expect(resolveTargetRef({ kind: 'team', name: 't1' }, { teamNames: ['t1'] }).label).toBe('team:t1');
    expect(() => resolveTargetRef({ kind: 'team', name: 'ghost' }, { teamNames: ['t1'] }))
      .toThrowError(BrokenReferenceError);
  });
});
