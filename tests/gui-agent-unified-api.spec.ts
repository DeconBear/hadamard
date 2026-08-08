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
