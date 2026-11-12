import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveDataRootSync } from './dataRoot.js';

export interface HcProjectRecord {
  id: string;
  name: string;
  projectPath: string;
  workspacePath: string;
  createdAt: string;
  lastOpenedAt: string;
}

interface RegistryFile {
  schema: 'hadamard-canvas-projects/1';
  projects: HcProjectRecord[];
}

function registryRoot(): string {
  return resolveDataRootSync();
}

function registryPath(): string {
  return path.join(registryRoot(), 'projects.json');
}

function projectId(projectPath: string): string {
  return 'project_' + createHash('sha1').update(projectPath).digest('hex').slice(0, 12);
}

async function readRegistry(): Promise<RegistryFile> {
  try {
    const parsed = JSON.parse(await readFile(registryPath(), 'utf8')) as Partial<RegistryFile>;
    return { schema: 'hadamard-canvas-projects/1', projects: Array.isArray(parsed.projects) ? parsed.projects : [] };
  } catch {
    return { schema: 'hadamard-canvas-projects/1', projects: [] };
  }
}

async function writeRegistry(registry: RegistryFile): Promise<void> {
  await mkdir(registryRoot(), { recursive: true });
  await writeFile(registryPath(), JSON.stringify(registry, null, 2), 'utf8');
}

export async function listProjects(): Promise<Array<HcProjectRecord & { workspaceExists: boolean; runningUrl: string | null }>> {
  const registry = await readRegistry();
  return registry.projects.map(project => {
    const daemonPath = path.join(project.workspacePath, 'daemon.json');
    let runningUrl: string | null = null;
    try {
      const daemon = JSON.parse(readFileSync(daemonPath, 'utf8')) as { url?: string };
      runningUrl = daemon.url || null;
    } catch { /* not running */ }
    return { ...project, workspaceExists: existsSync(project.workspacePath), runningUrl };
  }).sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt));
}

export async function registerProject(projectPath: string, name?: string): Promise<HcProjectRecord> {
  const resolvedProject = path.resolve(projectPath);
  const resolvedWorkspace = path.join(resolvedProject, '.hcanvas');
  const now = new Date().toISOString();
  const registry = await readRegistry();
  const existing = registry.projects.find(project => project.projectPath === resolvedProject);
  if (existing) {
    existing.lastOpenedAt = now;
    if (name?.trim()) existing.name = name.trim();
    await writeRegistry(registry);
    return existing;
  }
  const record: HcProjectRecord = {
    id: projectId(resolvedProject),
    name: name?.trim() || path.basename(resolvedProject) || 'Project',
    projectPath: resolvedProject,
    workspacePath: resolvedWorkspace,
    createdAt: now,
    lastOpenedAt: now,
  };
  registry.projects = [record, ...registry.projects].slice(0, 100);
  await writeRegistry(registry);
  return record;
}

export async function touchProject(projectPath: string): Promise<void> {
  const registry = await readRegistry();
  const project = registry.projects.find(item => item.projectPath === path.resolve(projectPath));
  if (!project) return;
  project.lastOpenedAt = new Date().toISOString();
  await writeRegistry(registry);
}

export async function removeProject(projectPath: string): Promise<void> {
  const resolved = path.resolve(projectPath);
  const registry = await readRegistry();
  registry.projects = registry.projects.filter(project => project.projectPath !== resolved);
  await writeRegistry(registry);
}

export function registryFilePath(): string {
  return registryPath();
}
