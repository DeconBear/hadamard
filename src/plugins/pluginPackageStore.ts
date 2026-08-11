import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

import { createId } from '../runtime/helpers.js';
import { writeJsonAtomic } from '../storage/atomicJsonWrite.js';
import {
  isSkillMcpBundleManifest,
  parsePluginPackageManifest,
  type PluginPackageManifest,
  type PluginPackageSource,
} from './packageManifest.js';

const INSTALL_RECEIPT = '.hadamard-install.json';

interface PluginInstallReceipt {
  schemaVersion: 1;
  integrity: string;
  source: PluginPackageSource;
}

export interface InstallPluginPackageOptions {
  source?: PluginPackageSource;
}

export interface InstalledPluginPackage {
  manifest: PluginPackageManifest;
  packagePath: string;
  enabled: boolean;
  pinnedVersion?: string;
}

export class PluginPackageStore {
  private queue = Promise.resolve();

  constructor(private readonly rootDirectory: string) {}

  async install(
    sourceDirectory: string,
    options: InstallPluginPackageOptions = {},
  ): Promise<InstalledPluginPackage> {
    return this.serial(async () => {
      const sourcePath = path.resolve(sourceDirectory);
      await assertRegularPackageTree(sourcePath);
      const sourceManifest = await readSourceManifest(sourcePath);
      const manifest = isSkillMcpBundleManifest(sourceManifest)
        ? parsePluginPackageManifest(await readBundleManifest(sourcePath), {
            integrity: await packageTreeIntegrity(sourcePath),
            source: options.source ?? { kind: 'local', location: sourcePath },
          })
        : sourceManifest;
      await verifyManifestContent(sourcePath, manifest);

      const target = this.packagePath(manifest.id, manifest.version);
      const existing = await this.readInstalled(target);
      if (existing) {
        if (existing.id !== manifest.id || existing.version !== manifest.version) {
          throw new Error('Installed plugin package identity mismatch.');
        }
        if (!(await packageBitsMatch(sourcePath, target, manifest, existing))) {
          await rm(target, { recursive: true, force: true });
        }
      }
      if (!(await this.readInstalled(target))) {
        await mkdir(path.dirname(target), { recursive: true });
        const staging = `${target}.install-${createId()}`;
        try {
          await cp(sourcePath, staging, { recursive: true, dereference: false });
          if (isSkillMcpBundleManifest(manifest)) {
            await writeJsonAtomic(path.join(staging, INSTALL_RECEIPT), {
              schemaVersion: 1,
              integrity: manifest.integrity!,
              source: manifest.source!,
            } satisfies PluginInstallReceipt);
          }
          await rename(staging, target);
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          if (!(await this.readInstalled(target))) throw error;
        }
      }
      const state = await this.readState();
      state[manifest.id] = {
        enabled: state[manifest.id]?.enabled ?? false,
        pinnedVersion: state[manifest.id]?.pinnedVersion,
      };
      await this.writeState(state);
      const installed = (await this.readInstalled(target)) ?? manifest;
      return {
        manifest: installed,
        packagePath: target,
        enabled: state[manifest.id]!.enabled,
        pinnedVersion: state[manifest.id]!.pinnedVersion,
      };
    });
  }

  async list(pluginId?: string): Promise<InstalledPluginPackage[]> {
    const state = await this.readState();
    const ids = pluginId ? [pluginId] : await directoryNames(this.rootDirectory, 'state.json');
    const packages: InstalledPluginPackage[] = [];
    for (const id of ids) {
      for (const version of await directoryNames(path.join(this.rootDirectory, id))) {
        const packagePath = this.packagePath(id, version);
        try {
          const manifest = await this.readInstalled(packagePath);
          if (!manifest) continue;
          packages.push({
            manifest,
            packagePath,
            enabled: state[id]?.enabled ?? false,
            pinnedVersion: state[id]?.pinnedVersion,
          });
        } catch {
          // Ignore incomplete package directories.
        }
      }
    }
    return packages;
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    await this.serial(async () => {
      const state = await this.readState();
      state[pluginId] = { ...state[pluginId], enabled };
      await this.writeState(state);
    });
  }

  async pin(pluginId: string, version?: string): Promise<void> {
    await this.serial(async () => {
      const state = await this.readState();
      state[pluginId] = {
        ...state[pluginId],
        enabled: state[pluginId]?.enabled ?? false,
        pinnedVersion: version,
      };
      await this.writeState(state);
    });
  }

  async remove(pluginId: string, version?: string): Promise<void> {
    await this.serial(async () => {
      await rm(version ? this.packagePath(pluginId, version) : this.pluginRoot(pluginId), {
        recursive: true,
        force: true,
      });
      if (!version || (await directoryNames(this.pluginRoot(pluginId))).length === 0) {
        const state = await this.readState();
        delete state[pluginId];
        await this.writeState(state);
      }
    });
  }

  private packagePath(pluginId: string, version: string): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(pluginId)
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
      throw new Error('Unsafe plugin package path.');
    }
    return path.join(this.rootDirectory, pluginId, version);
  }

  private pluginRoot(pluginId: string): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(pluginId)) {
      throw new Error('Unsafe plugin package path.');
    }
    return path.join(this.rootDirectory, pluginId);
  }

  private async readInstalled(target: string): Promise<PluginPackageManifest | undefined> {
    try {
      const sourceManifest = await readSourceManifest(target);
      if (!isSkillMcpBundleManifest(sourceManifest)) return sourceManifest;
      const receipt = JSON.parse(
        await readFile(path.join(target, INSTALL_RECEIPT), 'utf8'),
      ) as PluginInstallReceipt;
      if (receipt.schemaVersion !== 1 || typeof receipt.integrity !== 'string') {
        throw new Error('Skill+MCP bundle install receipt is invalid.');
      }
      const actualIntegrity = await packageTreeIntegrity(target);
      if (actualIntegrity !== receipt.integrity) {
        throw new Error('Skill+MCP bundle package integrity mismatch.');
      }
      return parsePluginPackageManifest(await readBundleManifest(target), receipt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async readState(): Promise<Record<string, { enabled: boolean; pinnedVersion?: string }>> {
    try {
      return JSON.parse(await readFile(path.join(this.rootDirectory, 'state.json'), 'utf8')) as Record<string, { enabled: boolean; pinnedVersion?: string }>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async writeState(state: Record<string, { enabled: boolean; pinnedVersion?: string }>): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    await writeJsonAtomic(path.join(this.rootDirectory, 'state.json'), state);
  }

  private async serial<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

async function readSourceManifest(root: string): Promise<PluginPackageManifest> {
  try {
    return parsePluginPackageManifest(JSON.parse(
      await readFile(path.join(root, 'hadamard-plugin.json'), 'utf8'),
    ));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return parsePluginPackageManifest(await readBundleManifest(root));
}

async function readBundleManifest(root: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
}

async function verifyManifestContent(root: string, manifest: PluginPackageManifest): Promise<void> {
  if (isSkillMcpBundleManifest(manifest)) {
    for (const relative of [manifest.skills, manifest.mcpServers].filter(Boolean) as string[]) {
      const candidate = resolveInside(root, relative);
      await lstat(candidate);
    }
    return;
  }
  const entry = await readFile(resolveInside(root, manifest.entry));
  if (manifest.integrity) {
    const actual = `sha256-${createHash('sha256').update(entry).digest('base64')}`;
    if (actual !== manifest.integrity) throw new Error('Plugin package integrity mismatch.');
  }
}

async function packageBitsMatch(
  source: string,
  target: string,
  incoming: PluginPackageManifest,
  installed: PluginPackageManifest,
): Promise<boolean> {
  if (isSkillMcpBundleManifest(incoming) && isSkillMcpBundleManifest(installed)) {
    return incoming.integrity === installed.integrity;
  }
  if (isSkillMcpBundleManifest(incoming) || isSkillMcpBundleManifest(installed)) return false;
  const sourceEntry = await readFile(resolveInside(source, incoming.entry));
  const installedEntry = await readFile(resolveInside(target, installed.entry));
  return createHash('sha256').update(sourceEntry).digest('hex')
    === createHash('sha256').update(installedEntry).digest('hex');
}

function resolveInside(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Plugin resource escapes the package root.');
  }
  return resolved;
}

async function packageTreeIntegrity(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of await regularFiles(root)) {
    const relative = path.relative(root, file).replace(/\\/gu, '/');
    hash.update(relative);
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return `sha256-${hash.digest('base64')}`;
}

async function regularFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === INSTALL_RECEIPT) continue;
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...await regularFiles(candidate));
    else if (entry.isFile()) results.push(candidate);
  }
  return results;
}

async function directoryNames(root: string, excluded?: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name !== excluded)
      .map(entry => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function assertRegularPackageTree(root: string): Promise<void> {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Plugin package source must be a regular directory.');
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Plugin packages cannot contain symbolic links: ${entry.name}`);
    }
    if (entry.isDirectory()) await assertRegularPackageTree(candidate);
    else if (!entry.isFile()) throw new Error(`Plugin packages cannot contain special files: ${entry.name}`);
  }
}
