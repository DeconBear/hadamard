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
          allowedAgents: ['Explore'],
          skills: ['pdf'],
          memory: 'project',
          background: true,
          isolation: 'worktree',
          initialPrompt: 'Survey the repo first.',
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
        'allowedAgents: Explore',
        'skills: pdf',
        'memory: project',
        'background: true',
        'isolation: worktree',
        'initialPrompt: Survey the repo first.',
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
      expect(definition.body.definition.frontmatter.allowedAgents).toBe('Explore');
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
        }),
      });
      expect(saved.status).toBe(200);
      expect(saved.body.profile).toBeNull();
      // Not a profile → hidden from the composer picker (S1a compat rule).
      expect(saved.body.state.agentProfiles.some(p => p.name === 'follower')).toBe(false);

      const md = await readFile(path.join(homeDir, '.hadamard', 'agents', 'follower.md'), 'utf8');
      expect(md).not.toContain('bridgeConfig');
      expect(md).toContain('subagent: false');
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
