import { Buffer } from 'node:buffer';
import type { Dirent, Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveHadamardHome } from '../config/hadamardHome.js';
import { HadamardSdkError } from '../errors.js';
import {
  isCrushSessionReference,
  listCrushSessionHistory,
  parseCrushSessionReferenceDetails,
  readCrushSessionHistory,
  type CrushHistoryCommandRunner,
  type CrushSessionHistoryOptions,
} from './crushSessionHistory.js';
import type {
  ExternalCliRuntime,
  ExternalCliSession,
  ExternalCliSessionSummary,
} from './externalCliSessionTypes.js';
export {
  externalCliSessionMatchesConfig,
  namedExternalCliManagedProfileId,
  type ExternalCliSessionConfigIdentity,
} from './externalCliProfileBinding.js';
export type {
  ExternalCliRuntime,
  ExternalCliSession,
  ExternalCliSessionMessage,
  ExternalCliSessionRole,
  ExternalCliSessionSummary,
  ExternalCliToolMetadata,
} from './externalCliSessionTypes.js';
import {
  resolveReasonixSessionRoots,
} from './reasonixSessionParser.js';
import type { ExternalCliSessionParseBounds as ParseBounds } from './externalCliSessionCodec.js';
import {
  codewhaleExternalCliSessionCodec,
  readCodewhaleSessionMetadata,
} from './codewhaleExternalCliSessionCodec.js';
import { createLegacyExternalCliSessionCodec } from './legacyExternalCliSessionCodec.js';
import { reasonixExternalCliSessionCodec } from './reasonixExternalCliSessionCodec.js';
import {
  nodeExternalCliSessionFileStore,
  type ExternalCliSessionFileCandidate as SessionFileCandidate,
  type ExternalCliSessionRoot as RootSpec,
} from './externalCliSessionFileStore.js';

const {
  collectCodewhaleSessionFiles,
  collectJsonlFiles,
  collectReasonixSessionFiles,
  inspectSessionFile,
  isPathInside,
  isSessionFileForRuntime,
  resolveDirectory,
  resolveFile,
  sameResolvedPath,
} = nodeExternalCliSessionFileStore;

export interface ExternalCliSessionOptions {
  /** Used only to derive the default Claude, Codex, Pi, CodeWhale, and Reasonix session roots. */
  homeDir?: string;
  /** Direct Hadamard data root used for isolated managed-profile history. */
  hadamardHomeDir?: string;
  claudeRoot?: string;
  codexRoot?: string;
  piRoot?: string;
  codewhaleRoot?: string;
  reasonixRoot?: string;
  /** Crush history is command-backed and scoped to this project directory. */
  crushCwd?: string;
  crushExecutable?: string;
  crushEnv?: Record<string, string>;
  crushCommandRunner?: CrushHistoryCommandRunner;
  /** Optional runtime filter applied before any session file is opened. */
  runtimes?: ExternalCliRuntime[];
  /** Optional pagination applied after files are sorted by filesystem modification time. */
  limit?: number;
  offset?: number;
  /** Bounds for the lightweight scan used by listExternalCliSessions. */
  summaryMaxBytes?: number;
  summaryMaxMessages?: number;
  /** Bounds for the transcript scan used by readExternalCliSession. */
  detailMaxBytes?: number;
  detailMaxMessages?: number;
}

export interface CodewhaleNativeSessionCorrelationOptions {
  correlationHint: string;
  cwd: string;
  startedAtMs: number;
  finishedAtMs?: number;
  clockSkewMs?: number;
  homeDir?: string;
  codewhaleRoot?: string;
}

interface ManagedCrushHistoryProfile {
  id: string;
  dataDir: string;
}

interface SummaryCacheEntry {
  runtime: ExternalCliRuntime;
  mtimeMs: number;
  size: number;
  maxBytes: number;
  maxMessages: number;
  summary: ExternalCliSessionSummary;
}

const DEFAULT_SUMMARY_MAX_BYTES = 128 * 1024;
const DEFAULT_SUMMARY_MAX_MESSAGES = 512;
const DEFAULT_DETAIL_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_DETAIL_MAX_MESSAGES = 4_000;
const MAX_SUMMARY_CACHE_ENTRIES = 1_000;
const DEFAULT_CODEWHALE_CORRELATION_CLOCK_SKEW_MS = 5_000;
const CODEWHALE_LOG_FINGERPRINT_OFFSET_BASIS = 0xcbf2_9ce4_8422_2325n;
const CODEWHALE_LOG_FINGERPRINT_PRIME = 0x0000_0100_0000_01b3n;
const CODEWHALE_REDACTED_IDENTIFIER = /^<redacted:[0-9a-f]{16}>$/u;
const MANAGED_PROFILE_ID_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_MANAGED_PROFILES_PER_RUNTIME = 256;
const MAX_CRUSH_HISTORY_COMMAND_CONCURRENCY = 8;
const summaryCache = new Map<string, SummaryCacheEntry>();
const legacySessionCodecs = {
  claude: createLegacyExternalCliSessionCodec('claude'),
  codex: createLegacyExternalCliSessionCodec('codex'),
  pi: createLegacyExternalCliSessionCodec('pi'),
};

/** Matches CodeWhale's official redacted_identifier_for_log correlation value. */
export function codewhaleRedactedIdentifierForLog(identifier: string): string {
  if (!identifier) {
    return '<redacted:empty>';
  }

  const bytes = Buffer.from(identifier, 'utf8');
  let hash = CODEWHALE_LOG_FINGERPRINT_OFFSET_BASIS;
  for (const byte of bytes) {
    hash = BigInt.asUintN(
      64,
      (hash ^ BigInt(byte)) * CODEWHALE_LOG_FINGERPRINT_PRIME,
    );
  }
  hash = BigInt.asUintN(
    64,
    (hash ^ BigInt(bytes.length)) * CODEWHALE_LOG_FINGERPRINT_PRIME,
  );
  return `<redacted:${hash.toString(16).padStart(16, '0')}>`;
}

export async function resolveCodewhaleNativeSessionId(
  options: CodewhaleNativeSessionCorrelationOptions,
): Promise<string | undefined> {
  const finishedAtMs = options.finishedAtMs ?? Date.now();
  if (
    !CODEWHALE_REDACTED_IDENTIFIER.test(options.correlationHint)
    || !options.cwd.trim()
    || !Number.isFinite(options.startedAtMs)
    || !Number.isFinite(finishedAtMs)
    || finishedAtMs < options.startedAtMs
  ) {
    return undefined;
  }

  const clockSkewMs = normalizedNonNegativeInteger(
    options.clockSkewMs,
    DEFAULT_CODEWHALE_CORRELATION_CLOCK_SKEW_MS,
  );
  const earliestMtimeMs = options.startedAtMs - clockSkewMs;
  const latestMtimeMs = finishedAtMs + clockSkewMs;
  const nativeSessionIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const configuredRoot of await getConfiguredRoots(options)) {
    if (configuredRoot.runtime !== 'codewhale') {
      continue;
    }
    const root = await resolveDirectory(configuredRoot.root);
    if (!root) {
      continue;
    }
    for (const filePath of await collectCodewhaleSessionFiles(root)) {
      const candidate = await inspectSessionFile('codewhale', root, filePath);
      if (
        !candidate
        || seenPaths.has(candidate.path)
        || candidate.stats.mtimeMs < earliestMtimeMs
        || candidate.stats.mtimeMs > latestMtimeMs
      ) {
        continue;
      }
      seenPaths.add(candidate.path);
      const metadata = await readCodewhaleSessionMetadata(
        candidate.path,
        candidate.stats,
        DEFAULT_SUMMARY_MAX_BYTES,
      );
      if (!metadata) {
        continue;
      }
      const nativeSessionId = stringValue(metadata.id);
      const workspace = stringValue(metadata.workspace);
      if (
        nativeSessionId
        && workspace
        && sameResolvedPath(workspace, options.cwd)
        && codewhaleRedactedIdentifierForLog(nativeSessionId) === options.correlationHint
      ) {
        nativeSessionIds.add(nativeSessionId);
      }
    }
  }

  return nativeSessionIds.size === 1 ? nativeSessionIds.values().next().value : undefined;
}

export async function listExternalCliSessions(
  options: ExternalCliSessionOptions = {},
): Promise<ExternalCliSessionSummary[]> {
  const candidates: SessionFileCandidate[] = [];
  const seenPaths = new Set<string>();

  for (const configuredRoot of await getConfiguredRoots(options)) {
    if (options.runtimes?.length && !options.runtimes.includes(configuredRoot.runtime)) {
      continue;
    }
    const root = await resolveDirectory(configuredRoot.root);
    if (!root) {
      continue;
    }

    const sessionFiles = configuredRoot.runtime === 'codewhale'
      ? await collectCodewhaleSessionFiles(root)
      : configuredRoot.runtime === 'reasonix'
        ? await collectReasonixSessionFiles(root)
        : await collectJsonlFiles(root);
    for (const filePath of sessionFiles) {
      const candidate = await inspectSessionFile(configuredRoot.runtime, root, filePath);
      if (!candidate || seenPaths.has(candidate.path)) {
        continue;
      }
      seenPaths.add(candidate.path);
      candidates.push(candidate);
    }
  }

  const includeCrush = options.runtimes?.includes('crush') === true
    || (!options.runtimes?.length && Boolean(options.crushCwd));
  const managedCrushProfiles = includeCrush
    ? await managedCrushHistoryProfiles(options)
    : [];
  const crushHistorySources = includeCrush
    ? [
        toCrushHistoryOptions(options),
        ...managedCrushProfiles.map(profile => toCrushHistoryOptions(options, profile)),
      ]
    : [];
  const crushSummaries: ExternalCliSessionSummary[] = [];
  for (
    let sourceIndex = 0;
    sourceIndex < crushHistorySources.length;
    sourceIndex += MAX_CRUSH_HISTORY_COMMAND_CONCURRENCY
  ) {
    const summaryGroups = await Promise.all(
      crushHistorySources
        .slice(sourceIndex, sourceIndex + MAX_CRUSH_HISTORY_COMMAND_CONCURRENCY)
        .map(source => listCrushSessionHistory(source).catch(() => [])),
    );
    crushSummaries.push(...summaryGroups.flat());
  }
  const entries: Array<
    | { kind: 'file'; candidate: SessionFileCandidate; sortTime: number; path: string }
    | { kind: 'crush'; summary: ExternalCliSessionSummary; sortTime: number; path: string }
  > = [
    ...candidates.map(candidate => ({
      kind: 'file' as const,
      candidate,
      sortTime: candidate.stats.mtimeMs,
      path: candidate.path,
    })),
    ...crushSummaries.map(summary => ({
      kind: 'crush' as const,
      summary,
      sortTime: Date.parse(summary.updatedAt),
      path: summary.path,
    })),
  ];
  entries.sort((left, right) => {
    const timeDifference = right.sortTime - left.sortTime;
    return timeDifference || left.path.localeCompare(right.path);
  });

  const offset = normalizedNonNegativeInteger(options.offset, 0);
  const limit = options.limit == null
    ? entries.length
    : normalizedNonNegativeInteger(options.limit, entries.length);
  const selectedEntries = entries.slice(offset, offset + limit);
  const bounds: ParseBounds = {
    maxBytes: normalizedPositiveInteger(options.summaryMaxBytes, DEFAULT_SUMMARY_MAX_BYTES),
    maxMessages: normalizedPositiveInteger(
      options.summaryMaxMessages,
      DEFAULT_SUMMARY_MAX_MESSAGES,
    ),
  };
  const summaries: ExternalCliSessionSummary[] = [];

  for (const entry of selectedEntries) {
    if (entry.kind === 'crush') {
      summaries.push(entry.summary);
      continue;
    }
    const candidate = entry.candidate;
    // Reasonix summary fields can change in a metadata sidecar while the
    // checkpoint JSONL itself remains untouched.
    const cached = candidate.runtime === 'reasonix'
      ? undefined
      : getCachedSummary(candidate, bounds);
    if (cached) {
      summaries.push(cached);
      continue;
    }

    const session = await parseSessionFile(
      candidate.runtime,
      candidate.path,
      bounds,
      candidate.stats,
    );
    if (session) {
      if (candidate.runtime !== 'reasonix') {
        cacheSummary(candidate, bounds, session.summary);
      }
      summaries.push(session.summary);
    }
  }

  return summaries;
}

export async function readExternalCliSession(
  filePath: string,
  options: ExternalCliSessionOptions = {},
): Promise<ExternalCliSession | undefined> {
  if (isCrushSessionReference(filePath)) {
    if (options.runtimes?.length && !options.runtimes.includes('crush')) return undefined;
    const reference = parseCrushSessionReferenceDetails(filePath);
    if (!reference) return undefined;
    if (!reference.managedProfileId) {
      return readCrushSessionHistory(filePath, toCrushHistoryOptions(options));
    }
    const profile = (await managedCrushHistoryProfiles(options))
      .find(candidate => candidate.id === reference.managedProfileId);
    if (!profile) return undefined;
    return readCrushSessionHistory(filePath, toCrushHistoryOptions(options, profile));
  }
  const requestedPath = path.resolve(filePath);
  const canonicalPath = await resolveFile(requestedPath);
  if (!canonicalPath) {
    return undefined;
  }

  // Canonicalize roots before containment checks so Windows short/long path
  // forms of the same directory are not treated as distinct trees.
  const allowedRoots: RootSpec[] = [];
  for (const configuredRoot of await getConfiguredRoots(options)) {
    const canonicalRoot = await resolveDirectory(configuredRoot.root);
    if (canonicalRoot && isPathInside(canonicalRoot, canonicalPath)) {
      allowedRoots.push({ ...configuredRoot, root: canonicalRoot });
    }
  }

  if (allowedRoots.length === 0) {
    throw unsafeSessionPath(requestedPath);
  }

  const root = allowedRoots
    .filter(allowedRoot => isSessionFileForRuntime(allowedRoot, canonicalPath))
    .sort((left, right) => right.root.length - left.root.length)[0];
  if (!root) {
    return undefined;
  }
  return parseSessionFile(root.runtime, canonicalPath, {
    maxBytes: normalizedPositiveInteger(options.detailMaxBytes, DEFAULT_DETAIL_MAX_BYTES),
    maxMessages: normalizedPositiveInteger(options.detailMaxMessages, DEFAULT_DETAIL_MAX_MESSAGES),
  });
}

function toCrushHistoryOptions(
  options: ExternalCliSessionOptions,
  profile?: ManagedCrushHistoryProfile,
): CrushSessionHistoryOptions {
  return {
    executable: options.crushExecutable,
    cwd: options.crushCwd,
    env: profile
      ? { ...options.crushEnv, CRUSH_GLOBAL_DATA: profile.dataDir }
      : options.crushEnv,
    commandRunner: options.crushCommandRunner,
    maxOutputBytes: options.detailMaxBytes,
    maxMessages: options.detailMaxMessages,
    managedProfileId: profile?.id,
  };
}

async function getConfiguredRoots(options: ExternalCliSessionOptions): Promise<RootSpec[]> {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const explicitRootMode = Boolean(
    options.claudeRoot
    || options.codexRoot
    || options.piRoot
    || options.codewhaleRoot
    || options.reasonixRoot,
  );
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(homeDir, '.claude');
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(homeDir, '.codex');
  const piSessions = process.env.PI_CODING_AGENT_SESSION_DIR
    ? path.resolve(process.env.PI_CODING_AGENT_SESSION_DIR)
    : process.env.PI_CODING_AGENT_DIR
      ? path.join(path.resolve(process.env.PI_CODING_AGENT_DIR), 'sessions')
      : path.join(homeDir, '.pi', 'agent', 'sessions');
  const codewhaleRoots = options.codewhaleRoot
    ? [path.resolve(options.codewhaleRoot)]
    : process.env.CODEWHALE_HOME
      ? [path.join(path.resolve(process.env.CODEWHALE_HOME), 'sessions')]
      : [
          path.join(homeDir, '.codewhale', 'sessions'),
          path.join(homeDir, '.deepseek', 'sessions'),
        ];
  const reasonixRoots = options.reasonixRoot
    ? [path.resolve(options.reasonixRoot)]
    : resolveReasonixSessionRoots(
        homeDir,
        options.homeDir && !sameResolvedPath(homeDir, os.homedir())
          ? { ...process.env, APPDATA: undefined }
          : process.env,
      );
  const roots: RootSpec[] = [
    ...(!explicitRootMode || options.claudeRoot ? [{
      runtime: 'claude',
      root: path.resolve(options.claudeRoot ?? path.join(claudeConfigDir, 'projects')),
    } as const] : []),
    ...(!explicitRootMode || options.codexRoot ? [{
      runtime: 'codex',
      root: path.resolve(options.codexRoot ?? path.join(codexHome, 'sessions')),
    } as const] : []),
    ...(!explicitRootMode || options.piRoot ? [{
      runtime: 'pi',
      root: path.resolve(options.piRoot ?? piSessions),
    } as const] : []),
    ...(!explicitRootMode || options.codewhaleRoot ? codewhaleRoots.map(root => ({
      runtime: 'codewhale' as const,
      root,
    })) : []),
    ...(!explicitRootMode || options.reasonixRoot ? reasonixRoots.map(root => ({
      runtime: 'reasonix' as const,
      root,
    })) : []),
  ];
  if (!explicitRootMode) {
    roots.push(...await managedExternalCliProfileRoots(options));
  }
  const seen = new Set<string>();
  return roots.filter(item => {
    const normalized = path.resolve(item.root);
    const key = `${item.runtime}\0${path.sep === '\\' ? normalized.toLowerCase() : normalized}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function managedExternalCliProfileRoots(
  options: Pick<ExternalCliSessionOptions, 'hadamardHomeDir' | 'homeDir'>,
): Promise<RootSpec[]> {
  const profilesRoot = path.join(resolveManagedHadamardHome(options), 'external-cli-profiles');
  const roots: RootSpec[] = [];
  for (const runtime of ['pi', 'codewhale', 'reasonix'] as const) {
    const runtimeRoot = path.join(profilesRoot, runtime);
    let entries: Dirent[];
    try {
      entries = await readdir(runtimeRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries
      .filter(candidate =>
        candidate.isDirectory() && MANAGED_PROFILE_ID_PATTERN.test(candidate.name),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_MANAGED_PROFILES_PER_RUNTIME)) {
      roots.push({
        runtime,
        root: runtime === 'reasonix'
          ? path.join(runtimeRoot, entry.name, '.reasonix', 'sessions')
          : path.join(runtimeRoot, entry.name, 'sessions'),
      });
    }
  }
  return roots;
}

async function managedCrushHistoryProfiles(
  options: Pick<ExternalCliSessionOptions, 'hadamardHomeDir' | 'homeDir'>,
): Promise<ManagedCrushHistoryProfile[]> {
  const requestedRuntimeRoot = path.join(
    resolveManagedHadamardHome(options),
    'external-cli-profiles',
    'crush',
  );
  // resolveDirectory already rejects symlinks via lstat. Do not compare the
  // realpathed result against the lexical request path: on Windows, native
  // realpath expands 8.3 short names (RUNNER~1 → runneradmin) and that must
  // not look like a redirected/symlinked profile root.
  const runtimeRoot = await resolveDirectory(requestedRuntimeRoot);
  if (!runtimeRoot) return [];

  let entries: Dirent[];
  try {
    entries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const profiles: ManagedCrushHistoryProfile[] = [];
  for (const entry of entries
    .filter(candidate =>
      candidate.isDirectory() && MANAGED_PROFILE_ID_PATTERN.test(candidate.name),
    )
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (profiles.length >= MAX_MANAGED_PROFILES_PER_RUNTIME) break;
    const requestedProfileRoot = path.join(runtimeRoot, entry.name);
    const profileRoot = await resolveDirectory(requestedProfileRoot);
    if (!profileRoot) continue;

    const requestedDataDir = path.join(profileRoot, 'data');
    const dataDir = await resolveDirectory(requestedDataDir);
    if (!dataDir) continue;
    profiles.push({ id: entry.name, dataDir });
  }
  return profiles;
}

function resolveManagedHadamardHome(
  options: Pick<ExternalCliSessionOptions, 'hadamardHomeDir' | 'homeDir'>,
): string {
  return options.hadamardHomeDir?.trim()
    ? resolveHadamardHome(options.hadamardHomeDir, { inputKind: 'dataRoot' })
    : resolveHadamardHome(options.homeDir);
}

function unsafeSessionPath(filePath: string): HadamardSdkError {
  return new HadamardSdkError(
    `External CLI session path is outside the allowed roots: ${filePath}`,
    'EXTERNAL_CLI_SESSION_PATH_UNSAFE',
  );
}

async function parseSessionFile(
  runtime: ExternalCliRuntime,
  filePath: string,
  bounds: ParseBounds,
  knownFileInfo?: Stats,
): Promise<ExternalCliSession | undefined> {
  let fileInfo: Stats;
  try {
    fileInfo = knownFileInfo ?? await stat(filePath);
  } catch {
    return undefined;
  }

  if (runtime === 'codewhale') {
    return codewhaleExternalCliSessionCodec.parse(filePath, bounds, fileInfo);
  }
  if (runtime === 'reasonix') {
    return reasonixExternalCliSessionCodec.parse(filePath, bounds, fileInfo);
  }
  if (runtime === 'claude' || runtime === 'codex' || runtime === 'pi') {
    return legacySessionCodecs[runtime].parse(filePath, bounds, fileInfo);
  }
  return undefined;
}

function getCachedSummary(
  candidate: SessionFileCandidate,
  bounds: ParseBounds,
): ExternalCliSessionSummary | undefined {
  const cached = summaryCache.get(candidate.path);
  if (
    !cached ||
    cached.runtime !== candidate.runtime ||
    cached.mtimeMs !== candidate.stats.mtimeMs ||
    cached.size !== candidate.stats.size ||
    cached.maxBytes !== bounds.maxBytes ||
    cached.maxMessages !== bounds.maxMessages
  ) {
    return undefined;
  }
  summaryCache.delete(candidate.path);
  summaryCache.set(candidate.path, cached);
  return { ...cached.summary };
}

function cacheSummary(
  candidate: SessionFileCandidate,
  bounds: ParseBounds,
  summary: ExternalCliSessionSummary,
): void {
  summaryCache.delete(candidate.path);
  summaryCache.set(candidate.path, {
    runtime: candidate.runtime,
    mtimeMs: candidate.stats.mtimeMs,
    size: candidate.stats.size,
    maxBytes: bounds.maxBytes,
    maxMessages: bounds.maxMessages,
    summary: { ...summary },
  });
  while (summaryCache.size > MAX_SUMMARY_CACHE_ENTRIES) {
    const oldestKey = summaryCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    summaryCache.delete(oldestKey);
  }
}

function normalizedNonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function normalizedPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
