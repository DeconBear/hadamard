import path from 'node:path';

export interface PluginPackageSource {
  kind: 'git' | 'local';
  location: string;
  commit?: string;
}

export interface HadamardPluginV1Manifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  publisher?: string;
  signature?: string;
  entry: string;
  integrity?: string;
  capabilities: string[];
  permissions?: string[];
  hadamard?: string;
}

export interface SkillMcpBundleManifest {
  schemaVersion: 1;
  packageType: 'skill-mcp-bundle';
  id: string;
  name: string;
  version: string;
  description?: string;
  skills?: string;
  mcpServers?: string;
  integrity?: string;
  capabilities: string[];
  source?: PluginPackageSource;
}

export type PluginPackageManifest = HadamardPluginV1Manifest | SkillMcpBundleManifest;

export interface ParsePluginPackageManifestOptions {
  integrity?: string;
  source?: PluginPackageSource;
}

export function parsePluginPackageManifest(
  value: unknown,
  options: ParsePluginPackageManifestOptions = {},
): PluginPackageManifest {
  if (!isRecord(value)) throw new Error('Plugin manifest must be an object.');
  if (value.schemaVersion === 1 && typeof value.entry === 'string') {
    return parseHadamardPluginV1Manifest(value);
  }
  return parseSkillMcpBundleManifest(value, options);
}

export function isSkillMcpBundleManifest(
  manifest: PluginPackageManifest,
): manifest is SkillMcpBundleManifest {
  return 'packageType' in manifest && manifest.packageType === 'skill-mcp-bundle';
}

function parseHadamardPluginV1Manifest(value: Record<string, unknown>): HadamardPluginV1Manifest {
  for (const field of ['id', 'name', 'version', 'entry'] as const) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new Error(`Plugin manifest ${field} is required.`);
    }
  }
  const id = validateId(value.id as string);
  const version = validateVersion(value.version as string);
  const entry = validatePackagePath(value.entry as string, 'entry');
  const capabilities = validateCapabilities(value.capabilities);
  validateIntegrity(value.integrity);
  return {
    schemaVersion: 1,
    id,
    name: (value.name as string).trim(),
    version,
    entry,
    capabilities,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.publisher === 'string' && value.publisher.trim()
      ? { publisher: value.publisher.trim() }
      : {}),
    ...(typeof value.signature === 'string' && value.signature.trim()
      ? { signature: value.signature.trim() }
      : {}),
    ...(typeof value.integrity === 'string' ? { integrity: value.integrity } : {}),
    ...(Array.isArray(value.permissions)
      ? { permissions: value.permissions.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(typeof value.hadamard === 'string' ? { hadamard: value.hadamard } : {}),
  };
}

function parseSkillMcpBundleManifest(
  value: Record<string, unknown>,
  options: ParsePluginPackageManifestOptions,
): SkillMcpBundleManifest {
  if (typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error('Skill+MCP bundle manifest name is required.');
  }
  if (typeof value.version !== 'string' || !value.version.trim()) {
    throw new Error('Skill+MCP bundle manifest version is required.');
  }
  const skills = value.skills === undefined
    ? undefined
    : validatePackagePath(value.skills, 'skills');
  const mcpServers = value.mcpServers === undefined
    ? undefined
    : validatePackagePath(value.mcpServers, 'mcpServers');
  if (!skills && !mcpServers) {
    throw new Error('Skill+MCP bundle manifest must declare skills or mcpServers.');
  }
  validateIntegrity(options.integrity);
  const id = validateId(
    typeof value.id === 'string' && value.id.trim()
      ? value.id
      : value.name.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '-'),
  );
  const capabilities = [
    ...(skills ? ['skills'] : []),
    ...(mcpServers
      ? ['mcp', 'process', 'network', 'filesystem.read', 'filesystem.write']
      : []),
  ];
  return {
    schemaVersion: 1,
    packageType: 'skill-mcp-bundle',
    id,
    name: value.name.trim(),
    version: validateVersion(value.version),
    capabilities,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(skills ? { skills } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(options.integrity ? { integrity: options.integrity } : {}),
    ...(options.source ? { source: validateSource(options.source) } : {}),
  };
}

function validatePackagePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Plugin manifest ${field} must be a non-empty relative path.`);
  }
  const normalized = value.trim().replace(/\\/gu, '/');
  if (path.posix.isAbsolute(normalized) || normalized.split('/').some(segment => segment === '..')) {
    throw new Error(`Plugin manifest ${field} must stay inside the package.`);
  }
  return normalized.replace(/^\.\//u, '');
}

function validateId(value: string): string {
  const id = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
    throw new Error('Plugin manifest id is invalid.');
  }
  return id;
}

function validateVersion(value: string): string {
  const version = value.trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('Plugin manifest version must be SemVer.');
  }
  return version;
}

function validateCapabilities(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(capability => typeof capability === 'string')) {
    throw new Error('Plugin manifest capabilities must be an array of strings.');
  }
  return [...value];
}

function validateIntegrity(value: unknown): void {
  if (value !== undefined
    && (typeof value !== 'string' || !/^sha256-[A-Za-z0-9+/=]+$/u.test(value))) {
    throw new Error('Plugin manifest integrity must be a sha256 SRI value.');
  }
}

function validateSource(source: PluginPackageSource): PluginPackageSource {
  if ((source.kind !== 'git' && source.kind !== 'local') || !source.location.trim()) {
    throw new Error('Plugin package source is invalid.');
  }
  if (source.commit !== undefined && !/^[a-f0-9]{7,64}$/iu.test(source.commit)) {
    throw new Error('Plugin package source commit must be a Git object id.');
  }
  return {
    kind: source.kind,
    location: source.location.trim(),
    ...(source.commit ? { commit: source.commit.toLowerCase() } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
