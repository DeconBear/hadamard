import { access } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { getHadamardProjectSessionDirectory } from '../config/projectSessionDirectory.js';
import { isProjectStatus, readProjectMeta, writeProjectMeta } from '../gui/projectMeta.js';
import { readWorkspaceNote, writeWorkspaceNote } from '../gui/workspaceNote.js';
import { readWorkspaceRegistry } from '../gui/workspaceRegistry.js';
import { isIssueStorageMode, listProjectIssues, type IssueStorageMode } from '../issues/issueStore.js';
import { isRecord } from '../runtime/helpers.js';
import { tool } from '../runtime/tools.js';
import type { AgentToolDefinition } from '../types.js';
import { readDesignFile, readProjectPlanFile } from './projectManager.js';

export interface AssistantProjectBrief {
  name: string;
  path: string;
  note: string;
  status: string;
  sessionCount: number;
  issueCounts: { total: number; open: number; review: number; closed: number };
  active: boolean;
  pinned: boolean;
  lastUsedAt: string;
}

export interface AssistantProjectToolContext {
  homeDir: string;
  currentWorkDir: string;
  getAppState?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  getEditorContext?: () => unknown | Promise<unknown>;
  openProject?: (projectPath: string) => Promise<{ workDir: string }>;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function redactEditorContext(context: unknown): unknown {
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact);
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(apiKey|password|secret|accessToken|refreshToken)$/i.test(key)) {
        out[`${key}Configured`] = Boolean(typeof item === 'string' ? item.trim() : item);
      } else {
        out[key] = redact(item);
      }
    }
    return out;
  };
  return context == null ? null : redact(context);
}

export async function listAssistantProjectBriefs(
  homeDir: string,
  currentWorkDir: string,
): Promise<AssistantProjectBrief[]> {
  const current = path.resolve(currentWorkDir);
  const byPath = new Map<string, AssistantProjectBrief>();
  const add = (projectPath: string, pinned = false, lastUsedAt = '') => {
    const resolved = path.resolve(projectPath);
    const key = resolved.toLowerCase();
    const existing = byPath.get(key);
    byPath.set(key, {
      name: path.basename(resolved) || resolved,
      path: resolved,
      note: existing?.note ?? '',
      status: existing?.status ?? 'not_started',
      sessionCount: existing?.sessionCount ?? 0,
      issueCounts: existing?.issueCounts ?? { total: 0, open: 0, review: 0, closed: 0 },
      active: resolved.toLowerCase() === current.toLowerCase(),
      pinned: Boolean(existing?.pinned || pinned),
      lastUsedAt: existing?.lastUsedAt && existing.lastUsedAt > lastUsedAt
        ? existing.lastUsedAt
        : lastUsedAt,
    });
  };
  add(current);
  const registry = await readWorkspaceRegistry(homeDir);
  for (const entry of registry) {
    if (!(await pathExists(entry.path))) continue;
    add(entry.path, entry.pinned === true, entry.lastOpenedAt || '');
  }
  const rows = [...byPath.values()];
  await Promise.all(rows.map(async project => {
    const [note, meta] = await Promise.all([
      readWorkspaceNote(project.path, homeDir),
      readProjectMeta(project.path, homeDir),
    ]);
    project.note = note;
    project.status = meta.status;
    const storage: IssueStorageMode = isIssueStorageMode(meta.issueStorage) ? meta.issueStorage : 'home';
    const issues = await listProjectIssues(project.path, homeDir, storage).catch(() => []);
    project.issueCounts = {
      total: issues.length,
      open: issues.filter(issue => issue.status !== 'done' && issue.status !== 'cancelled').length,
      review: issues.filter(issue => issue.status === 'in_review').length,
      closed: issues.filter(issue => issue.status === 'done' || issue.status === 'cancelled').length,
    };
  }));
  return rows.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.lastUsedAt || '').localeCompare(a.lastUsedAt || '');
  });
}

export async function assertAssistantKnownProject(
  homeDir: string,
  currentWorkDir: string,
  projectPath: string,
): Promise<string> {
  const resolved = path.resolve(projectPath);
  if (!(await pathExists(resolved))) throw new Error(`Project path does not exist: ${resolved}`);
  const briefs = await listAssistantProjectBriefs(homeDir, currentWorkDir);
  const known = briefs.some(item => path.resolve(item.path).toLowerCase() === resolved.toLowerCase());
  if (!known) {
    throw new Error(`Unknown project path: ${resolved}. Use ListProjects and pass a registered workspace path.`);
  }
  return resolved;
}

export function createAssistantProjectTools(
  context: AssistantProjectToolContext,
): AgentToolDefinition[] {
  const assertKnown = (projectPath: string) => assertAssistantKnownProject(
    context.homeDir,
    context.currentWorkDir,
    projectPath,
  );

  const listProjects = tool(
    {
      name: 'ListProjects',
      description: 'List remembered Hadamard workspaces with brief note, status, and issue counts.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    },
    async () => ({
      currentWorkDir: context.currentWorkDir,
      projects: await listAssistantProjectBriefs(context.homeDir, context.currentWorkDir),
    }),
  );

  const overview = tool(
    {
      name: 'GetProjectOverview',
      description: 'Get a compact overview for one registered project (note, status, plan/Design summaries, issues).',
      inputSchema: z.strictObject({ projectPath: z.string().describe('Absolute workspace path from ListProjects') }),
      isReadOnly: () => true,
    },
    async input => {
      const projectPath = await assertKnown(input.projectPath);
      const [note, meta, plan, design] = await Promise.all([
        readWorkspaceNote(projectPath, context.homeDir),
        readProjectMeta(projectPath, context.homeDir),
        readProjectPlanFile(projectPath, context.homeDir),
        readDesignFile(projectPath, context.homeDir),
      ]);
      const storage: IssueStorageMode = isIssueStorageMode(meta.issueStorage) ? meta.issueStorage : 'home';
      const issues = await listProjectIssues(projectPath, context.homeDir, storage).catch(() => []);
      return {
        path: projectPath,
        name: path.basename(projectPath),
        note,
        status: meta.status,
        plan: {
          milestones: plan.milestones.length,
          today: plan.today.length,
          upcoming: plan.upcoming.length,
          milestoneTitles: plan.milestones.slice(0, 8).map(item => item.title),
        },
        designChars: design?.length ?? 0,
        designPreview: design ? design.slice(0, 1200) : null,
        issueCounts: {
          total: issues.length,
          open: issues.filter(issue => issue.status !== 'done' && issue.status !== 'cancelled').length,
          review: issues.filter(issue => issue.status === 'in_review').length,
          closed: issues.filter(issue => issue.status === 'done' || issue.status === 'cancelled').length,
        },
        sessionDirectory: getHadamardProjectSessionDirectory(projectPath, context.homeDir),
      };
    },
  );

  const document = tool(
    {
      name: 'GetProjectDocument',
      description: 'Read full plan.json, DESIGN.md, or project note for a registered project.',
      inputSchema: z.strictObject({ projectPath: z.string(), kind: z.enum(['plan', 'design', 'progress', 'note']) }),
      isReadOnly: () => true,
    },
    async input => {
      const projectPath = await assertKnown(input.projectPath);
      if (input.kind === 'plan') return { kind: 'plan', content: await readProjectPlanFile(projectPath, context.homeDir) };
      if (input.kind === 'design' || input.kind === 'progress') {
        return { kind: 'design', content: await readDesignFile(projectPath, context.homeDir) };
      }
      return { kind: 'note', content: await readWorkspaceNote(projectPath, context.homeDir) };
    },
  );

  const issues = tool(
    {
      name: 'ListProjectIssues',
      description: 'List issues for a registered project.',
      inputSchema: z.strictObject({ projectPath: z.string() }),
      isReadOnly: () => true,
    },
    async input => {
      const projectPath = await assertKnown(input.projectPath);
      const meta = await readProjectMeta(projectPath, context.homeDir);
      const storage: IssueStorageMode = isIssueStorageMode(meta.issueStorage) ? meta.issueStorage : 'home';
      const rows = await listProjectIssues(projectPath, context.homeDir, storage);
      return {
        projectPath,
        issues: rows.map(issue => ({
          id: issue.id,
          key: `ISS-${issue.number}`,
          title: issue.title,
          status: issue.status,
          priority: issue.priority,
          agentConfig: issue.agentConfig ?? null,
          updatedAt: issue.updatedAt,
        })),
      };
    },
  );

  const appState = tool(
    {
      name: 'GetAppState',
      description: 'Get the current GUI focus (region, workDir, credentials flag). No secrets.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    },
    async () => ({
      currentWorkDir: context.currentWorkDir,
      homeDir: context.homeDir,
      ...(context.getAppState ? await context.getAppState() : {}),
    }),
  );

  const editorContext = tool(
    {
      name: 'GetCurrentEditorContext',
      description: 'Read the active GUI page/entity and its unsaved Agent, Router, Graph, or Workflow draft with a stable base digest. Use before proposing editor changes.',
      inputSchema: z.strictObject({}),
      isReadOnly: () => true,
    },
    async () => ({ context: redactEditorContext(context.getEditorContext ? await context.getEditorContext() : null) }),
  );

  const openProject = tool(
    {
      name: 'OpenProject',
      description: 'Switch the GUI to a registered workspace path.',
      inputSchema: z.strictObject({ projectPath: z.string() }),
    },
    async input => {
      if (!context.openProject) throw new Error('OpenProject is unavailable in this host.');
      const projectPath = await assertKnown(input.projectPath);
      const result = await context.openProject(projectPath);
      return { ok: true, workDir: result.workDir };
    },
  );

  const updateNote = tool(
    {
      name: 'UpdateProjectNote',
      description: 'Update the short workspace note shown on the project card.',
      inputSchema: z.strictObject({ projectPath: z.string(), content: z.string() }),
    },
    async input => {
      const projectPath = await assertKnown(input.projectPath);
      const saved = await writeWorkspaceNote(projectPath, context.homeDir, input.content);
      return { ok: true, path: saved };
    },
  );

  const updateStatus = tool(
    {
      name: 'UpdateProjectStatus',
      description: 'Update the manual project lifecycle status.',
      inputSchema: z.strictObject({
        projectPath: z.string(),
        status: z.enum(['in_progress', 'planning', 'on_hold', 'not_started', 'completed']),
      }),
    },
    async input => {
      const projectPath = await assertKnown(input.projectPath);
      if (!isProjectStatus(input.status)) throw new Error(`Invalid status: ${input.status}`);
      const meta = await writeProjectMeta(projectPath, context.homeDir, { status: input.status });
      return { ok: true, meta };
    },
  );

  return [
    listProjects,
    overview,
    document,
    issues,
    appState,
    editorContext,
    openProject,
    updateNote,
    updateStatus,
  ];
}
