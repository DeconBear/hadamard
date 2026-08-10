import type {
  IssueStatus,
  IssueStorageMode,
  ProjectIssue,
} from '../issues/issueStore.js';
import { A } from './ansi.js';
import { formatErrorLine, formatInfoLine } from './transcript.js';

export interface TuiIssueServicePort {
  storage(): Promise<IssueStorageMode>;
  list(storage: IssueStorageMode): Promise<ProjectIssue[]>;
  create(title: string, storage: IssueStorageMode): Promise<ProjectIssue>;
  execute(
    issue: ProjectIssue,
    agentProfile: string | undefined,
    storage: IssueStorageMode,
  ): Promise<{ issue: ProjectIssue; sessionId: string; text?: string }>;
  transition(
    id: string,
    status: IssueStatus,
    storage: IssueStorageMode,
  ): Promise<ProjectIssue | undefined>;
}

export interface TuiIssueCommandPort {
  issues: TuiIssueServicePort;
  appendStatic(lines: readonly string[]): void;
}

function findIssue(issues: ProjectIssue[], rawId: string | undefined): ProjectIssue | undefined {
  const id = rawId?.replace(/^#/u, '');
  return issues.find(issue =>
    issue.id === id
    || String(issue.number) === id
    || `ISS-${issue.number}` === id?.toUpperCase(),
  );
}

export async function runTuiIssueCommand(
  name: string,
  args: string,
  port: TuiIssueCommandPort,
): Promise<boolean> {
  if (name !== 'issues') return false;

  const storage = await port.issues.storage();
  if (!args || args === 'list') {
    const issues = await port.issues.list(storage);
    if (issues.length === 0) {
      port.appendStatic([...formatInfoLine('no issues yet; use /issues create <title>'), '']);
      return true;
    }
    port.appendStatic([
      `${A.cyan}Issues (${storage})${A.reset}`,
      ...issues.map(issue => `#${issue.number} ${issue.title} ${A.dim}${issue.status} · ${issue.priority}${A.reset}`),
      '',
    ]);
    return true;
  }
  if (args.startsWith('create ')) {
    const title = args.slice(7).trim();
    if (!title) {
      port.appendStatic([...formatErrorLine('usage: /issues create <title>'), '']);
      return true;
    }
    const issue = await port.issues.create(title, storage);
    port.appendStatic([...formatInfoLine(`issue created: #${issue.number} ${issue.title}`), '']);
    return true;
  }
  if (args.startsWith('show ')) {
    const rawId = args.slice(5).trim();
    const issue = findIssue(await port.issues.list(storage), rawId);
    if (!issue) {
      port.appendStatic([...formatErrorLine(`issue not found: ${rawId.replace(/^#/u, '')}`), '']);
      return true;
    }
    port.appendStatic([
      `${A.bold}ISS-${issue.number} ${issue.title}${A.reset}`,
      `${A.dim}${issue.status} · ${issue.priority}${A.reset}`,
      issue.description || '(no description)',
      ...(issue.acceptanceCriteria.length
        ? ['', 'Acceptance criteria:', ...issue.acceptanceCriteria.map(item => `- ${item}`)]
        : []),
      ...(issue.brief ? ['', 'Manager brief:', issue.brief] : []),
      '',
    ]);
    return true;
  }
  if (args.startsWith('start ')) {
    const [, rawId, agentProfile] = args.split(/\s+/u, 3);
    const issue = findIssue(await port.issues.list(storage), rawId);
    if (!issue) {
      port.appendStatic([...formatErrorLine(`issue not found: ${rawId ?? ''}`), '']);
      return true;
    }
    port.appendStatic([...formatInfoLine(`decomposing and dispatching ISS-${issue.number}...`), '']);
    const dispatched = await port.issues.execute(issue, agentProfile, storage);
    port.appendStatic([
      ...formatInfoLine(`ISS-${dispatched.issue.number}: ${dispatched.issue.status} · session ${dispatched.sessionId}`),
      ...(dispatched.text ? [dispatched.text] : []),
      '',
    ]);
    return true;
  }

  const transitions: Record<string, IssueStatus> = {
    review: 'in_review',
    done: 'done',
    block: 'blocked',
  };
  const [verb, rawId] = args.split(/\s+/u, 2);
  const nextStatus = transitions[verb ?? ''];
  if (nextStatus && rawId) {
    const issue = await port.issues.transition(rawId.replace(/^#/u, ''), nextStatus, storage);
    if (!issue) port.appendStatic([...formatErrorLine(`issue not found: ${rawId}`), '']);
    else port.appendStatic([...formatInfoLine(`issue #${issue.number}: ${issue.status}`), '']);
    return true;
  }
  port.appendStatic([...formatErrorLine('usage: /issues [list|show <id>|create <title>|start <id> [agent-profile]|review <id>|done <id>|block <id>]'), '']);
  return true;
}
