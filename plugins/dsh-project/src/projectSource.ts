import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import type { SessionSummary, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import { encodeHadamardProjectPath } from '../../../src/config/projectSessionDirectory.js';
import { createProjectReader, readProjectIssueSnapshot } from '../../../src/project/projectReader.js';
import { createProjectIssue, transitionProjectIssue, updateProjectIssue, isIssueStatus, type IssueStatus } from '../../../src/issues/issueStore.js';
import type { Config } from './index.js';

export interface BoardTask {
  id: string;
  number: number;
  title: string;
  description: string;
  prompt: string;
  status: IssueStatus;
  parentId?: string;
  updatedAt: number;
  dispatchError?: string;
  executions: { sessionId: string; endedAt?: number; error?: string }[];
}
export interface RunningSession { id: string; title: string; updatedAt: number }
export interface DiscoveredProject {
  id: string;
  name: string;
  path: string;
  workspaceIds: string[];
  running: RunningSession[];
  taskCount: number | null;
  issueError?: string;
}
export interface ProjectCatalog {
  projects: DiscoveredProject[];
  discoveryAvailable: boolean;
}
export interface ProjectBoard {
  canRun: boolean;
  tasks: BoardTask[];
  sessions: RunningSession[];
}

export function createProjectSource(ctx: Context, config: Config & { homeDir: string }) {
  let workspaces: Pick<WorkspaceRegistry, 'list'> | undefined;
  let sessions: Pick<Context['sessionController'], 'list' | 'create' | 'prompt'> | undefined;
  ctx.inject(['workspaceRegistry'], child => {
    workspaces = child.workspaceRegistry;
    child.effect(() => () => { workspaces = undefined; });
  });
  ctx.inject(['sessionController'], child => {
    sessions = child.sessionController;
    child.effect(() => () => { sessions = undefined; });
  });

  async function discover(signal: AbortSignal) {
    signal.throwIfAborted();
    const workspaceList = workspaces?.list() ?? [];
    const roster = sessions ? (await sessions.list({}, signal)).items : [];
    signal.throwIfAborted();
    const projects = new Map<string, DiscoveredProject>();
    const bySession = new Map<string, string>();
    const add = (cwd: string, title?: string) => {
      if (!path.isAbsolute(cwd)) return undefined;
      const id = encodeHadamardProjectPath(cwd);
      let project = projects.get(id);
      if (!project) {
        project = { id, name: title || path.basename(cwd) || cwd, path: path.resolve(cwd), workspaceIds: [], running: [], taskCount: null };
        projects.set(id, project);
      }
      return project;
    };
    for (const workspace of workspaceList) {
      const project = add(workspace.path, workspace.title);
      if (!project) continue;
      project.workspaceIds.push(workspace.id);
      for (const id of workspace.sessionIds) bySession.set(id, project.id);
    }
    if (config.workDir) add(config.workDir);
    for (const session of roster) {
      if (!session.cwd || !path.isAbsolute(session.cwd)) continue;
      const project = session.running ? add(session.cwd) : projects.get(encodeHadamardProjectPath(session.cwd));
      if (project) bySession.set(session.sessionId, project.id);
    }
    const rosterMap = new Map(roster.map(session => [session.sessionId as string, session]));
    function sessionProject(session: SessionSummary, seen = new Set<string>()): string | undefined {
      if (seen.has(session.sessionId)) return undefined;
      seen.add(session.sessionId);
      const direct = bySession.get(session.sessionId);
      if (direct) return direct;
      const parent = session.parentSessionId && rosterMap.get(session.parentSessionId);
      return parent ? sessionProject(parent, seen) : undefined;
    }
    for (const session of roster) {
      const projectId = sessionProject(session);
      if (projectId) bySession.set(session.sessionId, projectId);
      if (!session.running || !projectId) continue;
      const title = session.projections?.values.title;
      projects.get(projectId)!.running.push({
        id: session.sessionId, title: typeof title === 'string' && title.trim() ? title : `运行会话 ${session.sessionId.slice(0, 8)}`,
        updatedAt: session.updatedAt,
      });
    }
    return { projects, roster };
  }
  async function catalog(signal: AbortSignal): Promise<ProjectCatalog> {
    const { projects } = await discover(signal);
    await Promise.all([...projects.values()].map(async project => {
      try { project.taskCount = (await createProjectReader({ workDir: project.path, homeDir: config.homeDir }).listIssues()).length; }
      catch (error) { project.issueError = error instanceof Error ? error.message : '无法读取项目任务'; }
    }));
    return {
      projects: [...projects.values()].sort((a, b) => b.running.length - a.running.length || a.name.localeCompare(b.name)),
      discoveryAvailable: !!workspaces || !!sessions,
    };
  }
  async function resolve(projectId: unknown, signal: AbortSignal) {
    const { projects, roster } = await discover(signal);
    const project = typeof projectId === 'string' ? projects.get(projectId) : undefined;
    if (!project) throw new Error('项目已不在 DSH 中，请返回项目列表刷新。');
    return { project, roster, reader: createProjectReader({ workDir: project.path, homeDir: config.homeDir }) };
  }
  async function getBoard(projectId: unknown, signal: AbortSignal): Promise<ProjectBoard> {
    const { project, reader, roster } = await resolve(projectId, signal);
    const running = new Set(roster.filter(session => session.running).map(session => session.sessionId as string));
    const tasks = (await reader.listIssues()).map(issue => ({
      id: issue.id, number: issue.number, title: issue.title, description: issue.description,
      prompt: [issue.description, ...issue.acceptanceCriteria.map(item => `- ${item}`)].filter(Boolean).join('\n'),
      status: issue.status, parentId: issue.parentIssueId, updatedAt: Date.parse(issue.updatedAt),
      dispatchError: typeof issue.metadata.dshDispatchError === 'string' ? issue.metadata.dshDispatchError : undefined,
      executions: issue.sessionIds.map(sessionId => ({ sessionId,
        ...(running.has(sessionId) ? {} : { endedAt: Date.parse(issue.updatedAt) }),
        ...(issue.activeSessionId === sessionId && typeof issue.metadata.dshDispatchError === 'string' ? { error: issue.metadata.dshDispatchError } : {}),
      })),
    }));
    const linked = new Set(tasks.flatMap(task => task.executions.filter(run => run.endedAt === undefined).map(run => run.sessionId)));
    return { canRun: typeof sessions?.create === 'function' && typeof sessions?.prompt === 'function', tasks,
      sessions: project.running.filter(session => !linked.has(session.id)) };
  }

  // The shared JSON store is not transactional. Serialize this plugin's writes
  // per project, so double clicks or simultaneous UI actions cannot lose tasks.
  const writes = new Map<string, Promise<void>>();
  async function act(args: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    if (typeof args.requestId !== 'string' || !/^[\w-]{1,100}$/.test(args.requestId)) throw new Error('Invalid action request id.');
    const { project } = await resolve(args.projectId, signal);
    const previous = writes.get(project.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      const { storage, issues } = await readProjectIssueSnapshot({ workDir: project.path, homeDir: config.homeDir });
      if (args.kind === 'create') {
        if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 200 ||
            typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 20000) throw new Error('请填写任务标题和执行说明。');
        if (issues.some(issue => issue.metadata.dshCreateRequestId === args.requestId)) return;
        await createProjectIssue(project.path, config.homeDir, { title: args.title.trim(), description: args.prompt,
          status: 'todo', metadata: { dshCreateRequestId: args.requestId as string } }, storage);
        return;
      }
      const issue = issues.find(issue => issue.id === args.taskId);
      if (!issue) throw new Error('此任务不属于当前项目。');
      if (args.kind === 'run' && issue.metadata.dshRunRequestId === args.requestId) return;
      const roster = sessions ? (await sessions.list({}, signal)).items : [];
      const active = issue.activeSessionId && roster.some(session => session.sessionId === issue.activeSessionId && session.running);
      if (active) throw new Error('任务会话正在运行，请先在 DSH 中停止会话。');
      if (args.kind === 'move' && isIssueStatus(args.status)) {
        await transitionProjectIssue(project.path, config.homeDir, issue.id, args.status, 'user', storage);
        return;
      }
      if (args.kind !== 'run') throw new Error('Unsupported board action.');
      const controller = sessions;
      if (!controller?.create || !controller.prompt) throw new Error('DSH 会话执行服务尚未就绪。');
      if (issue.status !== 'todo') throw new Error('请先将任务移至「待开始」。');
      signal.throwIfAborted();
      const { sessionId } = await controller.create({ cwd: project.path });
      const metadata: Record<string, string | number | boolean> = { ...issue.metadata, dshRunRequestId: args.requestId as string };
      delete metadata.dshDispatchError;
      await updateProjectIssue(project.path, config.homeDir, issue.id, {
        sessionIds: [...new Set([...issue.sessionIds, sessionId])], activeSessionId: sessionId, metadata,
      }, storage);
      await transitionProjectIssue(project.path, config.homeDir, issue.id, 'in_progress', 'system', storage);
      try {
        await controller.prompt({ requestId: args.requestId as SessionRequestId, sessionId, mode: 'queue',
          content: [{ type: 'text', text: [`任务：${issue.title}`, issue.description,
            issue.acceptanceCriteria.length ? `验收标准：\n${issue.acceptanceCriteria.map(item => `- ${item}`).join('\n')}` : ''].filter(Boolean).join('\n\n') }],
        }, signal);
      } catch (error) {
        await transitionProjectIssue(project.path, config.homeDir, issue.id, 'todo', 'system', storage);
        await updateProjectIssue(project.path, config.homeDir, issue.id, { activeSessionId: null,
          metadata: { ...issue.metadata, dshDispatchError: error instanceof Error ? error.message : String(error) },
        }, storage);
        throw error;
      }
    });
    writes.set(project.id, next);
    try { await next; } finally { if (writes.get(project.id) === next) writes.delete(project.id); }
  }
  return { catalog, resolve, getBoard, act, homeDir: config.homeDir };
}
export type ProjectSource = ReturnType<typeof createProjectSource>;
