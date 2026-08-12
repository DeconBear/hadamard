import path from 'node:path';

import type { DiscoveredProjectSession } from '../storage/sessionDiscovery.js';
import type { SessionSummary } from '../types.js';

export interface TuiResumeCandidate {
  key: string;
  projectPath: string;
  sessionDirectory: string;
  summary: SessionSummary;
}

function candidateKey(sessionDirectory: string, sessionId: string): string {
  return `${path.resolve(sessionDirectory).normalize('NFC')}\0${sessionId}`;
}

export function buildTuiResumeCandidates(
  discovered: readonly DiscoveredProjectSession[],
  local: readonly SessionSummary[],
  options: {
    localProjectPath: string;
    localSessionDirectory: string;
    currentSessionId: string;
    includeAgents?: boolean;
  },
): TuiResumeCandidate[] {
  const byKey = new Map<string, TuiResumeCandidate>();
  const add = (projectPath: string, sessionDirectory: string, summary: SessionSummary) => {
    if (
      summary.id === options.currentSessionId
      || summary.kind === 'manager'
      || (summary.kind === 'agent' && options.includeAgents !== true)
    ) return;
    const key = candidateKey(sessionDirectory, summary.id);
    byKey.set(key, {
      key,
      projectPath: path.resolve(summary.workDir?.trim() || projectPath),
      sessionDirectory: path.resolve(sessionDirectory),
      summary,
    });
  };
  for (const item of discovered) add(item.projectPath, item.sessionDirectory, item.summary);
  for (const summary of local) {
    add(options.localProjectPath, options.localSessionDirectory, summary);
  }
  return [...byKey.values()].sort((left, right) =>
    (right.summary.updatedAt || '').localeCompare(left.summary.updatedAt || '')
  );
}

export function resolveTuiResumeReference(
  candidates: readonly TuiResumeCandidate[],
  reference: string,
): TuiResumeCandidate {
  const normalized = reference.trim();
  const byId = candidates.filter(item => item.summary.id === normalized);
  if (byId.length === 1) return byId[0]!;
  if (byId.length > 1) {
    throw new Error(`Session id '${normalized}' exists in more than one workspace.`);
  }
  const folded = normalized.toLocaleLowerCase();
  const byTitle = candidates.filter(item => item.summary.title.toLocaleLowerCase() === folded);
  if (byTitle.length === 1) return byTitle[0]!;
  if (byTitle.length > 1) {
    throw new Error(`Session title '${normalized}' is ambiguous; use the full Session id.`);
  }
  throw new Error(`No persisted Session matches '${normalized}'.`);
}
