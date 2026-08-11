import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createDesignConfiguration,
  normalizeDesignConfiguration,
  type DesignConfiguration,
  type DesignConfigurationStore,
} from './designConfiguration.js';
import type { DesignDocumentStore } from './designDocumentStore.js';
import type { DesignArtifactRepository } from './designArtifactRepository.js';
import type { DesignImportPreview } from './designImportExportService.js';

export type DesignImportAction = 'new-copy' | 'replace-current' | 'merge-sections';

export interface DesignImportCommitResult {
  action: DesignImportAction;
  designPath: string;
  configurationPath: string;
  configuration: DesignConfiguration;
}

function sections(source: string): Map<string, string> {
  const result = new Map<string, string>();
  const matches = [...source.matchAll(/^##\s+(.+)$/gmu)];
  for (let index = 0; index < matches.length; index += 1) {
    const title = matches[index]![1]!.trim();
    const start = matches[index]!.index!;
    const end = matches[index + 1]?.index ?? source.length;
    result.set(title.toLocaleLowerCase(), source.slice(start, end).trimEnd());
  }
  return result;
}

export function mergeDesignSections(current: string, imported: string): string {
  const currentSections = sections(current);
  const additions: string[] = [];
  for (const [key, block] of sections(imported)) {
    if (!currentSections.has(key)) additions.push(block);
  }
  if (additions.length === 0) return current;
  return `${current.trimEnd()}\n\n## Imported sections\n\n${additions.join('\n\n')}\n`;
}

async function exists(filePath: string): Promise<boolean> {
  try { await readFile(filePath); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function replacePair(
  designPath: string,
  design: string,
  configurationPath: string,
  configuration: DesignConfiguration,
): Promise<void> {
  await mkdir(path.dirname(designPath), { recursive: true });
  const transaction = randomUUID();
  const designTemp = `${designPath}.${transaction}.tmp`;
  const configTemp = `${configurationPath}.${transaction}.tmp`;
  const designBackup = `${designPath}.${transaction}.rollback`;
  const configBackup = `${configurationPath}.${transaction}.rollback`;
  await writeFile(designTemp, design, { encoding: 'utf8', flag: 'wx' });
  await writeFile(configTemp, `${JSON.stringify(configuration, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const hadDesign = await exists(designPath);
  const hadConfig = await exists(configurationPath);
  try {
    if (hadDesign) await rename(designPath, designBackup);
    if (hadConfig) await rename(configurationPath, configBackup);
    await rename(designTemp, designPath);
    await rename(configTemp, configurationPath);
    await rm(designBackup, { force: true });
    await rm(configBackup, { force: true });
  } catch (error) {
    await rm(designTemp, { force: true }).catch(() => undefined);
    await rm(configTemp, { force: true }).catch(() => undefined);
    if (await exists(designBackup)) {
      await rm(designPath, { force: true }).catch(() => undefined);
      await rename(designBackup, designPath).catch(() => undefined);
    }
    if (await exists(configBackup)) {
      await rm(configurationPath, { force: true }).catch(() => undefined);
      await rename(configBackup, configurationPath).catch(() => undefined);
    }
    throw error;
  }
}

export class DesignImportCommitService {
  constructor(
    private readonly documents: DesignDocumentStore,
    private readonly configurations: DesignConfigurationStore,
    private readonly artifacts?: DesignArtifactRepository,
  ) {}

  async commit(
    preview: DesignImportPreview,
    action: DesignImportAction,
    expectedRevision: string,
  ): Promise<DesignImportCommitResult> {
    if (!preview.editable || typeof preview.markdown !== 'string') {
      throw new Error('Read-only references cannot replace DESIGN.md.');
    }
    const current = await this.documents.inspect();
    if (current.revision !== expectedRevision) throw new Error('DESIGN.md changed since import preview.');
    if (current.state === 'legacy-progress' || current.state === 'conflict') {
      throw new Error('Resolve legacy DESIGN/PROGRESS migration before importing.');
    }
    const currentConfiguration = await this.configurations.load();
    const importedConfiguration = preview.configuration
      ? normalizeDesignConfiguration(preview.configuration)
      : createDesignConfiguration();
    const content = action === 'merge-sections'
      ? mergeDesignSections(current.content, preview.markdown)
      : preview.markdown;
    const configuration: DesignConfiguration = action === 'merge-sections'
      ? {
        ...currentConfiguration,
        provenance: {
          ...(currentConfiguration.provenance ?? {}),
          mergedFromDocumentId: preview.manifest?.documentId ?? importedConfiguration.documentId,
          mergedFromChecksum: preview.checksum,
          mergedAt: new Date().toISOString(),
        },
      }
      : {
        ...importedConfiguration,
        documentId: randomUUID(),
        originDocumentId: preview.manifest?.documentId ?? importedConfiguration.originDocumentId,
        provenance: {
          ...(importedConfiguration.provenance ?? {}), importedChecksum: preview.checksum,
          importAction: action, importedAt: new Date().toISOString(),
        },
      };
    if (preview.assets?.length && this.artifacts) {
      await Promise.all(preview.assets.map(asset => this.artifacts!.putImmutable(asset.mediaType, asset.bytes, {
        kind: 'design-import-asset', path: asset.path, sourceChecksum: preview.checksum,
      })));
    }
    await replacePair(this.documents.designPath(), content, this.configurations.path(), configuration);
    return {
      action, designPath: this.documents.designPath(), configurationPath: this.configurations.path(), configuration,
    };
  }
}
