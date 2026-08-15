import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { HadamardSdkError } from '../errors.js';
import type { HadamardRuntimeContribution } from './contributionHost.js';

/**
 * Runtime activation layer, kept separate from package trust and bundle
 * discovery (PluginLoader stays the trust gate). A manifest is validated,
 * its entry is confined to the package root, the module is imported, and
 * only a well-formed contribution shape is handed to the host - which is
 * what actually applies it.
 */

export interface RuntimeContributionManifest {
  id: string;
  version: string;
  kind: 'runtime-contribution';
  entry: string;
  capabilities?: string[];
}

export interface ActivateRuntimeContributionOptions {
  /** Trust gate: reject before any module import. Package trust is a separate layer from activation. */
  isTrusted?: (input: {
    id: string;
    version: string;
    capabilities: string[];
  }) => boolean | Promise<boolean>;
}

export function isRuntimeContributionManifest(value: unknown): value is RuntimeContributionManifest {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'runtime-contribution'
    && typeof record.id === 'string'
    && typeof record.version === 'string'
    && typeof record.entry === 'string';
}

export async function activateRuntimeContribution(
  packagePath: string,
  manifest: RuntimeContributionManifest,
  options: ActivateRuntimeContributionOptions = {},
): Promise<HadamardRuntimeContribution> {
  if (!isRuntimeContributionManifest(manifest)) {
    throw new HadamardSdkError('Runtime contribution manifest has an invalid shape.', 'CONTRIBUTION_MANIFEST_INVALID');
  }
  const capabilities = manifest.capabilities ?? [];
  if (options.isTrusted && !(await options.isTrusted({
    id: manifest.id,
    version: manifest.version,
    capabilities,
  }))) {
    throw new HadamardSdkError(
      `Contribution '${manifest.id}' is not trusted for this version and capability set.`,
      'CONTRIBUTION_UNTRUSTED',
    );
  }
  const entry = path.resolve(packagePath, manifest.entry);
  if (path.relative(packagePath, entry).startsWith('..')) {
    throw new HadamardSdkError('Contribution entry escapes the package root.', 'CONTRIBUTION_ENTRY_ESCAPE');
  }
  const loaded = await import(pathToFileURL(entry).href);
  const exported = (loaded as { createContribution?: unknown; default?: unknown }).createContribution ?? (loaded as { default?: unknown }).default;
  // createContribution may be a factory; either form must yield the contribution object.
  const candidate = typeof exported === 'function' ? exported() : exported;
  if (typeof candidate !== 'object' || candidate === null) {
    throw new HadamardSdkError(
      `Contribution '${manifest.id}' entry must export a contribution object (or createContribution).`,
      'CONTRIBUTION_INVALID_DEFINITION',
    );
  }
  const contribution = candidate as Partial<HadamardRuntimeContribution>;
  if (typeof contribution.id !== 'string' || contribution.id !== manifest.id) {
    throw new HadamardSdkError(
      `Contribution '${manifest.id}' entry id does not match the manifest id.`,
      'CONTRIBUTION_INVALID_DEFINITION',
    );
  }
  if (typeof contribution.apply !== 'function') {
    throw new HadamardSdkError(
      `Contribution '${manifest.id}' entry has no apply() function.`,
      'CONTRIBUTION_INVALID_DEFINITION',
    );
  }
  if (contribution.requires !== undefined && (
    !Array.isArray(contribution.requires)
    || !contribution.requires.every((item) => typeof item === 'string')
  )) {
    throw new HadamardSdkError(
      `Contribution '${manifest.id}' requires must be an array of ids.`,
      'CONTRIBUTION_INVALID_DEFINITION',
    );
  }
  return contribution as HadamardRuntimeContribution;
}

