import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { resolveHadamardHome } from '../config/hadamardHome.js';
import type { SessionSummary } from '../types.js';
import { SessionStore } from './sessionStore.js';

export interface DiscoveredProjectSession {
  projectPath: string;
  sessionDirectory: string;
  summary: SessionSummary;
}

type DiscoveryCache = {
  homeDir: string;
  expiresAt: number;
  sessions: DiscoveredProjectSession[];
};

let discoveryCache: DiscoveryCache | null = null;

function normalizedPath(value: string): string {
  const resolved = path.resolve(value).normalize('NFC');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Discover persisted project Sessions without treating their workspaces as
 * registered GUI projects. Session metadata is the source of truth for the
 * workspace path; opaque project-directory names are never decoded.
 */
export async function discoverProjectSessions(
  homeDir?: string,
  options: { cacheTtlMs?: number } = {},
): Promise<DiscoveredProjectSession[]> {
  const resolvedHome = resolveHadamardHome(homeDir);
  const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 4_000);
  if (
    discoveryCache
    && discoveryCache.homeDir === normalizedPath(resolvedHome)
    && discoveryCache.expiresAt > Date.now()
  ) {
    return discoveryCache.sessions.map(item => ({ ...item, summary: { ...item.summary } }));
  }

  const projectsRoot = path.join(resolvedHome, 'projects');
  let entries;
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const directories = entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(projectsRoot, entry.name));
  const sessions: DiscoveredProjectSession[] = [];
  const batchSize = 16;
  for (let offset = 0; offset < directories.length; offset += batchSize) {
    const batch = directories.slice(offset, offset + batchSize);
    const summaries = await Promise.all(batch.map(async sessionDirectory => ({
      sessionDirectory,
      summaries: await new SessionStore(sessionDirectory).list().catch(() => []),
    })));
    for (const item of summaries) {
      for (const summary of item.summaries) {
        const projectPath = summary.workDir?.trim();
        if (!projectPath) continue;
        sessions.push({
          projectPath: path.resolve(projectPath),
          sessionDirectory: item.sessionDirectory,
          summary,
        });
      }
    }
  }
  sessions.sort((left, right) =>
    (right.summary.updatedAt || '').localeCompare(left.summary.updatedAt || '')
  );
  discoveryCache = {
    homeDir: normalizedPath(resolvedHome),
    expiresAt: Date.now() + cacheTtlMs,
    sessions,
  };
  return sessions.map(item => ({ ...item, summary: { ...item.summary } }));
}

export function invalidateProjectSessionDiscovery(): void {
  discoveryCache = null;
}
