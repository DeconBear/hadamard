/**
 * P2 schema round-trips: AgentProfile execution fields, router
 * classificationPrompt + per-route effort/maxTokens + typed targets,
 * workflow node fields, and single-agent squad member fields.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  findAgentProfile,
  listSelectableAgents,
  upsertAgentProfile,
} from '../src/config/agentProfiles.js';
import {
  loadRouterProfile,
  saveRouterProfile,
} from '../src/router/modelRouter.js';
import {
  loadTeamDefinition,
  saveTeamDefinition,
} from '../src/team/teamDefinitions.js';
import type { TeamDefinition } from '../src/types.js';

const tempDirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hadamard-p2-schema-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedBridgeConfig(home: string): void {
  mkdirSync(path.join(home, '.hadamard'), { recursive: true });
  writeFileSync(
    path.join(home, '.hadamard', 'bridge-configs.json'),
    JSON.stringify({
      configs: [{ name: 'cfg', runtime: 'claude', provider: 'anthropic', model: 'm1', models: [{ name: 'm1' }, { name: 'm2' }] }],
    }),
    'utf-8',
  );
}

describe('AgentProfile execution fields (P2)', () => {
  it('round-trips allowedTools / workspaceAccess / maxIterations / timeoutMs', () => {
    const home = tempHome();
    seedBridgeConfig(home);
    upsertAgentProfile({
      name: 'coder',
      bridgeConfig: 'cfg',
      model: 'm1',
      allowedTools: ['Read', 'Grep', 'Bash'],
      workspaceAccess: 'full',
      maxIterations: 24,
      timeoutMs: 120000,
    }, home);
    const loaded = findAgentProfile('coder', home);
    expect(loaded?.allowedTools).toEqual(['Read', 'Grep', 'Bash']);
    expect(loaded?.workspaceAccess).toBe('full');
    expect(loaded?.maxIterations).toBe(24);
    expect(loaded?.timeoutMs).toBe(120000);
  });

  it('drops invalid values and omits empty tool lists', () => {
    const home = tempHome();
    seedBridgeConfig(home);
    upsertAgentProfile({
      name: 'lite',
      bridgeConfig: 'cfg',
      model: 'm1',
      allowedTools: [],
      workspaceAccess: 'rooftop' as never,
      maxIterations: -3,
      timeoutMs: 0,
    }, home);
    const loaded = findAgentProfile('lite', home);
    expect(loaded?.allowedTools).toBeUndefined();
    expect(loaded?.workspaceAccess).toBeUndefined();
    expect(loaded?.maxIterations).toBeUndefined();
    expect(loaded?.timeoutMs).toBeUndefined();
  });

  it('exposes maxIterations / timeoutMs on the selectable entry the run path consumes', () => {
    const home = tempHome();
    seedBridgeConfig(home);
    upsertAgentProfile({
      name: 'bounded',
      bridgeConfig: 'cfg',
      model: 'm1',
      maxIterations: 12,
      timeoutMs: 60000,
    }, home);
    const selectable = listSelectableAgents(home).find(agent => agent.name === 'bounded');
    expect(selectable?.source).toBe('profile');
    expect(selectable?.maxIterations).toBe(12);
    expect(selectable?.timeoutMs).toBe(60000);
  });
});

describe('router profile editor fields (P2)', () => {
  it('persists classificationPrompt, per-route effort/maxTokens, and typed targets', async () => {
    const home = tempHome();
    const filePath = await saveRouterProfile(
      {
        name: 'dispatch',
        routerModel: { model: 'lead' },
        routerModelTarget: { kind: 'model', config: 'leader-cfg', model: 'lead' },
        classificationPrompt: 'You are a strict dispatcher.',
        routes: [
          {
            role: 'coder',
            model: 'm1',
            when: 'coding',
            effort: 'high',
            maxTokens: 64000,
            target: { kind: 'agent', name: 'coder' },
          },
          {
            role: 'fast',
            model: 'm2',
            when: 'quick',
            target: { kind: 'model', config: 'cfg', model: 'm2' },
          },
        ],
        fallback: { model: 'm1' },
        fallbackTarget: { kind: 'agent', name: 'writer' },
      },
      { homeDir: home, overwrite: true },
    );
    expect(filePath).toContain('dispatch.json');

    const loaded = loadRouterProfile('dispatch', undefined, home)!;
    expect(loaded.profile.classificationPrompt).toBe('You are a strict dispatcher.');
    expect(loaded.profile.routerModelTarget).toEqual({ kind: 'model', config: 'leader-cfg', model: 'lead' });
    const [coder, fast] = loaded.profile.routes;
    expect(coder?.effort).toBe('high');
    expect(coder?.maxTokens).toBe(64000);
    expect(coder?.target).toEqual({ kind: 'agent', name: 'coder' });
    expect(fast?.target).toEqual({ kind: 'model', config: 'cfg', model: 'm2' });
    expect(loaded.profile.fallbackTarget).toEqual({ kind: 'agent', name: 'writer' });
    // legacy by-value fields remain alongside the typed targets
    expect(coder?.model).toBe('m1');
    expect(loaded.profile.fallback?.model).toBe('m1');
  });
});

describe('workflow node fields (P2)', () => {
  it('round-trips systemPrompt / allowedTools / limits / workspaceAccess / targetRef', async () => {
    const project = tempHome();
    const def: TeamDefinition = {
      name: 'wf',
      mode: 'graph',
      squadType: 'workflow',
      members: [],
      workflowTree: {
        id: 'root',
        type: 'agent',
        label: 'Step',
        prompt: 'do {{input}}',
        systemPrompt: 'You are careful.',
        allowedTools: ['Read', 'Grep'],
        timeoutMs: 60000,
        maxIterations: 8,
        workspaceAccess: 'full',
        targetRef: { kind: 'agent', name: 'coder' },
        children: [],
      },
    };
    await saveTeamDefinition(def, { projectDir: project, overwrite: true });
    const loaded = loadTeamDefinition('wf', project)!;
    const root = loaded.definition.workflowTree!;
    expect(root.systemPrompt).toBe('You are careful.');
    expect(root.allowedTools).toEqual(['Read', 'Grep']);
    expect(root.timeoutMs).toBe(60000);
    expect(root.maxIterations).toBe(8);
    expect(root.workspaceAccess).toBe('full');
    expect(root.targetRef).toEqual({ kind: 'agent', name: 'coder' });
  });
});

describe('single-agent squad member fields (P2)', () => {
  it('round-trips member targetRef / allowedTools', async () => {
    const project = tempHome();
    const def: TeamDefinition = {
      name: 'solo',
      mode: 'graph',
      squadType: 'agent',
      members: [
        {
          role: 'solo',
          model: 'm1',
          systemPrompt: 'Be brief.',
          workspaceAccess: 'full',
          allowedTools: ['Read', 'Bash'],
          targetRef: { kind: 'model', config: 'cfg', model: 'm2' },
        },
      ],
      timeoutMs: 45000,
      maxIterations: 6,
    };
    await saveTeamDefinition(def, { projectDir: project, overwrite: true });
    const loaded = loadTeamDefinition('solo', project)!;
    const member = loaded.definition.members[0]!;
    expect(member.allowedTools).toEqual(['Read', 'Bash']);
    expect(member.targetRef).toEqual({ kind: 'model', config: 'cfg', model: 'm2' });
    expect(member.workspaceAccess).toBe('full');
    expect(loaded.definition.timeoutMs).toBe(45000);
    expect(loaded.definition.maxIterations).toBe(6);
  });
});
