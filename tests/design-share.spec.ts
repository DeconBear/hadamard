import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createDesignConfiguration,
  DesignImportExportService,
  DesignShareService,
  type DesignArtifact,
  type DesignArtifactRepository,
} from '../src/design/index.js';
import type { JsonObject } from '../src/storage-v2/types.js';

class MemoryArtifactRepository implements DesignArtifactRepository {
  readonly values = new Map<string, DesignArtifact>();

  async putImmutable(mediaType: string, bytes: Buffer, metadata: JsonObject): Promise<DesignArtifact> {
    const { createHash } = await import('node:crypto');
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const id = `design-${checksum}`;
    const value = { id, mediaType, bytes: Buffer.from(bytes), checksum, metadata };
    this.values.set(id, value);
    return value;
  }

  async get(id: string): Promise<DesignArtifact | undefined> {
    return this.values.get(id);
  }
}

describe('immutable Design shares', () => {
  it('stores three content-addressed artifacts and enforces expiry and revocation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-design-share-'));
    const repository = new MemoryArtifactRepository();
    const service = new DesignShareService(
      path.join(directory, 'shares.json'), repository, new DesignImportExportService(undefined, 'test'),
    );
    const now = new Date('2026-08-11T00:00:00.000Z');
    const created = await service.create({
      markdown: '# Shared\n\nImmutable.', configuration: createDesignConfiguration(),
    }, 'revision-1', 24, now);
    expect(Object.keys(created.snapshot.artifacts).sort()).toEqual(['html', 'package', 'pdf']);
    expect(repository.values.size).toBe(3);
    const resolved = await service.resolve(created.token, new Date('2026-08-11T01:00:00.000Z'));
    expect(resolved.permission).toBe('design.snapshot.read');
    const designPackage = await service.download(created.token, 'package', new Date('2026-08-11T01:00:00.000Z'));
    expect(designPackage.bytes.subarray(0, 2).toString('ascii')).toBe('PK');
    const ledger = await readFile(path.join(directory, 'shares.json'), 'utf8');
    expect(ledger).not.toContain(created.token);

    await expect(service.resolve(created.token, new Date('2026-08-12T00:00:01.000Z'))).rejects.toThrow(/expired/u);
    await service.revoke(created.token, new Date('2026-08-11T02:00:00.000Z'));
    await expect(service.resolve(created.token, new Date('2026-08-11T03:00:00.000Z'))).rejects.toThrow(/revoked/u);
  });
});
