import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ResolvedPolicy } from '../policy/types.js';
import { policySetting } from '../policy/runtimePolicy.js';
import {
  isSkillMcpBundleManifest,
  parsePluginPackageManifest,
  type PluginPackageManifest,
  type PluginPackageSource,
} from './packageManifest.js';
import { inspectSkillMcpBundle } from './pluginBundleLoader.js';
import { PluginPackageStore } from './pluginPackageStore.js';
import { PluginRegistryClient } from './pluginRegistryClient.js';
import { resolvePluginVersion } from './pluginResolver.js';
import { PluginTrustStore } from './pluginTrustStore.js';

export interface PluginManagerResult {
  message: string;
  items?: Array<{ label: string; description?: string }>;
  runtimeChanged?: boolean;
}

export interface PluginPackageSnapshot {
  id: string;
  name: string;
  version: string;
  packageType: 'hadamard-v1' | 'skill-mcp-bundle';
  enabled: boolean;
  trusted: boolean;
  capabilities: string[];
  source: string;
  commit?: string;
  startupCommands: string[];
  environmentVariables: string[];
  network: boolean;
  fileAccess: string[];
}

export class PluginPackageManager {
  readonly packages: PluginPackageStore;
  readonly trust: PluginTrustStore;

  constructor(
    rootDirectory: string,
    private readonly registryUrl?: string,
    private readonly policy?: ResolvedPolicy,
  ) {
    this.packages = new PluginPackageStore(path.join(rootDirectory, 'packages'));
    this.trust = new PluginTrustStore(path.join(rootDirectory, 'trust.json'));
  }

  async snapshot(): Promise<PluginPackageSnapshot[]> {
    const installed = await this.packages.list();
    return Promise.all(installed.map(async item => {
      const manifest = item.manifest;
      const trusted = await this.trust.isTrusted({
        pluginId: manifest.id,
        version: manifest.version,
        integrity: manifest.integrity,
        capabilities: manifest.capabilities,
        source: isSkillMcpBundleManifest(manifest) ? manifest.source : undefined,
      });
      if (!isSkillMcpBundleManifest(manifest)) {
        return {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          packageType: 'hadamard-v1',
          enabled: item.enabled,
          trusted,
          capabilities: [...manifest.capabilities],
          source: item.packagePath,
          startupCommands: [`in-process JavaScript: ${manifest.entry}`],
          environmentVariables: [],
          network: manifest.capabilities.includes('network'),
          fileAccess: manifest.capabilities.filter(capability => capability.startsWith('filesystem.')),
        } satisfies PluginPackageSnapshot;
      }
      const summary = await inspectSkillMcpBundle(item.packagePath, manifest);
      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        packageType: 'skill-mcp-bundle',
        enabled: item.enabled,
        trusted,
        capabilities: [...manifest.capabilities],
        source: summary.source,
        ...(summary.commit ? { commit: summary.commit } : {}),
        startupCommands: summary.launches.map(launch => launch.startupCommand),
        environmentVariables: [...new Set(summary.launches.flatMap(launch => launch.environmentVariables))],
        network: summary.network,
        fileAccess: [...summary.fileAccess],
      } satisfies PluginPackageSnapshot;
    }));
  }

  async execute(input: string): Promise<PluginManagerResult> {
    const [action = 'list', ...rest] = input.trim().split(/\s+/u);
    if (action === 'list') {
      const installed = await this.packages.list();
      return {
        message: `${installed.length} installed plugin package(s).`,
        items: installed.map(item => ({
          label: `${item.manifest.id}@${item.manifest.version}`,
          description: `${item.enabled ? 'enabled' : 'disabled'} · ${isSkillMcpBundleManifest(item.manifest) ? 'Skill+MCP bundle' : 'Hadamard v1'}${item.pinnedVersion ? ` · pinned ${item.pinnedVersion}` : ''}`,
        })),
      };
    }
    if (action === 'search') {
      if (!this.registryUrl) throw new Error('Set HADAMARD_PLUGIN_REGISTRY to search a registry.');
      this.assertRegistryAllowed();
      const entries = await new PluginRegistryClient(this.registryUrl).search(rest.join(' '));
      entries.forEach(entry => this.assertManifestAllowed(entry.manifest));
      return {
        message: `${entries.length} registry result(s).`,
        items: entries.map(entry => ({
          label: `${entry.manifest.id}@${entry.manifest.version}`,
          description: entry.manifest.description,
        })),
      };
    }
    if (action === 'install' || action === 'update') {
      const request = parseInstallRequest(rest);
      if (!request.directory) {
        throw new Error(`Usage: /plugin ${action} <local-package-directory> [--source=<url> --commit=<sha>]`);
      }
      const source = path.resolve(request.directory);
      const manifest = await readLocalManifest(source, request.source);
      this.assertManifestAllowed(manifest);
      const installed = await this.packages.install(source, { source: request.source });
      return {
        message: `${action === 'install' ? 'Installed' : 'Updated'} ${installed.manifest.id}@${installed.manifest.version}.`,
      };
    }
    const pluginId = rest[0];
    if (!pluginId) throw new Error(`Usage: /plugin ${action} <plugin-id>`);
    if (action === 'enable' || action === 'disable') {
      if (action === 'enable') {
        const installed = await this.packages.list(pluginId);
        if (installed.length === 0) throw new Error(`Plugin package not installed: ${pluginId}`);
        installed.forEach(item => this.assertManifestAllowed(item.manifest));
      }
      await this.packages.setEnabled(pluginId, action === 'enable');
      return {
        message: `${action === 'enable' ? 'Enabled' : 'Disabled'} ${pluginId}.`,
        runtimeChanged: true,
      };
    }
    if (action === 'pin') {
      const version = rest[1] === 'off' ? undefined : rest[1];
      await this.packages.pin(pluginId, version);
      return { message: version ? `Pinned ${pluginId}@${version}.` : `Unpinned ${pluginId}.` };
    }
    if (action === 'remove') {
      await this.packages.remove(pluginId, rest[1]);
      await this.trust.revoke(pluginId);
      return {
        message: `Removed ${pluginId}${rest[1] ? `@${rest[1]}` : ''}.`,
        runtimeChanged: true,
      };
    }
    if (action === 'trust' || action === 'inspect') {
      const packages = await this.packages.list(pluginId);
      const manifest = resolvePluginVersion(
        packages.map(item => item.manifest),
        { pinnedVersion: packages[0]?.pinnedVersion },
      );
      if (!manifest) throw new Error(`Plugin package not installed: ${pluginId}`);
      this.assertManifestAllowed(manifest);
      const selected = packages.find(item => item.manifest.version === manifest.version)!;
      const items = await this.describeTrust(selected.packagePath, manifest);
      if (action === 'trust') {
        await this.trust.trust({
          pluginId,
          version: manifest.version,
          integrity: manifest.integrity,
          capabilities: manifest.capabilities,
          source: isSkillMcpBundleManifest(manifest) ? manifest.source : undefined,
        });
      }
      return {
        message: action === 'trust'
          ? `Trusted ${pluginId}@${manifest.version} for the exact integrity and capability set.`
          : `${pluginId}@${manifest.version} trust review.`,
        items,
      };
    }
    throw new Error('Usage: /plugin list|search|install|update|inspect|pin|enable|disable|remove|trust');
  }

  private async describeTrust(
    packagePath: string,
    manifest: PluginPackageManifest,
  ): Promise<Array<{ label: string; description?: string }>> {
    const items = [
      { label: 'Integrity', description: manifest.integrity ?? 'missing (cannot trust)' },
      { label: 'Capabilities', description: manifest.capabilities.join(', ') || 'none' },
    ];
    if (!isSkillMcpBundleManifest(manifest)) {
      return [...items, { label: 'Startup', description: `in-process JavaScript: ${manifest.entry}` }];
    }
    const summary = await inspectSkillMcpBundle(packagePath, manifest);
    return [
      ...items,
      { label: 'Source', description: summary.source },
      { label: 'Commit', description: summary.commit ?? 'unverified local source' },
      ...summary.launches.map(launch => ({
        label: `Startup · ${launch.server}`,
        description: launch.startupCommand,
      })),
      {
        label: 'Environment',
        description: [...new Set(summary.launches.flatMap(launch => launch.environmentVariables))].join(', ') || 'none declared',
      },
      { label: 'Network', description: summary.network ? 'requested' : 'not requested' },
      { label: 'Files', description: summary.fileAccess.join(' + ') || 'none requested' },
    ];
  }

  private assertRegistryAllowed(): void {
    const allowed = policySetting<string[]>(this.policy ?? emptyPolicy, 'plugins.allowedRegistries');
    if (allowed?.length && this.registryUrl && !allowed.includes(this.registryUrl)) {
      throw new Error(`Plugin registry is blocked by managed policy: ${this.registryUrl}`);
    }
  }

  private assertManifestAllowed(manifest: PluginPackageManifest): void {
    if (!this.policy) return;
    const publishers = policySetting<string[]>(this.policy, 'plugins.allowedPublishers');
    const publisher = 'publisher' in manifest ? manifest.publisher : undefined;
    if (publishers?.length && (!publisher || !publishers.includes(publisher))) {
      throw new Error(`Plugin publisher is blocked by managed policy: ${publisher ?? 'unsigned'}`);
    }
    const capabilities = policySetting<string[]>(this.policy, 'plugins.allowedCapabilities');
    const blocked = capabilities?.length
      ? manifest.capabilities.find(capability => !capabilities.includes(capability))
      : undefined;
    if (blocked) throw new Error(`Plugin capability is blocked by managed policy: ${blocked}`);
  }
}

const emptyPolicy: ResolvedPolicy = {
  settings: {},
  rules: [],
  lockedSettings: [],
  sources: [],
};

async function readLocalManifest(
  source: string,
  packageSource?: PluginPackageSource,
): Promise<PluginPackageManifest> {
  try {
    return parsePluginPackageManifest(JSON.parse(
      await readFile(path.join(source, 'hadamard-plugin.json'), 'utf8'),
    ));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return parsePluginPackageManifest(JSON.parse(
    await readFile(path.join(source, '.codex-plugin', 'plugin.json'), 'utf8'),
  ), { source: packageSource });
}

function parseInstallRequest(rest: string[]): {
  directory: string;
  source?: PluginPackageSource;
} {
  let sourceUrl: string | undefined;
  let commit: string | undefined;
  const pathParts: string[] = [];
  for (const value of rest) {
    if (value.startsWith('--source=')) sourceUrl = value.slice('--source='.length);
    else if (value.startsWith('--commit=')) commit = value.slice('--commit='.length);
    else pathParts.push(value);
  }
  if (commit && !sourceUrl) throw new Error('--commit requires --source.');
  return {
    directory: pathParts.join(' ').trim(),
    ...(sourceUrl
      ? { source: { kind: 'git', location: sourceUrl, ...(commit ? { commit } : {}) } }
      : {}),
  };
}
