import { createHash } from 'node:crypto';
import path from 'node:path';

import { resolveHadamardHome } from '../config/hadamardHome.js';
import { parseCrushSessionReferenceDetails } from './crushSessionHistory.js';
import type {
  ExternalCliRuntime,
  ExternalCliSessionSummary,
} from './externalCliSessionTypes.js';

const MANAGED_PROFILE_ID_PATTERN = /^[0-9a-f]{64}$/u;
const ISOLATED_MANAGED_PROFILE_RUNTIMES = new Set<ExternalCliRuntime>([
  'pi',
  'codewhale',
  'reasonix',
  'crush',
]);

export interface ExternalCliSessionConfigIdentity {
  runtime: ExternalCliRuntime;
  authSource?: 'native' | 'apiKey';
  profileName?: string;
}

export interface ExternalCliProfileBindingOptions {
  homeDir?: string;
  hadamardHomeDir?: string;
}

export function namedExternalCliManagedProfileId(
  runtime: ExternalCliRuntime,
  profileName: string,
): string {
  const normalizedName = profileName.trim();
  if (!normalizedName) throw new TypeError('External CLI managed profile name is required.');
  return createHash('sha256')
    .update(`${runtime}\0name:${normalizedName}`)
    .digest('hex');
}

function resolveManagedHadamardHome(options: ExternalCliProfileBindingOptions): string {
  return options.hadamardHomeDir?.trim()
    ? resolveHadamardHome(options.hadamardHomeDir, { inputKind: 'dataRoot' })
    : resolveHadamardHome(options.homeDir);
}

function sessionManagedProfileId(
  summary: Pick<ExternalCliSessionSummary, 'runtime' | 'path'>,
  options: ExternalCliProfileBindingOptions,
): string | undefined {
  if (summary.runtime === 'crush') {
    return parseCrushSessionReferenceDetails(summary.path)?.managedProfileId;
  }
  if (!ISOLATED_MANAGED_PROFILE_RUNTIMES.has(summary.runtime)) return undefined;
  const runtimeRoot = path.resolve(
    resolveManagedHadamardHome(options),
    'external-cli-profiles',
    summary.runtime,
  );
  const relative = path.relative(runtimeRoot, path.resolve(summary.path));
  if (
    !relative
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    return undefined;
  }
  const [profileId] = relative.split(path.sep);
  return MANAGED_PROFILE_ID_PATTERN.test(profileId ?? '') ? profileId : undefined;
}

export function externalCliSessionMatchesConfig(
  summary: Pick<ExternalCliSessionSummary, 'runtime' | 'path'>,
  config: ExternalCliSessionConfigIdentity,
  options: ExternalCliProfileBindingOptions = {},
): boolean {
  if (summary.runtime !== config.runtime) return false;
  if (!ISOLATED_MANAGED_PROFILE_RUNTIMES.has(summary.runtime)) return true;
  const actualProfileId = sessionManagedProfileId(summary, options);
  if (config.authSource !== 'apiKey') return actualProfileId === undefined;
  if (!config.profileName?.trim()) return false;
  return actualProfileId === namedExternalCliManagedProfileId(
    summary.runtime,
    config.profileName,
  );
}
