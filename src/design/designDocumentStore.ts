import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getHadamardProjectSessionDirectory } from '../config/projectSessionDirectory.js';
export const DESIGN_FILE_NAME = 'DESIGN.md';

export interface DesignDocumentSnapshot {
  content: string;
  revision: string;
  state: 'empty' | 'design';
  designPath: string;
  designContent?: string;
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
    const designPath = this.designPath();
    let content = '';
    try {
      content = await readFile(designPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return {
      content,
      revision: revisionOf(content),
      state: content ? 'design' : 'empty',
      designPath,
      ...(content ? { designContent: content } : {}),
    };
  }

  async write(content: string, options: { expectedRevision?: string; mirror?: boolean } = {}): Promise<string> {
    const current = await this.inspect();
    if (options.expectedRevision && options.expectedRevision !== current.revision) {
      throw new Error('DESIGN.md changed since it was loaded. Reload before saving.');
    }
    await atomicWrite(this.designPath(), content);
    if (options.mirror) {
      await atomicWrite(path.join(this.workspacePath, '.hadamard', DESIGN_FILE_NAME), content);
    }
    return this.designPath();
  }

}
