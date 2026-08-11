import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { DeviceLinkAuditRecord } from './types.js';

export class DeviceLinkAuditStore {
  private queue = Promise.resolve();

  constructor(private readonly file: string) {}

  async append(record: DeviceLinkAuditRecord): Promise<void> {
    const next = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await appendFile(this.file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async list(limit = 200): Promise<DeviceLinkAuditRecord[]> {
    try {
      const lines = (await readFile(this.file, 'utf8')).split(/\r?\n/u).filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(limit, 2_000)))
        .map(line => JSON.parse(line) as DeviceLinkAuditRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
