import {
  createNativeCliClient,
  type NativeCliClient,
} from '../nativeCli/nativeCliClient.js';
import type {
  CreateHadamardBridgeSdkOptions,
  HadamardBridgeJsonEvent,
  HadamardBridgeRunOptions,
  HadamardBridgeRunResult,
  RuntimeProviderId,
} from '../types.js';

export type { NativeCliClient } from '../nativeCli/nativeCliClient.js';

export function createNativeCliBridgeDelegate(
  provider: RuntimeProviderId,
  executable: string,
  cliPath: string,
  options: CreateHadamardBridgeSdkOptions,
): Promise<NativeCliClient> | undefined {
  if ((options.authSource ?? 'native') !== 'native') return undefined;
  if (provider !== 'claude' && provider !== 'codex' && provider !== 'cursor') return undefined;
  return createNativeCliClient({
    runtime: provider,
    model: options.model,
    executable,
    cliPath,
    workDir: options.workDir,
    env: options.env,
  });
}

export async function relayNativeCliRun(
  client: NativeCliClient,
  prompt: string,
  options: HadamardBridgeRunOptions,
  emit: (event: HadamardBridgeJsonEvent) => void,
): Promise<HadamardBridgeRunResult> {
  const stream = client.stream(prompt, options);
  const observed = stream.result.then(
    result => ({ ok: true as const, result }),
    error => ({ ok: false as const, error }),
  );
  try {
    for await (const event of stream) emit(event);
  } catch (error) {
    await observed;
    throw error;
  }
  const outcome = await observed;
  if (!outcome.ok) throw outcome.error;
  return outcome.result;
}
