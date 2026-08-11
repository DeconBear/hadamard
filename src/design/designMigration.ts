import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DESIGN_FILE_NAME = 'DESIGN.md';
export const LEGACY_PROGRESS_FILE_NAME = 'PROGRESS.md';

export type DesignMigrationState = 'empty' | 'design' | 'legacy-progress' | 'conflict';

export interface DesignMigrationInspection {
  state: DesignMigrationState;
  designPath: string;
  legacyProgressPath: string;
  designContent?: string;
  legacyProgressContent?: string;
  readableContent?: string;
}

export async function inspectDesignMigration(
  projectStoreDirectory: string,
): Promise<DesignMigrationInspection> {
  const designPath = path.join(projectStoreDirectory, DESIGN_FILE_NAME);
  const legacyProgressPath = path.join(projectStoreDirectory, LEGACY_PROGRESS_FILE_NAME);
  const [designContent, legacyProgressContent] = await Promise.all([
    readOptionalUtf8(designPath),
    readOptionalUtf8(legacyProgressPath),
  ]);
  const base = { designPath, legacyProgressPath, designContent, legacyProgressContent };

  if (designContent !== undefined && legacyProgressContent !== undefined) {
    return { ...base, state: 'conflict', readableContent: designContent };
  }
  if (designContent !== undefined) {
    return { ...base, state: 'design', readableContent: designContent };
  }
  if (legacyProgressContent !== undefined) {
    return { ...base, state: 'legacy-progress', readableContent: legacyProgressContent };
  }
  return { ...base, state: 'empty' };
}

async function readOptionalUtf8(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
