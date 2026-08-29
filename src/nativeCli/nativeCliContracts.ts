import type {
  HadamardBridgeJsonEvent,
  HadamardBridgeRunOptions,
  HadamardBridgeRunResult,
} from '../types.js';

export type HadamardOwnedNativeCliRuntime =
  | 'claude' | 'codewhale' | 'codex' | 'cursor' | 'pi' | 'reasonix';

export interface HadamardNativeCliClientOptions {
  runtime: HadamardOwnedNativeCliRuntime;
  model?: string;
  executable?: string;
  cliPath?: string;
  workDir?: string;
  env?: Record<string, string>;
  homeDir?: string;
  credentialProvider?: string;
  trustProjectResources?: boolean;
  profileName?: string;
}

export interface NativeCliRunStream extends AsyncIterable<HadamardBridgeJsonEvent> {
  readonly result: Promise<HadamardBridgeRunResult>;
}

export interface NativeCliClient {
  stream(prompt: string, options?: HadamardBridgeRunOptions): NativeCliRunStream;
  close(): Promise<void>;
}
