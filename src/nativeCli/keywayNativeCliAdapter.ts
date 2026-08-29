import { createHadamardBridgeSdk } from '../parity/hadamardBridgeSdk.js';
import {
  probeExternalCliAuth,
  type ExternalCliAuthProbeOptions,
  type ExternalCliAuthStatus,
} from './nativeCliAuth.js';
import {
  findBridgeConfig,
  isManagedExternalCliRuntime,
  type ManagedExternalCliRuntime,
} from '../parity/bridgeConfigs.js';
import type {
  HadamardBridgeJsonEvent,
  HadamardBridgeRunOptions,
  HadamardBridgeRunResult,
} from '../types.js';
import { createNativeCliClient } from './nativeCliClient.js';

export interface HadamardNativeCliTarget {
  runtime: string;
  configId?: string;
  profileName?: string;
}

export interface NativeCliRunStreamPort extends AsyncIterable<HadamardBridgeJsonEvent> {
  result: Promise<HadamardBridgeRunResult>;
}

export interface NativeCliClientPort {
  stream(prompt: string, options?: HadamardBridgeRunOptions): NativeCliRunStreamPort;
  close(): Promise<void>;
}

export type NativeCliClientFactory = (
  target: HadamardNativeCliTarget,
  model: string,
) => Promise<NativeCliClientPort>;

export interface HadamardNativeCliAdapterOptions {
  homeDir?: string;
  workDir?: string;
  executable?: string;
  cliPath?: string;
  env?: Record<string, string>;
}

export type { ExternalCliAuthProbeOptions, ExternalCliAuthStatus } from './nativeCliAuth.js';

/** Status-only native auth probe; OAuth/session secrets stay owned by the CLI. */
export function probeHadamardNativeCliAuth(
  target: HadamardNativeCliTarget,
  options: ExternalCliAuthProbeOptions = {},
): Promise<ExternalCliAuthStatus> {
  if (!isManagedExternalCliRuntime(target.runtime as ManagedExternalCliRuntime)) {
    return Promise.reject(new TypeError(`Unsupported native CLI runtime: ${target.runtime}`));
  }
  return probeExternalCliAuth(target.runtime as ManagedExternalCliRuntime, options);
}

/** Create a native-auth CLI client without importing OAuth/session material. */
export async function createHadamardNativeCliClient(
  target: HadamardNativeCliTarget,
  model: string,
  options: HadamardNativeCliAdapterOptions = {},
): Promise<NativeCliClientPort> {
  if (!isManagedExternalCliRuntime(target.runtime as ManagedExternalCliRuntime)) {
    throw Object.assign(new Error(`Unsupported native CLI runtime: ${target.runtime}`), { retryable: false });
  }
  if (target.runtime === 'claude' || target.runtime === 'codex') {
    return createNativeCliClient({
      runtime: target.runtime,
      model,
      workDir: options.workDir,
      executable: options.executable,
      cliPath: options.cliPath,
      env: options.env,
    });
  }
  const config = target.configId ? findBridgeConfig(target.configId, options.homeDir) : undefined;
  return createHadamardBridgeSdk({
    directCli: true,
    directCliProvider: target.runtime as ManagedExternalCliRuntime,
    authSource: 'native',
    profileName: target.profileName ?? target.configId,
    homeDir: options.homeDir,
    workDir: options.workDir,
    executable: options.executable,
    cliPath: options.cliPath,
    env: options.env,
    model,
    trustProjectResources: config?.trustProjectResources,
  });
}
