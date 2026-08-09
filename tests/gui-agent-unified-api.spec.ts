/**
 * S2 unified-agent GUI API: editor save with scope + subagent extras,
 * inherit-session-model agents, the definition prefill endpoint, and the
 * template library endpoints (§9.2).
 */
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startHadamardGuiServer } from '../src/gui/hadamardGui.js';
import { addBridgeConfig } from '../src/parity/bridgeConfigs.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type GuiServer = Awaited<ReturnType<typeof startHadamardGuiServer>>;

async function api<T>(
  server: GuiServer,
  requestPath: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server.url}${requestPath}`, {
    ...init,
    headers: {
      'x-hadamard-token': server.token,
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json() as T };
}

async function startServer(root: string): Promise<{ server: GuiServer; homeDir: string; workDir: string }> {
  const homeDir = path.join(root, 'home');
  const workDir = path.join(root, 'work');
  await mkdir(workDir, { recursive: true });
  addBridgeConfig({
    name: 'sdk-default',
    runtime: 'hadamard',
    provider: 'anthropic',
    model: 'claude-sonnet',
    models: [{ name: 'claude-sonnet' }],
  }, homeDir);
  const server = await startHadamardGuiServer({
    workDir,
    homeDir,
    host: '127.0.0.1',
    port: 45000 + Math.floor(Math.random() * 10000),
  });
  return { server, homeDir, workDir };
}

describe('GUI unified agent API (S2)', () => {
  it('saves a profile-backed agent with scope + subagent extras to the project agents dir', async () => {
    const root = await tempRoot('hadamard-gui-s2-save-');
    const { server, workDir } = await startServer(root);
    try {
      const saved = await api<{ ok: boolean; warnings: string[] }>(server, 'api/agent-profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'researcher',
          description: 'Researches topics read-only',
          bridgeConfig: 'sdk-default',
          model: 'claude-sonnet',
          scope: 'project',
          promptMode: 'replace',
          subagent: true,
          permissionMode: 'plan',
          effort: 'max',
          maxTokens: 8192,
          temperature: 0.6,
          topP: 0.9,
          allowedTools: ['Read', 'Grep'],
          workspaceAccess: 'full',
          maxIterations: 23,
          timeoutMs: 55000,
        }),
      });
      expect(saved.status).toBe(200);

      const md = await readFile(path.join(workDir, '.hadamard', 'agents', 'researcher.md'), 'utf8');
      for (const line of [
        'name: researcher',
        'description: Researches topics read-only',
        'bridgeConfig: sdk-default',
        'model: claude-sonnet',
        'promptMode: replace',
        'subagent: true',
        'permissionMode: plan',
        'effort: max',
        'maxTokens: 8192',
        'temperature: 0.6',
        'topP: 0.9',
        'tools: Read, Grep',
        'workspaceAccess: full',
        'maxIterations: 23',
        'timeoutMs: 55000',
      ]) {
        expect(md).toContain(line);
      }

      // The prefill endpoint returns the raw frontmatter + body + source.
      const definition = await api<{
        definition: { frontmatter: Record<string, string>; body: string; source: string };
      }>(server, 'api/agent-definition?name=researcher');
      expect(definition.status).toBe(200);
      expect(definition.body.definition.source).toBe('project');
      expect(definition.body.definition.frontmatter.promptMode).toBe('replace');
      expect(definition.body.definition.frontmatter.subagent).toBe('true');
    } finally {
      await server.close();
    }
  });

  it('saves an inherit-session-model agent as a pure .md (not a profile)', async () => {
    const root = await tempRoot('hadamard-gui-s2-inherit-');
    const { server, homeDir } = await startServer(root);
    try {
      const saved = await api<{
        ok: boolean;
        profile: unknown;
        state: { agentProfiles: Array<{ name: string }> };
      }>(server, 'api/agent-profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'follower',
          description: 'Follows the session model',
          bridgeConfig: '',
          model: '',
          subagent: false,
          promptMode: 'extend',
          systemPromptAppend: 'Extra instructions.',
          permissionMode: 'acceptEdits',
          effort: 'high',
          maxTokens: 4096,
          temperature: 0.25,
          topP: 0.8,
          allowedTools: ['Read', 'Grep'],
          workspaceAccess: 'workspace',
          maxIterations: 17,
          timeoutMs: 45000,
        }),
      });
      expect(saved.status).toBe(200);
      expect(saved.body.profile).toBeNull();
      // Not a profile → hidden from the composer picker (S1a compat rule).
      expect(saved.body.state.agentProfiles.some(p => p.name === 'follower')).toBe(false);

      const md = await readFile(path.join(homeDir, '.hadamard', 'agents', 'follower.md'), 'utf8');
      expect(md).not.toContain('bridgeConfig');
      expect(md).toContain('subagent: false');
      expect(md).toContain('permissionMode: acceptEdits');
      expect(md).toContain('effort: high');
      expect(md).toContain('maxTokens: 4096');
      expect(md).toContain('temperature: 0.25');
      expect(md).toContain('topP: 0.8');
      expect(md).toContain('tools: Read, Grep');
      expect(md).toContain('workspaceAccess: workspace');
      expect(md).toContain('maxIterations: 17');
      expect(md).toContain('timeoutMs: 45000');
      expect(md).toContain('Extra instructions.');
    } finally {
      await server.close();
    }
  });

  it('lists templates and instantiates one into the project scope, refusing duplicates', async () => {
    const root = await tempRoot('hadamard-gui-s2-template-');
    const { server, workDir } = await startServer(root);
    try {
      const listed = await api<{ templates: Array<{ name: string; description: string }> }>(
        server,
        'api/agent-templates',
      );
      expect(listed.status).toBe(200);
      expect(listed.body.templates.map(template => template.name).sort())
        .toEqual(['Plan', 'code-reviewer', 'debugger', 'verification']);

      const instantiated = await api<{ ok: boolean; filePath: string }>(
        server,
        'api/agent-templates/instantiate',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Plan', scope: 'project' }),
        },
      );
      expect(instantiated.status).toBe(200);
      const md = await readFile(path.join(workDir, '.hadamard', 'agents', 'Plan.md'), 'utf8');
      expect(md).toContain('name: Plan');
      expect(md).toContain('permissionMode: plan');
      expect(md).toContain('tools: Read, Glob, Grep, Bash, PowerShell, WebFetch, WebSearch');

      const duplicate = await api<{ error: string }>(server, 'api/agent-templates/instantiate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Plan', scope: 'project' }),
      });
      expect(duplicate.status).toBeGreaterThanOrEqual(400);
      expect(String(duplicate.body.error)).toContain('already exists');

      // The instantiated agent appears in the fresh definition listing immediately.
      const definition = await api<{
        definition: { frontmatter: Record<string, string>; source: string };
      }>(server, 'api/agent-definition?name=Plan');
      expect(definition.status).toBe(200);
      expect(definition.body.definition.source).toBe('project');
    } finally {
      await server.close();
    }
  });

  it('deletes a project-scoped agent definition', async () => {
    const root = await tempRoot('hadamard-gui-s2-delete-');
    const { server, workDir } = await startServer(root);
    try {
      await api(server, 'api/agent-templates/instantiate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'debugger', scope: 'project' }),
      });
      const filePath = path.join(workDir, '.hadamard', 'agents', 'debugger.md');
      expect((await stat(filePath)).isFile()).toBe(true);

      const deleted = await api<{ ok?: boolean }>(server, 'api/agent-profiles/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'debugger', strategy: { type: 'leave' }, scope: 'project' }),
      });
      expect(deleted.status).toBe(200);
      await expect(stat(filePath)).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});

describe('reference index over the unified store (S3)', () => {
  it('pure .md agents emit config edges and count as known agent targets', async () => {
    const root = await tempRoot('hadamard-gui-s3-refs-');
    const { server, homeDir, workDir } = await startServer(root);
    try {
      // A definition with bridgeConfig but no model (config-default model) in
      // the project scope — invisible to the composer view, visible to refs.
      await mkdir(path.join(workDir, '.hadamard', 'agents'), { recursive: true });
      await import('node:fs/promises').then(fs => fs.writeFile(
        path.join(workDir, '.hadamard', 'agents', 'mdref.md'),
        ['---', 'name: mdref', 'description: ref agent', 'bridgeConfig: sdk-default', '---', '', 'Body.', ''].join('\n'),
        'utf-8',
      ));
      await mkdir(path.join(workDir, '.hadamard', 'routers'), { recursive: true });
      await import('node:fs/promises').then(fs => fs.writeFile(
        path.join(workDir, '.hadamard', 'routers', 'r.json'),
        JSON.stringify({
          name: 'r',
          routerModel: { model: 'lead' },
          routes: [{ model: 'm1', when: 'a', target: { kind: 'agent', name: 'mdref' } }],
        }),
        'utf-8',
      ));

      const usages = await api<{
        edges: Array<{ from: { kind: string; name: string }; to: { kind: string; name: string } }>;
      }>(server, 'api/references?kind=config&name=sdk-default');
      expect(usages.status).toBe(200);
      expect(usages.body.edges.some(edge => edge.from.kind === 'agent' && edge.from.name === 'mdref')).toBe(true);

      const broken = await api<{
        edges: Array<{ to: { kind: string; name: string } }>;
      }>(server, 'api/references/broken');
      expect(broken.status).toBe(200);
      // The router's agent target resolves against the .md known-set.
      expect(broken.body.edges.some(edge => edge.to.kind === 'agent' && edge.to.name === 'mdref')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('state.agentDefinitions surfaces inherit + main-chat agents; agentProfiles stays profile-only', async () => {
    const root = await tempRoot('hadamard-gui-s3-list-');
    // The definition lists are credential-gated (needsCredentials); a dummy key
    // unlocks them without any network access.
    const previousKey = process.env.HADAMARD_API_KEY;
    const previousModel = process.env.HADAMARD_MODEL;
    process.env.HADAMARD_API_KEY = 'test-key';
    process.env.HADAMARD_MODEL = 'test-model';
    const { server } = await startServer(root);
    try {
      const saved = await api<{
        state: {
          agentProfiles: Array<{ name: string }>;
          agents: Array<{ name: string; subagent?: boolean }>;
          agentDefinitions: Array<{ name: string; subagent?: boolean; bridgeConfig?: string }>;
        };
      }>(server, 'api/agent-profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'chat-only',
          description: 'Main-chat inherit agent',
          bridgeConfig: '',
          model: '',
          subagent: false,
          systemPromptAppend: 'x',
        }),
      });
      expect(saved.status).toBe(200);
      const { agentProfiles, agents, agentDefinitions } = saved.body.state;
      expect(agentProfiles.some(profile => profile.name === 'chat-only')).toBe(false);
      // Delegatable list (drawer) excludes main-chat-only agents…
      expect(agents.some(def => def.name === 'chat-only')).toBe(false);
      // …while the unified panel list surfaces them with their badges.
      const chatOnly = agentDefinitions.find(def => def.name === 'chat-only');
      expect(chatOnly).toMatchObject({ subagent: false });
      expect(chatOnly?.bridgeConfig).toBeUndefined();
    } finally {
      await server.close();
      if (previousKey === undefined) delete process.env.HADAMARD_API_KEY;
      else process.env.HADAMARD_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.HADAMARD_MODEL;
      else process.env.HADAMARD_MODEL = previousModel;
    }
  });
});

describe('team save location inference (save-to UI removal, 09 Aug 2026)', () => {
  const graphDef = (name: string) => ({
    name,
    mode: 'graph',
    version: 3,
    orchestration: 'graph',
    squadType: 'graph',
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
  });

  it('saves new squads to personal, preserves an existing project squad location, honors explicit target', async () => {
    const root = await tempRoot('hadamard-gui-team-save-');
    const { server, homeDir, workDir } = await startServer(root);
    const post = (definition: unknown, target?: string) => api<{ ok: boolean; filePath: string; target: string }>(
      server,
      'api/team/save',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(target ? { definition, target } : { definition }),
      },
    );
    try {
      // New squad without target → personal.
      const fresh = await post(graphDef('fresh-squad'));
      expect(fresh.status).toBe(200);
      expect(fresh.body.target).toBe('personal');
      expect(fresh.body.filePath).toContain(path.join('.hadamard', 'teams'));
      expect(fresh.body.filePath.startsWith(path.join(homeDir, '.hadamard'))).toBe(true);

      // A squad already living in the project dir keeps its location.
      await mkdir(path.join(workDir, '.hadamard', 'teams'), { recursive: true });
      const projectFile = path.join(workDir, '.hadamard', 'teams', 'proj-squad.json');
      await import('node:fs/promises').then(fs => fs.writeFile(
        projectFile,
        JSON.stringify(graphDef('proj-squad')),
        'utf-8',
      ));
      const preserved = await post(graphDef('proj-squad'));
      expect(preserved.status).toBe(200);
      expect(preserved.body.target).toBe('project');
      expect(preserved.body.filePath).toBe(projectFile);
      // …and no personal shadow file was created for it.
      await expect(stat(path.join(homeDir, '.hadamard', 'teams', 'proj-squad.json'))).rejects.toThrow();

      // Explicit target still works (server param retained).
      const explicit = await post(graphDef('explicit-squad'), 'project');
      expect(explicit.status).toBe(200);
      expect(explicit.body.target).toBe('project');
      expect(explicit.body.filePath).toContain(path.join(workDir, '.hadamard', 'teams'));
    } finally {
      await server.close();
    }
  });
});

describe('legacy squad convert-on-save (09 Aug 2026)', () => {
  it('writes the .md agent, removes the squad json, and rewires teamRef to kind agent', async () => {
    const root = await tempRoot('hadamard-gui-convert-');
    const { server, homeDir, workDir } = await startServer(root);
    try {
      // Legacy single-agent squad in the personal teams dir…
      await mkdir(path.join(homeDir, '.hadamard', 'teams'), { recursive: true });
      await import('node:fs/promises').then(fs => fs.writeFile(
        path.join(homeDir, '.hadamard', 'teams', 'legacy-squad.json'),
        JSON.stringify({
          name: 'legacy-squad',
          mode: 'graph',
          squadType: 'agent',
          members: [{ role: 'legacy-squad', model: '', systemPrompt: 'Legacy prompt.' }],
        }),
        'utf-8',
      ));
      // …referenced by a graph squad via a teamRef node.
      await mkdir(path.join(workDir, '.hadamard', 'teams'), { recursive: true });
      const refFile = path.join(workDir, '.hadamard', 'teams', 'parent.json');
      await import('node:fs/promises').then(fs => fs.writeFile(
        refFile,
        JSON.stringify({
          name: 'parent',
          mode: 'graph',
          squadType: 'graph',
          members: [],
          nodes: [{ id: 'sub', type: 'team', teamRef: 'legacy-squad' }],
          edges: [],
        }),
        'utf-8',
      ));

      const saved = await api<{ ok: boolean; conversion: string[] }>(server, 'api/agent-profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'legacy-squad',
          description: 'Converted agent',
          bridgeConfig: '',
          model: '',
          subagent: true,
          promptMode: 'extend',
          systemPromptAppend: 'Converted prompt.',
          convertFromSquad: 'legacy-squad',
        }),
      });
      expect(saved.status).toBe(200);
      expect(saved.body.conversion.length).toBeGreaterThan(0);

      // .md written; squad json removed.
      const md = await readFile(path.join(homeDir, '.hadamard', 'agents', 'legacy-squad.md'), 'utf8');
      expect(md).toContain('name: legacy-squad');
      expect(md).toContain('Converted prompt.');
      await expect(stat(path.join(homeDir, '.hadamard', 'teams', 'legacy-squad.json'))).rejects.toThrow();

      // Referencing graph node now points at the agent.
      const parent = JSON.parse(await readFile(refFile, 'utf8'));
      expect(parent.nodes[0].targetRef).toEqual({ kind: 'agent', name: 'legacy-squad' });
      expect(parent.nodes[0].teamRef).toBeUndefined();
      expect(parent.nodes[0].type).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('converting a built-in squad writes the .md shadow without touching the built-in', async () => {
    const root = await tempRoot('hadamard-gui-convert-builtin-');
    const { server, homeDir } = await startServer(root);
    try {
      const saved = await api<{ ok: boolean; conversion: string[] }>(server, 'api/agent-profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'reviewer',
          description: 'Custom reviewer',
          bridgeConfig: '',
          model: '',
          subagent: true,
          systemPromptAppend: 'My reviewer prompt.',
          convertFromSquad: 'reviewer',
        }),
      });
      expect(saved.status).toBe(200);
      const md = await readFile(path.join(homeDir, '.hadamard', 'agents', 'reviewer.md'), 'utf8');
      expect(md).toContain('name: reviewer');
      expect(md).toContain('My reviewer prompt.');
      // No squad file deletion attempted for built-ins (nothing on disk to remove).
      expect(saved.body.conversion.every(entry => !entry.includes('deleted'))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('derives runtime from the selected CLI configuration (no Agent UI Runtime field)', async () => {
    const root = await tempRoot('hadamard-gui-runtime-from-config-');
    const { server, homeDir } = await startServer(root);
    try {
      addBridgeConfig({
        name: 'claude-cli',
        runtime: 'claude',
        execution: 'cli',
        provider: 'anthropic',
        model: 'claude-sonnet',
        models: [{ name: 'claude-sonnet' }],
      }, homeDir);

      const saved = await api<{ ok: boolean }>(server, 'api/agent-profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'cli-coder',
          description: 'Delegates to Claude CLI via Settings config',
          bridgeConfig: 'claude-cli',
          model: 'claude-sonnet',
          subagent: true,
          // body.runtime intentionally omitted — Agent UI no longer sends it
        }),
      });
      expect(saved.status).toBe(200);
      const md = await readFile(path.join(homeDir, '.hadamard', 'agents', 'cli-coder.md'), 'utf8');
      expect(md).toContain('bridgeConfig: claude-cli');
      expect(md).toContain('runtime: claude');

      // Switching to an in-process hadamard config clears derived runtime.
      const resaved = await api<{ ok: boolean }>(server, 'api/agent-profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'cli-coder',
          description: 'Now uses SDK config',
          bridgeConfig: 'sdk-default',
          model: 'claude-sonnet',
          subagent: true,
        }),
      });
      expect(resaved.status).toBe(200);
      const md2 = await readFile(path.join(homeDir, '.hadamard', 'agents', 'cli-coder.md'), 'utf8');
      expect(md2).toContain('bridgeConfig: sdk-default');
      expect(md2).not.toMatch(/^runtime:/m);
    } finally {
      await server.close();
    }
  });
});
