import { describe, expect, it, vi } from 'vitest';

import type { ProjectIssue } from '../src/issues/issueStore.js';
import { stripAnsi } from '../src/tui/ansi.js';
import {
  runTuiIssueCommand,
  type TuiIssueCommandPort,
} from '../src/tui/tuiIssueCommandHandler.js';

function issue(patch: Partial<ProjectIssue> = {}): ProjectIssue {
  return {
    version: 1,
    id: 'issue-id',
    number: 7,
    title: 'Fix the boundary',
    description: 'Keep behavior stable.',
    status: 'todo',
    priority: 'high',
    labels: [],
    acceptanceCriteria: ['tests pass'],
    createdBy: 'user',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    sessionIds: [],
    comments: [],
    metadata: {},
    ...patch,
  };
}

function createPort(items: ProjectIssue[] = []): TuiIssueCommandPort & { output: string[][] } {
  const output: string[][] = [];
  return {
    output,
    issues: {
      storage: vi.fn(async () => 'home' as const),
      list: vi.fn(async () => items),
      create: vi.fn(async title => issue({ title })),
      execute: vi.fn(async current => ({
        issue: { ...current, status: 'in_progress' },
        sessionId: 'session-1',
        text: 'dispatched',
      })),
      transition: vi.fn(async (_id, status) => issue({ status })),
    },
    appendStatic: lines => output.push([...lines]),
  };
}

function output(port: { output: string[][] }): string {
  return port.output.flat().map(stripAnsi).join('\n');
}

describe('runTuiIssueCommand', () => {
  it('returns false outside the issues command domain', async () => {
    expect(await runTuiIssueCommand('help', '', createPort())).toBe(false);
  });

  it('keeps empty and populated issue list output', async () => {
    const empty = createPort();
    await runTuiIssueCommand('issues', 'list', empty);
    expect(output(empty)).toContain('no issues yet');

    const populated = createPort([issue()]);
    await runTuiIssueCommand('issues', '', populated);
    expect(output(populated)).toContain('Issues (home)');
    expect(output(populated)).toContain('#7 Fix the boundary todo · high');
  });

  it('creates and shows issues through the service port', async () => {
    const create = createPort();
    await runTuiIssueCommand('issues', 'create New issue', create);
    expect(create.issues.create).toHaveBeenCalledWith('New issue', 'home');
    expect(output(create)).toContain('issue created: #7 New issue');

    const show = createPort([issue()]);
    await runTuiIssueCommand('issues', 'show ISS-7', show);
    expect(output(show)).toContain('ISS-7 Fix the boundary');
    expect(output(show)).toContain('Acceptance criteria:');
  });

  it('dispatches and transitions issues without exposing runtime types', async () => {
    const start = createPort([issue()]);
    await runTuiIssueCommand('issues', 'start #7 reviewer', start);
    expect(start.issues.execute).toHaveBeenCalledWith(expect.objectContaining({ number: 7 }), 'reviewer', 'home');
    expect(output(start)).toContain('ISS-7: in_progress · session session-1');

    const done = createPort([issue()]);
    await runTuiIssueCommand('issues', 'done #7', done);
    expect(done.issues.transition).toHaveBeenCalledWith('7', 'done', 'home');
    expect(output(done)).toContain('issue #7: done');
  });

  it('preserves validation and missing issue messages', async () => {
    const port = createPort();
    await runTuiIssueCommand('issues', 'show #99', port);
    await runTuiIssueCommand('issues', 'unknown', port);
    expect(output(port)).toContain('issue not found: 99');
    expect(output(port)).toContain('usage: /issues');
  });
});
