import type {
  ExternalCliRuntime,
  ExternalCliSession,
} from './externalCliSessionTypes.js';

export interface ExternalCliSessionParseBounds {
  maxBytes: number;
  maxMessages: number;
}

export interface ExternalCliSessionFileMetadata {
  size: number;
  birthtimeMs: number;
  mtimeMs: number;
}

/** Minimal parser contract shared by file-backed external CLI runtimes. */
export interface ExternalCliSessionCodec<
  TRuntime extends ExternalCliRuntime = ExternalCliRuntime,
> {
  readonly runtime: TRuntime;
  parse(
    filePath: string,
    bounds: ExternalCliSessionParseBounds,
    fileInfo: ExternalCliSessionFileMetadata,
  ): Promise<ExternalCliSession | undefined>;
}
