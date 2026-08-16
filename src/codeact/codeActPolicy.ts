import os from 'node:os';

import { HadamardSdkError } from '../errors.js';
import type {
  CodeActBackendStatus,
  CodeActKernelAdapter,
  CodeActSettings,
  ResolvedCodeActSettings,
} from './types.js';

const SECRET_ENV_PATTERN = /(api[_-]?key|token|secret|password|credential|auth)/i;
const SAFE_PROCESS_ENV = process.platform === 'win32'
  ? ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT']
  : ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR'];

export class CodeActConfigurationError extends HadamardSdkError {
  constructor(message: string, code: 'CODEACT_DISABLED' | 'CODEACT_BACKEND_UNAVAILABLE' | 'CODEACT_UNSAFE_BACKEND') {
    super(message, code);
  }
}

export function resolveCodeActSettings(input: CodeActSettings): ResolvedCodeActSettings {
  return {
    enabled: input.enabled,
    backend: input.backend ?? 'process',
    ptcBackend: input.ptcBackend ?? input.backend ?? 'process',
    securityMode: input.securityMode ?? 'trusted',
    pythonCommand: input.pythonCommand?.trim() || (process.platform === 'win32' ? 'python' : 'python3'),
    idleTimeoutMs: clampInteger(input.idleTimeoutMs, 60_000, 1_000, 3_600_000),
    executionTimeoutMs: clampInteger(input.executionTimeoutMs, 120_000, 100, 3_600_000),
    maxOutputChars: clampInteger(input.maxOutputChars, 80_000, 1_000, 10_000_000),
    maxOutputBytes: clampInteger(
      input.maxOutputBytes,
      (input.maxOutputChars ?? 80_000) * 4,
      1_000,
      40_000_000,
    ),
    environmentAllowlist: uniqueStrings(input.environmentAllowlist ?? []),
    containerImage: input.containerImage?.trim() || 'python:3.12-alpine',
    containerMemoryMb: clampInteger(input.containerMemoryMb, 512, 64, 32_768),
    containerCpuLimit: clampNumber(input.containerCpuLimit, 1, 0.1, 64),
    maxParallelSubCalls: clampInteger(input.maxParallelSubCalls, 8, 1, 32),
  };
}

export function buildCodeActEnvironment(
  allowlist: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const key of uniqueStrings([...SAFE_PROCESS_ENV, ...allowlist])) {
    if (SECRET_ENV_PATTERN.test(key)) continue;
    const value = source[key];
    if (typeof value === 'string') output[key] = value;
  }
  output.PYTHONIOENCODING = 'utf-8';
  output.PYTHONUNBUFFERED = '1';
  output.HADAMARD_CODEACT = '1';
  output.HADAMARD_PLATFORM = `${os.platform()}-${os.arch()}`;
  return output;
}

export async function assertCodeActBackend(
  settings: ResolvedCodeActSettings,
  adapter: CodeActKernelAdapter,
): Promise<CodeActBackendStatus> {
  if (!settings.enabled) {
    throw new CodeActConfigurationError('CodeAct is disabled for this project.', 'CODEACT_DISABLED');
  }
  const status = await adapter.selfCheck();
  if (!status.available) {
    throw new CodeActConfigurationError(status.detail, 'CODEACT_BACKEND_UNAVAILABLE');
  }
  if (settings.securityMode === 'enforce' && adapter.isolation !== 'strong') {
    throw new CodeActConfigurationError(
      'CodeAct enforce mode requires an available strong-isolation container backend.',
      'CODEACT_UNSAFE_BACKEND',
    );
  }
  return status;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value!)));
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value!));
}

/**
 * Assert the worker-thread PTC backend: it is containment, not a security
 * boundary, so enforce mode (which requires strong isolation) refuses it.
 */
export function assertWorkerThreadPtcBackend(settings: ResolvedCodeActSettings): void {
  if (!settings.enabled) {
    throw new CodeActConfigurationError('CodeAct is disabled for this project.', 'CODEACT_DISABLED');
  }
  if (settings.securityMode === 'enforce') {
    throw new CodeActConfigurationError(
      'CodeAct enforce mode requires a strong-isolation container backend; the worker-thread backend is containment only.',
      'CODEACT_UNSAFE_BACKEND',
    );
  }
}
