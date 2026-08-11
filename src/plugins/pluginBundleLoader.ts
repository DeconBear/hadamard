import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  AgentMcpServerDefinition,
  StdioMcpServerDefinition,
  StreamableHttpMcpServerDefinition,
} from '../types.js';
import type { SkillMcpBundleManifest } from './packageManifest.js';

export interface PluginBundleLaunchSummary {
  server: string;
  startupCommand: string;
  environmentVariables: string[];
}

export interface PluginBundleTrustSummary {
  packageType: 'skill-mcp-bundle';
  source: string;
  commit?: string;
  launches: PluginBundleLaunchSummary[];
  capabilities: string[];
  network: boolean;
  fileAccess: Array<'read' | 'write'>;
}

export interface LoadedSkillMcpBundle {
  kind: 'skill-mcp-bundle';
  pluginId: string;
  version: string;
  packagePath: string;
  skillDirectories: string[];
  skillRoots: string[];
  directSkills: Array<{ name: string; skillFile: string; skillRoot: string }>;
  mcpServers: AgentMcpServerDefinition[];
  trust: PluginBundleTrustSummary;
}

export async function inspectSkillMcpBundle(
  packagePath: string,
  manifest: SkillMcpBundleManifest,
): Promise<PluginBundleTrustSummary> {
  const definitions = manifest.mcpServers
    ? await readMcpDefinitions(packagePath, manifest, false)
    : [];
  return {
    packageType: 'skill-mcp-bundle',
    source: manifest.source?.location ?? packagePath,
    ...(manifest.source?.commit ? { commit: manifest.source.commit } : {}),
    launches: definitions.map(definition => ({
      server: definition.name,
      startupCommand: definition.kind === 'stdio'
        ? formatCommand(definition.command, definition.args)
        : String(definition.url),
      environmentVariables: definition.kind === 'stdio'
        ? collectEnvironmentNames(definition.env)
        : collectEnvironmentNames(definition.headers),
    })),
    capabilities: [...manifest.capabilities],
    network: manifest.capabilities.includes('network'),
    fileAccess: [
      ...(manifest.capabilities.includes('filesystem.read') ? ['read' as const] : []),
      ...(manifest.capabilities.includes('filesystem.write') ? ['write' as const] : []),
    ],
  };
}

export async function loadSkillMcpBundle(
  packagePath: string,
  manifest: SkillMcpBundleManifest,
): Promise<LoadedSkillMcpBundle> {
  if (!manifest.integrity) throw new Error('Skill+MCP bundle requires verified package integrity.');
  const skillRoots = manifest.skills ? [resolveInside(packagePath, manifest.skills)] : [];
  const skillDirectories: string[] = [];
  const directSkills: LoadedSkillMcpBundle['directSkills'] = [];
  for (const skillRoot of skillRoots) {
    const directSkill = path.join(skillRoot, 'SKILL.md');
    try {
      await access(directSkill);
      directSkills.push({ name: manifest.id, skillFile: directSkill, skillRoot });
    } catch {
      skillDirectories.push(skillRoot);
    }
  }
  const mcpServers = manifest.mcpServers
    ? await readMcpDefinitions(packagePath, manifest, true)
    : [];
  return {
    kind: 'skill-mcp-bundle',
    pluginId: manifest.id,
    version: manifest.version,
    packagePath,
    skillDirectories,
    skillRoots,
    directSkills,
    mcpServers,
    trust: await inspectSkillMcpBundle(packagePath, manifest),
  };
}

async function readMcpDefinitions(
  packagePath: string,
  manifest: SkillMcpBundleManifest,
  resolveEnvironment: boolean,
): Promise<Array<StdioMcpServerDefinition | StreamableHttpMcpServerDefinition>> {
  const configPath = resolveInside(packagePath, manifest.mcpServers!);
  const parsed = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
  const root = asRecord(parsed);
  const servers = asRecord(root.mcpServers ?? root);
  const definitions: Array<StdioMcpServerDefinition | StreamableHttpMcpServerDefinition> = [];
  const contentProvenance = {
    trust: 'untrusted' as const,
    pluginId: manifest.id,
    packageVersion: manifest.version,
    source: manifest.source?.location ?? packagePath,
    ...(manifest.source?.commit ? { commit: manifest.source.commit } : {}),
    integrity: manifest.integrity!,
  };
  for (const [name, raw] of Object.entries(servers)) {
    const server = asRecord(raw);
    if (typeof server.command === 'string' && server.command.trim()) {
      const args = stringArray(server.args).map(argument => pinGitReference(argument, manifest));
      const env = environmentRecord(server.env, resolveEnvironment);
      definitions.push({
        kind: 'stdio',
        name,
        command: server.command.trim(),
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        cwd: typeof server.cwd === 'string'
          ? resolveInside(packagePath, server.cwd)
          : packagePath,
        stderr: 'pipe',
        contentProvenance,
      } satisfies StdioMcpServerDefinition);
      continue;
    }
    if (typeof server.url === 'string' && server.url.trim()) {
      const headers = environmentRecord(server.headers, resolveEnvironment);
      definitions.push({
        kind: 'streamable_http',
        name,
        url: server.url.trim(),
        ...(Object.keys(headers).length ? { headers } : {}),
        contentProvenance,
      } satisfies StreamableHttpMcpServerDefinition);
      continue;
    }
    throw new Error(`MCP server "${name}" must declare command or url.`);
  }
  return definitions;
}

function environmentRecord(value: unknown, resolveEnvironment: boolean): Record<string, string> {
  if (value === undefined) return {};
  const record = asRecord(value);
  return Object.fromEntries(Object.entries(record).map(([key, raw]) => {
    if (typeof raw !== 'string') throw new Error(`Environment value for ${key} must be a string.`);
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(raw);
    if (!match || !resolveEnvironment) return [key, raw];
    const resolved = process.env[match[1]!];
    if (resolved === undefined) throw new Error(`Plugin bundle requires environment variable ${match[1]}.`);
    return [key, resolved];
  }));
}

function collectEnvironmentNames(value: Record<string, string> | undefined): string[] {
  if (!value) return [];
  return [...new Set(Object.entries(value).flatMap(([key, raw]) => {
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(raw);
    return [key, ...(match ? [match[1]!] : [])];
  }))].sort();
}

function pinGitReference(argument: string, manifest: SkillMcpBundleManifest): string {
  const commit = manifest.source?.commit;
  if (!commit || !argument.includes('git+')) return argument;
  return argument.replace(/@(main|master|HEAD)(?=$|[#&])/gu, `@${commit}`);
}

function formatCommand(command: string, args: string[] | undefined): string {
  return [command, ...(args ?? [])].map(value => /\s/u.test(value) ? JSON.stringify(value) : value).join(' ');
}

function resolveInside(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Plugin bundle resource escapes the package root.');
  }
  return resolved;
}

function stringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error('MCP server args must be an array of strings.');
  }
  return [...value];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Plugin bundle configuration must be an object.');
  }
  return value as Record<string, unknown>;
}
