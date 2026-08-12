import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SessionSummary } from '../src/types.js';
import {
  buildTuiResumeCandidates,
  resolveTuiResumeReference,
} from '../src/tui/tuiSessionResume.js';

function summary(id: string, title: string, workDir: string): SessionSummary {
  return {
    id,
    title,
    titleSource: 'manual',
    model: 'test-model',
    status: 'idle',
    tags: [],
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T01:00:00.000Z',
    messageCount: 2,
    runCount: 1,
    preview: title,
    runtime: 'hadamard',
    configName: null,
    workDir,
  };
}

describe('TUI Session resume resolution', () => {
  it('deduplicates the local store and resolves full ids or unique titles', () => {
    const projectPath = path.resolve('E:/projects/alpha');
    const sessionDirectory = path.resolve('E:/state/alpha');
    const alpha = summary('session-alpha', 'Alpha OCR', projectPath);
    const candidates = buildTuiResumeCandidates(
      [{ projectPath, sessionDirectory, summary: alpha }],
      [alpha],
      { localProjectPath: projectPath, localSessionDirectory: sessionDirectory, currentSessionId: 'current' },
    );
    expect(candidates).toHaveLength(1);
    expect(resolveTuiResumeReference(candidates, 'session-alpha').summary.id).toBe('session-alpha');
    expect(resolveTuiResumeReference(candidates, 'alpha ocr').summary.id).toBe('session-alpha');
  });

  it('rejects ambiguous titles and hides manager/agent Sessions by default', () => {
    const first = summary('one', 'Repeated', 'E:/one');
    const second = summary('two', 'Repeated', 'E:/two');
    const manager = { ...summary('manager', 'Manager', 'E:/one'), kind: 'manager' as const };
    const agent = { ...summary('agent', 'Agent', 'E:/one'), kind: 'agent' as const };
    const candidates = buildTuiResumeCandidates([
      { projectPath: 'E:/one', sessionDirectory: 'E:/state/one', summary: first },
      { projectPath: 'E:/two', sessionDirectory: 'E:/state/two', summary: second },
      { projectPath: 'E:/one', sessionDirectory: 'E:/state/one', summary: manager },
      { projectPath: 'E:/one', sessionDirectory: 'E:/state/one', summary: agent },
    ], [], {
      localProjectPath: 'E:/one',
      localSessionDirectory: 'E:/state/one',
      currentSessionId: 'current',
    });
    expect(candidates.map(item => item.summary.id)).toEqual(['one', 'two']);
    expect(() => resolveTuiResumeReference(candidates, 'Repeated')).toThrow(/ambiguous/u);
  });
});
