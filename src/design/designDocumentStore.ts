import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getHadamardProjectSessionDirectory } from '../config/projectSessionDirectory.js';
import {
  DESIGN_FILE_NAME,
  inspectDesignMigration,
  type DesignMigrationInspection,
} from './designMigration.js';

export type DesignMigrationAction = 'migrate-legacy' | 'keep-design' | 'replace-with-legacy' | 'merge-history';

export interface DesignDocumentSnapshot extends DesignMigrationInspection {
  content: string;
  revision: string;
}

function revisionOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function timestampForFile(now: Date): string {
  return now.toISOString().replace(/[:.]/gu, '-');
}

export class DesignDocumentStore {
  constructor(
    readonly projectPath: string,
    readonly homeDir: string,
    private readonly workspacePath = projectPath,
  ) {}

  directory(): string {
    return getHadamardProjectSessionDirectory(this.projectPath, this.homeDir);
  }

  designPath(): string {
    return path.join(this.directory(), DESIGN_FILE_NAME);
  }

  async inspect(): Promise<DesignDocumentSnapshot> {
    let inspection = await inspectDesignMigration(this.directory());
    if (inspection.legacyProgressContent === undefined) {
      const workspaceLegacyPath = path.join(this.workspacePath, '.hadamard', 'PROGRESS.md');
      try {
        const legacyProgressContent = await readFile(workspaceLegacyPath, 'utf8');
        inspection = {
          ...inspection,
          state: inspection.designContent === undefined ? 'legacy-progress' : 'conflict',
          legacyProgressPath: workspaceLegacyPath,
          legacyProgressContent,
          readableContent: inspection.designContent ?? legacyProgressContent,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const content = inspection.readableContent ?? '';
    return { ...inspection, content, revision: revisionOf(content) };
  }

  async write(content: string, options: { expectedRevision?: string; mirror?: boolean } = {}): Promise<string> {
    const current = await this.inspect();
    if (current.state === 'legacy-progress') {
      throw new Error('Legacy PROGRESS.md must be migrated before DESIGN.md can be edited.');
    }
    if (options.expectedRevision && options.expectedRevision !== current.revision) {
      throw new Error('DESIGN.md changed since it was loaded. Reload before saving.');
    }
    await atomicWrite(this.designPath(), content);
    if (options.mirror) {
      await atomicWrite(path.join(this.workspacePath, '.hadamard', DESIGN_FILE_NAME), content);
    }
    return this.designPath();
  }

  async migrate(action: DesignMigrationAction, now = new Date()): Promise<DesignDocumentSnapshot> {
    const current = await this.inspect();
    if (action === 'keep-design') {
      if (current.state !== 'conflict') throw new Error('keep-design requires a DESIGN/PROGRESS conflict.');
      const backupPath = `${current.legacyProgressPath}.${timestampForFile(now)}.bak`;
      await copyFile(current.legacyProgressPath, backupPath);
      await unlink(current.legacyProgressPath);
      return this.inspect();
    }
    if (action === 'migrate-legacy' && current.state !== 'legacy-progress') {
      throw new Error('migrate-legacy requires a legacy-only project.');
    }
    if ((action === 'replace-with-legacy' || action === 'merge-history') && current.state !== 'conflict') {
      throw new Error(`${action} requires a DESIGN/PROGRESS conflict.`);
    }
    if (current.state !== 'legacy-progress' && current.state !== 'conflict') {
      throw new Error('No legacy PROGRESS.md migration is pending.');
    }
    const legacy = current.legacyProgressContent ?? '';
    const content = action === 'merge-history'
      ? `${current.designContent ?? ''}\n\n## History: legacy progress\n\n${legacy}`.trim() + '\n'
      : legacy;
    await atomicWrite(current.designPath, content);
    const backupPath = `${current.legacyProgressPath}.${timestampForFile(now)}.bak`;
    await copyFile(current.legacyProgressPath, backupPath);
    await unlink(current.legacyProgressPath);
    return this.inspect();
  }
}
