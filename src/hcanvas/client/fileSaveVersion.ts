export interface FileWriteVersion {
  hash?: string;
  mtime?: number;
}

export interface FileConflictInfo {
  message: string;
  hash?: string;
  mtime?: number;
}

interface FileWriteRequest {
  <T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T>;
}

export function fileConflictFromError(error: unknown): FileConflictInfo | null {
  const shape = error as { status?: number; payload?: { code?: string; error?: string; currentHash?: string; currentMtime?: number } } | null;
  if (shape?.status !== 409 || shape.payload?.code !== 'file_conflict') return null;
  return {
    message: shape.payload.error || 'File changed on disk after it was opened.',
    ...(typeof shape.payload.currentHash === 'string' ? { hash: shape.payload.currentHash } : {}),
    ...(typeof shape.payload.currentMtime === 'number' ? { mtime: shape.payload.currentMtime } : {}),
  };
}

/** Write with an optional read-time hash/mtime; returns the new version token. */
export async function writeFileWithVersion(
  request: FileWriteRequest,
  input: { rootId: string; path: string; content: string; version?: FileWriteVersion },
): Promise<FileWriteVersion> {
  const result = await request<{ file?: FileWriteVersion }>('/api/files/write', {
    method: 'POST',
    body: JSON.stringify({
      root: input.rootId,
      path: input.path,
      content: input.content,
      ...(input.version?.hash === undefined ? {} : { expectedHash: input.version.hash }),
      ...(input.version?.mtime === undefined ? {} : { expectedMtime: input.version.mtime }),
    }),
  });
  return result.file || {};
}
