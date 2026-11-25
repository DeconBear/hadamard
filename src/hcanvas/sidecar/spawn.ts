// Spawn-safety helpers shared by the sidecar broker and the PTY manager:
// argv-only spawning, cwd whitelisting, a minimal environment allowlist and
// whole-process-tree termination (SPEC-7.6, SPEC-9.1, SPEC-13 8/11/13).
import { spawn, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { HcRuntimeError } from './protocol.js';

/** Environment variables inherited by a sidecar/PTY child (name match is case-insensitive). */
export const SPAWN_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES', 'ALLUSERSPROFILE',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS',
  'USERNAME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
  'CXX', 'OCTAVE_BIN',
  'TERM', 'COLORTERM', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
]);

/** Values matching these names are never inherited, even if allowlisted. */
export const SPAWN_ENV_DENY_PATTERNS: readonly RegExp[] = [
  /^HADAMARD_/iu,
  /^HCANVAS_/iu,
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|SESSION[_-]?KEY|API[_-]?KEY|AUTH)/iu,
];

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export interface SandboxEnvOptions {
  /** Base environment; defaults to process.env (injectable for tests). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Manifest literal env block. */
  literals?: Record<string, string>;
}

/**
 * Build the child environment: a minimal platform allowlist from the parent
 * process plus manifest literals, with secrets and HADAMARD_/HCANVAS_ variables
 * stripped from both sources. Never injects credentials.
 */
export function buildSandboxEnv(options: SandboxEnvOptions = {}): Record<string, string> {
  const baseEnv = options.baseEnv ?? process.env;
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (typeof value !== 'string') continue;
    const upper = name.toUpperCase();
    if (!SPAWN_ENV_ALLOWLIST.has(upper)) continue;
    if (SPAWN_ENV_DENY_PATTERNS.some(pattern => pattern.test(name))) continue;
    if (!ENV_NAME_PATTERN.test(name)) continue;
    result[name] = value.replace(/\u0000/gu, '');
  }
  for (const [name, value] of Object.entries(options.literals ?? {})) {
    if (typeof value !== 'string' || !ENV_NAME_PATTERN.test(name)) continue;
    if (SPAWN_ENV_DENY_PATTERNS.some(pattern => pattern.test(name))) continue;
    result[name] = value.replace(/\u0000/gu, '');
  }
  return result;
}

/** True when `candidate` is `root` or lives under it (case-insensitive on Windows). */
export function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const normalize = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
  const normalizedRoot = normalize(resolvedRoot);
  const normalizedCandidate = normalize(resolvedCandidate);
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep);
}

export interface SandboxCwdOptions {
  extensionDir: string;
  workspaceDir: string;
  /** Manifest `cwd`: 'extension' (default), 'workspace', or a relative subdirectory. */
  requested?: string;
}

/**
 * Resolve a manifest cwd against the extension/workspace roots and verify the
 * real path stays inside one of them (symlink escapes are rejected).
 */
export async function resolveSandboxCwd(options: SandboxCwdOptions): Promise<string> {
  const requested = options.requested?.trim();
  const extensionDir = path.resolve(options.extensionDir);
  const workspaceDir = path.resolve(options.workspaceDir);
  let candidate: string;
  if (!requested || requested === 'extension' || requested === '.') {
    candidate = extensionDir;
  } else if (requested === 'workspace') {
    candidate = workspaceDir;
  } else if (path.isAbsolute(requested)) {
    candidate = path.resolve(requested);
  } else {
    candidate = path.resolve(extensionDir, requested);
  }
  const realCandidate = await realpath(candidate).catch(() => candidate);
  const realExtension = await realpath(extensionDir).catch(() => extensionDir);
  const realWorkspace = await realpath(workspaceDir).catch(() => workspaceDir);
  if (isPathInside(realExtension, realCandidate) || isPathInside(realWorkspace, realCandidate)) return realCandidate;
  throw new HcRuntimeError(
    'path_forbidden',
    'Working directory ' + JSON.stringify(requested ?? candidate) + ' is outside the extension directory and workspace root',
  );
}

/** Short stable hash used for instance keys and session ids. */
export function sha256Short(value: string, length = 16): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, length);
}

/** SPEC-7.4 instance key: extensionId + sidecarId + argvHash + cwd. */
export function sidecarInstanceKey(extensionId: string, sidecarId: string, command: readonly string[], cwd: string): string {
  const argvHash = sha256Short(JSON.stringify(command), 16);
  const cwdHash = sha256Short(path.resolve(cwd), 12);
  return extensionId + ':' + sidecarId + ':' + argvHash + ':' + cwdHash;
}

export function isProcessAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type SidecarSpawnImpl = (file: string, args: string[], options: SpawnOptions) => ReturnType<typeof spawn>;

export interface KillProcessTreeOptions {
  platform?: NodeJS.Platform;
  /** Upper bound for waiting on taskkill; never throws. */
  timeoutMs?: number;
  spawnImpl?: SidecarSpawnImpl;
  /** When the child was spawned `detached` on POSIX a process group exists. */
  detached?: boolean;
}

function runTaskkill(pid: number, force: boolean, options: KillProcessTreeOptions): Promise<boolean> {
  const args = ['/pid', String(pid), '/T'];
  if (force) args.push('/F');
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const child = spawnImpl('taskkill', args, { shell: false, windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        finish(false);
      }, Math.max(500, options.timeoutMs ?? 5_000));
      child.once('error', () => { clearTimeout(timer); finish(false); });
      child.once('exit', () => { clearTimeout(timer); finish(true); });
    } catch {
      finish(false);
    }
  });
}

/**
 * Kill a child process and all of its descendants. Windows uses
 * `taskkill /T /F`; POSIX signals the detached process group (falling back to
 * the pid). Never throws: exit/pid races are reported through the boolean.
 */
export async function killProcessTree(
  pid: number | null | undefined,
  signal: NodeJS.Signals = 'SIGTERM',
  options: KillProcessTreeOptions = {},
): Promise<boolean> {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    // SIGINT/SIGTERM are emulated on Windows; force-kill the whole tree.
    return runTaskkill(pid, true, options);
  }
  const detached = options.detached !== false;
  try {
    if (detached) {
      try {
        process.kill(-pid, signal);
        return true;
      } catch { /* no process group; fall through to pid kill */ }
    }
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/** Promise that resolves after `ms`; used for graceful shutdown windows. */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    if (!Number.isFinite(ms) || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
