import { createHash } from 'node:crypto';

import type { ArtifactStore } from '../storage-v2/contracts.js';
import { SqliteStorageV2 } from '../storage-v2/sqliteStorage.js';
import type { JsonObject } from '../storage-v2/types.js';

export interface DesignArtifact {
  id: string;
  mediaType: string;
  bytes: Buffer;
  checksum: string;
  metadata: JsonObject;
}

export interface DesignArtifactRepository {
  putImmutable(mediaType: string, bytes: Buffer, metadata: JsonObject): Promise<DesignArtifact>;
  get(id: string): Promise<DesignArtifact | undefined>;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class StorageV2DesignArtifactRepository implements DesignArtifactRepository {
  constructor(private readonly store: ArtifactStore, private readonly tenantId: string) {}

  async putImmutable(mediaType: string, bytes: Buffer, metadata: JsonObject): Promise<DesignArtifact> {
    const checksum = sha256(bytes);
    const id = `design-${checksum}`;
    const existing = await this.store.get({ tenantId: this.tenantId, artifactId: id });
    if (existing) {
      if (existing.sha256 !== checksum || existing.mediaType !== mediaType) {
        throw new Error(`Immutable Design artifact collision: ${id}`);
      }
      return { id, mediaType: existing.mediaType, bytes: Buffer.from(existing.data), checksum, metadata: existing.metadata };
    }
    const stored = await this.store.put({
      tenantId: this.tenantId, artifactId: id, expectedRevision: null, mediaType, data: bytes, metadata,
    });
    return { id, mediaType: stored.mediaType, bytes: Buffer.from(stored.data), checksum: stored.sha256, metadata: stored.metadata };
  }

  async get(id: string): Promise<DesignArtifact | undefined> {
    const stored = await this.store.get({ tenantId: this.tenantId, artifactId: id });
    return stored
      ? { id, mediaType: stored.mediaType, bytes: Buffer.from(stored.data), checksum: stored.sha256, metadata: stored.metadata }
      : undefined;
  }
}

export class SqliteDesignArtifactRepository implements DesignArtifactRepository {
  constructor(private readonly filename: string, private readonly tenantId = 'local-design') {}

  private async use<T>(operation: (repository: StorageV2DesignArtifactRepository) => Promise<T>): Promise<T> {
    const storage = await SqliteStorageV2.open({ filename: this.filename });
    try {
      return await operation(new StorageV2DesignArtifactRepository(storage.artifacts, this.tenantId));
    } finally {
      await storage.close();
    }
  }

  putImmutable(mediaType: string, bytes: Buffer, metadata: JsonObject): Promise<DesignArtifact> {
    return this.use(repository => repository.putImmutable(mediaType, bytes, metadata));
  }

  get(id: string): Promise<DesignArtifact | undefined> {
    return this.use(repository => repository.get(id));
  }
}
