import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from '../storage/atomicJsonWrite.js';
import type { JsonObject } from '../storage-v2/types.js';
import { resolveDesignTheme, type DesignThemeTokens } from './designTheme.js';

export interface DesignAssetDescriptor {
  path: string;
  mediaType: string;
  sha256: string;
  size: number;
}

export interface DesignConfiguration {
  version: 1;
  documentId: string;
  originDocumentId?: string;
  provenance?: JsonObject;
  template: { id: string; version: number };
  theme: { id: string; tokens: DesignThemeTokens };
  sections: { order: string[]; hidden: string[] };
  assets: DesignAssetDescriptor[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.length <= 120) : [];
}

export function createDesignConfiguration(
  templateId = 'software.general',
  themeId = 'clean-light',
): DesignConfiguration {
  const theme = resolveDesignTheme(themeId);
  return {
    version: 1,
    documentId: randomUUID(),
    template: { id: templateId, version: 1 },
    theme: { id: theme.id, tokens: theme.tokens },
    sections: { order: [], hidden: [] },
    assets: [],
  };
}

export function normalizeDesignConfiguration(value: unknown): DesignConfiguration {
  if (!isRecord(value)) return createDesignConfiguration();
  const template = isRecord(value.template) ? value.template : {};
  const themeInput = isRecord(value.theme) ? value.theme : {};
  const themeId = typeof themeInput.id === 'string' ? themeInput.id : 'clean-light';
  const theme = resolveDesignTheme(themeId, isRecord(themeInput.tokens) ? themeInput.tokens : {});
  const sections = isRecord(value.sections) ? value.sections : {};
  const assets = Array.isArray(value.assets) ? value.assets.flatMap(item => {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.mediaType !== 'string'
      || typeof item.sha256 !== 'string' || typeof item.size !== 'number') return [];
    return [{ path: item.path, mediaType: item.mediaType, sha256: item.sha256, size: item.size }];
  }) : [];
  return {
    version: 1,
    documentId: typeof value.documentId === 'string' && value.documentId.trim() ? value.documentId : randomUUID(),
    ...(typeof value.originDocumentId === 'string' && value.originDocumentId.trim()
      ? { originDocumentId: value.originDocumentId } : {}),
    ...(isRecord(value.provenance) ? { provenance: value.provenance as JsonObject } : {}),
    template: {
      id: typeof template.id === 'string' && template.id.trim() ? template.id : 'software.general',
      version: typeof template.version === 'number' && Number.isSafeInteger(template.version) && template.version > 0
        ? template.version : 1,
    },
    theme: { id: theme.id, tokens: theme.tokens },
    sections: { order: stringArray(sections.order), hidden: stringArray(sections.hidden) },
    assets,
  };
}

export class DesignConfigurationStore {
  constructor(private readonly directory: string) {}

  path(): string {
    return path.join(this.directory, 'design.config.json');
  }

  async load(templateId?: string, themeId?: string): Promise<DesignConfiguration> {
    try {
      return normalizeDesignConfiguration(JSON.parse(await readFile(this.path(), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return createDesignConfiguration(templateId, themeId);
    }
  }

  async save(configuration: DesignConfiguration): Promise<void> {
    await writeJsonAtomic(this.path(), normalizeDesignConfiguration(configuration));
  }

  async ensure(templateId?: string, themeId?: string): Promise<DesignConfiguration> {
    try {
      return normalizeDesignConfiguration(JSON.parse(await readFile(this.path(), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const created = createDesignConfiguration(templateId, themeId);
      await this.save(created);
      return created;
    }
  }
}
