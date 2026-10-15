import path from 'node:path';

import { encodeHadamardProjectPath } from '../config/projectSessionDirectory.js';
import {
  listProjectIssues,
  type IssueStorageMode,
  type ProjectIssue,
} from '../issues/issueStore.js';
import { readProjectMeta, type ProjectStatus } from './projectMeta.js';

export interface ProjectReadScope {
  /** Fixed workspace selected by the host, never supplied by a model tool call. */
  workDir: string;
  /** Same OS home or data-root input accepted by Hadamard's existing stores. */
  homeDir: string;
}

export interface ProjectIssueCounts {
  total: number;
  open: number;
  review: number;
  closed: number;
}

export interface ProjectSnapshot {
  /** Existing path-derived storage identity; relocating the workspace changes it. */
  id: string;
  path: string;
  name: string;
  status: ProjectStatus;
  issueStorage: IssueStorageMode;
  issueCounts: ProjectIssueCounts;
  updatedAt?: string;
}

export interface ProjectReader {
  getProject(): Promise<ProjectSnapshot>;
  listIssues(): Promise<ProjectIssue[]>;
  getIssue(idOrNumber: string | number): Promise<ProjectIssue | null>;
}

export function countProjectIssues(issues: readonly ProjectIssue[]): ProjectIssueCounts {
  const closed = issues.filter(issue => issue.status === 'done' || issue.status === 'cancelled').length;
  return {
    total: issues.length,
    open: issues.length - closed,
    review: issues.filter(issue => issue.status === 'in_review').length,
    closed,
  };
}

/** Resolve metadata and read the selected store once, without side effects. */
export async function readProjectIssueSnapshot(scope: ProjectReadScope): Promise<{
  storage: IssueStorageMode;
  issues: ProjectIssue[];
}> {
  const meta = await readProjectMeta(scope.workDir, scope.homeDir);
  const storage = meta.issueStorage ?? 'home';
  return { storage, issues: await listProjectIssues(scope.workDir, scope.homeDir, storage) };
}

/**
 * Read-only host-independent facade over the existing project stores.
 * Does not create, migrate, dispatch, or repair anything. Storage selection is
 * reloaded on every operation, so a host-side change is visible without restart.
 * Legacy JSON storage is not transactional: a result is not a cross-file snapshot.
 */
export function createProjectReader(scope: ProjectReadScope): ProjectReader {
  if (!scope.workDir?.trim() || !scope.homeDir?.trim()) {
    throw new Error('Project reader requires explicit workDir and homeDir');
  }
  const workDir = path.resolve(scope.workDir);
  const homeDir = path.resolve(scope.homeDir);
  const listIssues = async (): Promise<ProjectIssue[]> => {
    return (await readProjectIssueSnapshot({ workDir, homeDir })).issues;
  };
  return {
    async getProject() {
      const meta = await readProjectMeta(workDir, homeDir);
      const issueStorage = meta.issueStorage ?? 'home';
      const issues = await listProjectIssues(workDir, homeDir, issueStorage);
      return {
        id: encodeHadamardProjectPath(workDir),
        path: workDir,
        name: path.basename(workDir) || workDir,
        status: meta.status,
        issueStorage,
        issueCounts: countProjectIssues(issues),
        ...(meta.updatedAt ? { updatedAt: meta.updatedAt } : {}),
      };
    },
    listIssues,
    async getIssue(idOrNumber) {
      if (typeof idOrNumber === 'number' && (!Number.isSafeInteger(idOrNumber) || idOrNumber < 1)) {
        throw new Error('Issue number must be a positive safe integer');
      }
      if (typeof idOrNumber === 'string' && !idOrNumber.trim()) {
        throw new Error('Issue identifier must not be empty');
      }
      const issues = await listIssues();
      return issues.find(issue => typeof idOrNumber === 'number'
        ? issue.number === idOrNumber
        : issue.id === idOrNumber || String(issue.number) === idOrNumber ||
          `ISS-${issue.number}` === idOrNumber.toUpperCase()) ?? null;
    },
  };
}
