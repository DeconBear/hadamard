import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { initWorkspace, projectWorkspaceDir, workspaceInfo } from '../src/hcanvas/workspace.js';
import { listProjects, registerProject, removeProject } from '../src/hcanvas/projectRegistry.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('hcanvas project workspace', () => {
  it('registers initialized projects in the global registry', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-registered-'));
    roots.push(home, project);
    const previous = process.env.HCANVAS_HOME;
    process.env.HCANVAS_HOME = home;
    try {
      const record = await registerProject(project, 'Registered project');
      expect(record.name).toBe('Registered project');
      expect(record.projectPath).toBe(project);
      expect(record.workspacePath).toBe(projectWorkspaceDir(project));
      const listed = await listProjects();
      expect(listed.some(item => item.projectPath === project)).toBe(true);
      await removeProject(project);
      expect((await listProjects()).some(item => item.projectPath === project)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HCANVAS_HOME;
      else process.env.HCANVAS_HOME = previous;
    }
  });

  it('initializes .hcanvas with docs, exports, workspace metadata and CLI guide', async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-project-'));
    roots.push(project);
    const workspace = projectWorkspaceDir(project);
    const info = await initWorkspace(workspace, project);
    expect(info.workspace).toBe(workspace);
    expect(info.project).toBe(project);
    expect((await stat(path.join(workspace, 'docs'))).isDirectory()).toBe(true);
    expect((await stat(path.join(workspace, 'exports'))).isDirectory()).toBe(true);
    const guide = await readFile(info.guidePath, 'utf8');
    expect(guide).toContain('hcanvas context --json');
    expect(guide).toContain(project);
    const meta = JSON.parse(await readFile(path.join(workspace, 'workspace.json'), 'utf8')) as { schema: string; project: string };
    expect(meta.schema).toBe('hadamard-canvas-workspace/1');
    expect(meta.project).toBe(project);
    const readback = await workspaceInfo(workspace);
    expect(readback.project).toBe(project);
    expect(readback.guide).toContain('CLI guide');
  });
});