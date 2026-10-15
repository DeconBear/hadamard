import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools';
import { ISSUE_PRIORITIES, ISSUE_STATUSES, ISSUE_STORAGE_MODES } from '../../../src/issues/issueStore.js';
import { PROJECT_STATUSES } from '../../../src/project/projectMeta.js';

const strings = { type: 'array', items: { type: 'string' }, required: true } as const;
const text = { type: 'string', required: true } as const;

export const projectSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: text,
    path: text,
    name: text,
    status: { type: 'string', enum: PROJECT_STATUSES, required: true },
    issueStorage: { type: 'string', enum: ISSUE_STORAGE_MODES, required: true },
    issueCounts: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        total: { type: 'integer', required: true },
        open: { type: 'integer', required: true },
        review: { type: 'integer', required: true },
        closed: { type: 'integer', required: true },
      },
    },
    updatedAt: { type: 'string' },
  },
} as const satisfies ValueSchemaSpec;

/** Preserve the existing issue record, including acceptance criteria and history. */
export const issueSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'integer', const: 1, required: true },
    id: text,
    number: { type: 'integer', required: true },
    title: text,
    description: text,
    status: { type: 'string', enum: ISSUE_STATUSES, required: true },
    priority: { type: 'string', enum: ISSUE_PRIORITIES, required: true },
    labels: strings,
    acceptanceCriteria: strings,
    parentIssueId: { type: 'string' },
    createdBy: { type: 'string', enum: ['user', 'manager'], required: true },
    createdAt: text,
    updatedAt: text,
    startedAt: { type: 'string' },
    completedAt: { type: 'string' },
    agentConfig: { type: 'string' },
    brief: { type: 'string' },
    sessionIds: strings,
    activeSessionId: { type: 'string' },
    comments: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: text,
          kind: { type: 'string', enum: ['comment', 'status_change', 'progress', 'system'], required: true },
          actor: { type: 'string', enum: ['user', 'manager', 'agent', 'system'], required: true },
          body: text,
          createdAt: text,
          fromStatus: { type: 'string', enum: ISSUE_STATUSES },
          toStatus: { type: 'string', enum: ISSUE_STATUSES },
        },
      },
    },
    metadata: { type: 'object', additionalProperties: true, required: true },
  },
} as const satisfies ValueSchemaSpec;

export const issuePageSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    issues: {
      type: 'array', required: true,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: text,
          number: { type: 'integer', required: true },
          title: text,
          status: { type: 'string', enum: ISSUE_STATUSES, required: true },
          priority: { type: 'string', enum: ISSUE_PRIORITIES, required: true },
          acceptanceCriteria: strings,
        },
      },
    },
    total: { type: 'integer', required: true },
    offset: { type: 'integer', required: true },
    limit: { type: 'integer', required: true },
    nextOffset: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
    truncated: { type: 'boolean', required: true },
  },
} as const satisfies ValueSchemaSpec;
