import { createHash, randomUUID } from 'node:crypto';

import type { JsonObject } from '../storage-v2/types.js';
import {
  normalizeDesignConfiguration,
  type DesignConfiguration,
} from './designConfiguration.js';
import { decodeZip, encodeZip, type ZipEntry } from './zipCodec.js';

export interface DesignPackageResource {
  path: string;
  mediaType: string;
  size: number;
  sha256: string;
}

export interface DesignPackageManifest {
  schemaVersion: 1;
  documentId: string;
  originDocumentId?: string;
  template: { id: string; version: number };
  exportedAt: string;
  generator: { name: 'Hadamard'; version: string };
  resources: DesignPackageResource[];
  provenance: JsonObject;
}

export interface DesignPackageExport {
  fileName: 'DESIGN.hadamard-design.zip';
  mediaType: 'application/vnd.hadamard.design+zip';
  bytes: Buffer;
  checksum: string;
  manifest: DesignPackageManifest;
}

export interface DesignPackagePreview {
  kind: 'hadamard-package';
  editable: true;
  markdown: string;
  configuration: DesignConfiguration;
  manifest: DesignPackageManifest;
  checksum: string;
  warnings: string[];
  assets: DesignPackageAsset[];
}

export interface DesignPackageAsset {
  path: string;
  mediaType: string;
  bytes: Buffer;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function mediaTypeFor(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function assertAsset(asset: DesignPackageAsset): void {
  if (!/^assets\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(asset.path) || asset.path.includes('/../')) {
    throw new Error(`Unsafe Design asset path: ${asset.path}`);
  }
  if (asset.bytes.length > 5 * 1024 * 1024) throw new Error(`Design asset exceeds 5 MiB: ${asset.path}`);
  const allowed = new Set(['image/png', 'image/jpeg', 'image/webp']);
  if (!allowed.has(asset.mediaType)) throw new Error(`Design asset media type is not allowed: ${asset.mediaType}`);
  if (mediaTypeFor(asset.path) !== asset.mediaType) throw new Error(`Design asset extension does not match MIME: ${asset.path}`);
}

function parseManifest(bytes: Buffer): DesignPackageManifest {
  const raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || typeof raw.documentId !== 'string' || typeof raw.exportedAt !== 'string'
    || !raw.generator || typeof raw.generator !== 'object' || !Array.isArray(raw.resources)
    || !raw.template || typeof raw.template !== 'object') {
    throw new Error('Design package manifest is invalid.');
  }
  const generator = raw.generator as Record<string, unknown>;
  const template = raw.template as Record<string, unknown>;
  if (generator.name !== 'Hadamard' || typeof generator.version !== 'string'
    || typeof template.id !== 'string' || typeof template.version !== 'number') {
    throw new Error('Design package manifest generator or template is invalid.');
  }
  const resources = raw.resources.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Design package resource is invalid.');
    const resource = item as Record<string, unknown>;
    if (typeof resource.path !== 'string' || typeof resource.mediaType !== 'string'
      || typeof resource.size !== 'number' || typeof resource.sha256 !== 'string') {
      throw new Error('Design package resource fields are invalid.');
    }
    return resource as unknown as DesignPackageResource;
  });
  return {
    schemaVersion: 1,
    documentId: raw.documentId,
    ...(typeof raw.originDocumentId === 'string' ? { originDocumentId: raw.originDocumentId } : {}),
    template: { id: template.id, version: template.version },
    exportedAt: raw.exportedAt,
    generator: { name: 'Hadamard', version: generator.version },
    resources,
    provenance: raw.provenance && typeof raw.provenance === 'object' && !Array.isArray(raw.provenance)
      ? raw.provenance as JsonObject : {},
  };
}

function parseChecksums(bytes: Buffer): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of bytes.toString('utf8').split(/\r?\n/u)) {
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})  (.+)$/u);
    if (!match) throw new Error('Design package checksum file is invalid.');
    if (checksums.has(match[2]!)) throw new Error(`Duplicate checksum path: ${match[2]}`);
    checksums.set(match[2]!, match[1]!);
  }
  return checksums;
}

export class DesignPackageService {
  constructor(private readonly generatorVersion: string) {}

  export(
    markdown: string,
    configuration: DesignConfiguration,
    assets: readonly DesignPackageAsset[] = [],
    now = new Date(),
  ): DesignPackageExport {
    for (const asset of assets) assertAsset(asset);
    const configuredAssets = new Map(configuration.assets.map(asset => [asset.path, asset]));
    if (configuredAssets.size !== assets.length) {
      throw new Error('Design configuration asset list does not match supplied export assets.');
    }
    for (const asset of assets) {
      const configured = configuredAssets.get(asset.path);
      if (!configured || configured.mediaType !== asset.mediaType || configured.size !== asset.bytes.length
        || configured.sha256 !== sha256(asset.bytes)) {
        throw new Error(`Design configuration asset descriptor does not match ${asset.path}.`);
      }
    }
    const configBytes = Buffer.from(stableJson(configuration), 'utf8');
    const markdownBytes = Buffer.from(markdown, 'utf8');
    const resources: DesignPackageResource[] = [
      { path: 'DESIGN.md', mediaType: 'text/markdown', size: markdownBytes.length, sha256: sha256(markdownBytes) },
      { path: 'design.config.json', mediaType: 'application/json', size: configBytes.length, sha256: sha256(configBytes) },
      ...assets.map(asset => ({
        path: asset.path, mediaType: asset.mediaType, size: asset.bytes.length, sha256: sha256(asset.bytes),
      })),
    ];
    const manifest: DesignPackageManifest = {
      schemaVersion: 1,
      documentId: configuration.documentId,
      ...(configuration.originDocumentId ? { originDocumentId: configuration.originDocumentId } : {}),
      template: configuration.template,
      exportedAt: now.toISOString(),
      generator: { name: 'Hadamard', version: this.generatorVersion },
      resources,
      provenance: { ...(configuration.provenance ?? {}), exportedBy: 'Hadamard Design' },
    };
    const manifestBytes = Buffer.from(stableJson(manifest), 'utf8');
    const entries: ZipEntry[] = [
      { name: 'manifest.json', data: manifestBytes },
      { name: 'DESIGN.md', data: markdownBytes },
      { name: 'design.config.json', data: configBytes },
      ...assets.map(asset => ({ name: asset.path, data: asset.bytes })),
    ];
    const checksums = [...entries]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(entry => `${sha256(entry.data)}  ${entry.name}`)
      .join('\n') + '\n';
    entries.push({ name: 'checksums.sha256', data: Buffer.from(checksums, 'utf8') });
    const bytes = encodeZip(entries);
    return {
      fileName: 'DESIGN.hadamard-design.zip', mediaType: 'application/vnd.hadamard.design+zip',
      bytes, checksum: sha256(bytes), manifest,
    };
  }

  preview(bytes: Buffer): DesignPackagePreview {
    const entries = decodeZip(bytes);
    const allowedRoots = new Set(['manifest.json', 'DESIGN.md', 'design.config.json', 'checksums.sha256']);
    for (const name of entries.keys()) {
      if (!allowedRoots.has(name) && !name.startsWith('assets/')) throw new Error(`Unexpected Design package entry: ${name}`);
    }
    const required = (name: string): Buffer => {
      const value = entries.get(name);
      if (!value) throw new Error(`Design package is missing ${name}.`);
      return value;
    };
    const manifestBytes = required('manifest.json');
    const markdownBytes = required('DESIGN.md');
    const configBytes = required('design.config.json');
    const checksums = parseChecksums(required('checksums.sha256'));
    for (const [name, entry] of entries) {
      if (name === 'checksums.sha256') continue;
      if (checksums.get(name) !== sha256(entry)) throw new Error(`Design package SHA-256 mismatch: ${name}`);
    }
    if (checksums.size !== entries.size - 1) throw new Error('Design package checksum coverage is incomplete.');
    const manifest = parseManifest(manifestBytes);
    const resourceByPath = new Map(manifest.resources.map(resource => [resource.path, resource]));
    for (const [name, entry] of entries) {
      if (name === 'manifest.json' || name === 'checksums.sha256') continue;
      const resource = resourceByPath.get(name);
      if (!resource || resource.size !== entry.length || resource.sha256 !== sha256(entry)) {
        throw new Error(`Design package manifest does not match ${name}.`);
      }
      if (name.startsWith('assets/')) {
        assertAsset({ path: name, mediaType: resource.mediaType, bytes: entry });
      }
    }
    if (resourceByPath.size !== entries.size - 2) throw new Error('Design package manifest resource coverage is incomplete.');
    const imported = normalizeDesignConfiguration(JSON.parse(configBytes.toString('utf8')));
    if (imported.documentId !== manifest.documentId || imported.template.id !== manifest.template.id
      || imported.template.version !== manifest.template.version) {
      throw new Error('Design package configuration and manifest identities do not match.');
    }
    const importedAssets = new Map(imported.assets.map(asset => [asset.path, asset]));
    const packageAssets = [...entries].filter(([name]) => name.startsWith('assets/'));
    if (importedAssets.size !== packageAssets.length) {
      throw new Error('Design package configuration asset coverage is incomplete.');
    }
    for (const [assetPath, assetBytes] of packageAssets) {
      const configured = importedAssets.get(assetPath);
      const resource = resourceByPath.get(assetPath)!;
      if (!configured || configured.mediaType !== resource.mediaType || configured.size !== assetBytes.length
        || configured.sha256 !== sha256(assetBytes)) {
        throw new Error(`Design package configuration asset does not match ${assetPath}.`);
      }
    }
    const configuration: DesignConfiguration = {
      ...imported,
      documentId: randomUUID(),
      originDocumentId: manifest.documentId,
      provenance: {
        ...(imported.provenance ?? {}),
        importedAt: new Date().toISOString(),
        sourceChecksum: sha256(bytes),
        sourceGenerator: manifest.generator.version,
      },
    };
    return {
      kind: 'hadamard-package', editable: true, markdown: markdownBytes.toString('utf8'), configuration,
      manifest, checksum: sha256(bytes), warnings: [],
      assets: [...entries]
        .filter(([name]) => name.startsWith('assets/'))
        .map(([assetPath, assetBytes]) => ({
          path: assetPath,
          mediaType: resourceByPath.get(assetPath)!.mediaType,
          bytes: Buffer.from(assetBytes),
        })),
    };
  }
}
