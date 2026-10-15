// Read-only source entry point for host adapters.
export { createProjectReader, countProjectIssues, readProjectIssueSnapshot } from './projectReader.js';
export type { ProjectReader, ProjectReadScope, ProjectSnapshot, ProjectIssueCounts } from './projectReader.js';
export type { ProjectIssue, IssueStatus, IssueStorageMode } from '../issues/issueStore.js';
export type { ProjectMeta, ProjectStatus } from './projectMeta.js';
