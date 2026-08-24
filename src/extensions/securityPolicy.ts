/**
 * Security Guard built-in extension (Hadamard-owned, pi-agent style): an
 * opt-in PRE tool-policy listener that hard-denies catastrophic shell
 * commands and writes to protected paths before the permission stage. Because
 * the pipeline pre-stage is monotonic, this listener can only tighten, never
 * widen, existing behavior.
 *
 * @module src/extensions/securityPolicy
 */
import path from 'node:path';

import type { ContributionApplyContext, HadamardRuntimeContribution } from '../contrib/contributionHost.js';
import { isRecord } from '../runtime/helpers.js';
import {
  toolPolicyListenerRegistryKey,
  type ToolPolicyCall,
  type ToolPrePolicyListener,
  type ToolPrePolicyState,
} from '../runtime/toolPolicyPipeline.js';
import type { BuiltInExtensionToggles } from './builtInExtensions.js';

/** Default protected paths; extend via settings `extensions.security.protectedPaths`. */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = ['.env', '.env.*', '.git/', 'node_modules/'];

/** Input fields carrying a file path on mutating tools (Write/Edit/NotebookEdit/MultiEdit). */
const FILE_PATH_FIELDS = ['file_path', 'filePath', 'notebook_path', 'path'] as const;

interface DangerousPattern {
  pattern: RegExp;
  label: string;
}

/**
 * Catastrophic-command patterns. `git clean -fdx` / `git reset --hard` are
 * deliberately NOT here: they are common recovery operations owned by the
 * permission-rule machinery, not by this hard-deny list.
 */
const DANGEROUS_COMMAND_PATTERNS: readonly DangerousPattern[] = [
  // mkfs.* formats a filesystem.
  { pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/i, label: 'filesystem format (mkfs)' },
  // dd writing to a block device.
  { pattern: /\bdd\b[^;&|]*\bof=\/dev\//i, label: 'dd writing to a device' },
  // Classic fork bomb: :(){ :|:& };:
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, label: 'fork bomb' },
  // OS shutdown/reboot (not followed by a script-ish suffix like shutdown.sh).
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b(?![\w.-])/i, label: 'system power command' },
  // Windows system-drive destruction.
  { pattern: /\bformat\s+(?:\/[a-z]+\s+)*[a-z]:/i, label: 'drive format' },
  { pattern: /\bdiskpart\b/i, label: 'disk partitioning (diskpart)' },
  { pattern: /\bbcdedit\b/i, label: 'boot configuration edit (bcdedit)' },
  { pattern: /\b(?:del|erase|rd|rmdir)\s+(?:\/[a-z]+\s+)*[a-z]:\\(?:\s|$)/i, label: 'system-drive recursive delete' },
  // Shell redirection overwriting a block device.
  { pattern: />{1,2}\s*\/dev\/(?:sd[a-z]|hd[a-z]|nvme\d+n\d+|xvd[a-z])\b/, label: 'write to block device' },
];

/** `rm` targets that are unambiguously catastrophic when combined with -rf. */
function isCatastrophicRmTarget(target: string): boolean {
  const stripped = target.replace(/["']/g, '');
  if (stripped === '*' || stripped === '/*') return true;
  const normalized = stripped.replace(/[/\\]+$/, '') || '/';
  return (
    normalized === '/' ||
    normalized === '~' ||
    normalized.startsWith('~/') ||
    normalized === '$HOME' ||
    normalized === '${HOME}' ||
    normalized.startsWith('$HOME/') ||
    normalized.startsWith('${HOME}/')
  );
}

/** Tokenize each `rm ...` segment; deny only recursive+force against root/home/wildcard targets. */
function findRmRfViolation(command: string): string | null {
  const segments = command.match(/\brm\b[^;&|()]*/g) ?? [];
  for (const segment of segments) {
    const tokens = segment.split(/\s+/).filter(Boolean).slice(1);
    let recursive = false;
    let force = false;
    const targets: string[] = [];
    for (const token of tokens) {
      if (token === '--') continue;
      if (token.startsWith('-')) {
        if (token === '--recursive') recursive = true;
        else if (token === '--force') force = true;
        else if (/^-[a-zA-Z]+$/.test(token)) {
          if (/r/i.test(token)) recursive = true;
          if (/f/i.test(token)) force = true;
        }
        continue;
      }
      targets.push(token);
    }
    if (!recursive || !force) continue;
    for (const target of targets) {
      if (isCatastrophicRmTarget(target)) {
        return `recursive forced delete of '${target}'`;
      }
    }
  }
  return null;
}

/**
 * Return a human-readable violation when the command matches the hard-deny
 * list, else null. `extraPatterns` are user regex strings (compiled
 * case-insensitive; invalid ones are skipped).
 */
export function findDangerousCommandViolation(command: string, extraPatterns?: readonly string[]): string | null {
  const rmViolation = findRmRfViolation(command);
  if (rmViolation) return rmViolation;
  for (const { pattern, label } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) return label;
  }
  for (const source of extraPatterns ?? []) {
    if (typeof source !== 'string' || !source) continue;
    let pattern: RegExp;
    try {
      pattern = new RegExp(source, 'i');
    } catch {
      continue;
    }
    if (pattern.test(command)) return `custom dangerous pattern /${source}/i`;
  }
  return null;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesProtectedEntry(candidateAbs: string, workDir: string, entry: string): boolean {
  const isDirectory = entry.endsWith('/');
  const cleanEntry = isDirectory ? entry.slice(0, -1) : entry;
  if (!cleanEntry) return false;
  const candidatePosix = toPosix(path.resolve(candidateAbs));
  if (path.isAbsolute(cleanEntry) || /^[a-z]:/i.test(cleanEntry)) {
    const entryAbs = toPosix(path.resolve(cleanEntry));
    return isDirectory
      ? candidatePosix === entryAbs || candidatePosix.startsWith(`${entryAbs}/`)
      : candidatePosix === entryAbs;
  }
  const relative = toPosix(path.relative(workDir, candidateAbs));
  if (/[*?]/.test(cleanEntry)) {
    const pattern = globToRegExp(cleanEntry);
    return pattern.test(relative) || pattern.test(path.basename(candidateAbs));
  }
  if (isDirectory) {
    // Directory prefix: any matching path segment (covers nested .git/, node_modules/).
    if (relative === cleanEntry || relative.startsWith(`${cleanEntry}/`)) return true;
    return relative.split('/').includes(cleanEntry);
  }
  return relative === cleanEntry || path.basename(candidateAbs) === cleanEntry;
}

/**
 * Return a human-readable violation when `candidatePath` (relative or
 * absolute, resolved against `workDir`) hits one of `protectedPaths`, else
 * null. Entries ending in `/` are directory prefixes; `*`/`?` act as globs
 * matched against the relative path and the basename.
 */
export function findProtectedPathViolation(
  candidatePath: string,
  workDir: string,
  protectedPaths: readonly string[],
): string | null {
  const trimmed = candidatePath.trim().replace(/["']+$/, '').replace(/^["']+/, '');
  if (!trimmed) return null;
  const resolved = path.isAbsolute(trimmed) || /^[a-z]:/i.test(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(workDir, trimmed);
  for (const entry of protectedPaths) {
    if (typeof entry === 'string' && entry.trim() && matchesProtectedEntry(resolved, path.resolve(workDir), entry.trim())) {
      return `protected path '${entry.trim()}'`;
    }
  }
  return null;
}

/** Best-effort scan for `>`/`>>` redirections into protected paths. */
function findProtectedRedirectionViolation(
  command: string,
  workDir: string,
  protectedPaths: readonly string[],
): string | null {
  const matches = command.match(/>{1,2}\s*[^\s;&|]+/g) ?? [];
  for (const match of matches) {
    const target = match.replace(/>{1,2}\s*/, '');
    const violation = findProtectedPathViolation(target, workDir, protectedPaths);
    if (violation) return `shell redirection into ${violation}`;
  }
  return null;
}

export interface SecurityExtensionConfig {
  protectedPaths?: string[];
  extraDangerousPatterns?: string[];
}

function deny(state: ToolPrePolicyState, detail: string): void {
  state.behavior = 'deny';
  state.reason =
    `[security extension] Blocked ${detail}. ` +
    'Disable via /extensions security off or settings extensions.security.enabled=false.';
}

/** Pre-listener: dangerous shell commands and protected-path writes. No-op when disabled. */
export function createSecurityPreListener(toggles: BuiltInExtensionToggles): ToolPrePolicyListener {
  return async (call: ToolPolicyCall, state: ToolPrePolicyState) => {
    if (state.behavior === 'deny') return;
    if (!toggles.isEnabled('security')) return;
    const config = toggles.getConfig<SecurityExtensionConfig>('security');
    const protectedPaths = [...DEFAULT_PROTECTED_PATHS, ...(config.protectedPaths ?? [])];
    const input = isRecord(call.input) ? call.input : {};
    // Any tool whose input carries a shell command string (Bash, PowerShell, ...).
    if (typeof input.command === 'string') {
      const commandViolation = findDangerousCommandViolation(input.command, config.extraDangerousPatterns);
      if (commandViolation) {
        deny(state, `dangerous shell command: ${commandViolation}`);
        return;
      }
      const redirectionViolation = findProtectedRedirectionViolation(input.command, call.workDir, protectedPaths);
      if (redirectionViolation) {
        deny(state, redirectionViolation);
        return;
      }
    }
    // File-path inputs on mutating tools; read-only tools (Read, Grep) pass.
    if (call.adapter.isReadOnly?.(call.input) === true) return;
    for (const field of FILE_PATH_FIELDS) {
      const value = input[field];
      if (typeof value !== 'string' || !value.trim()) continue;
      const pathViolation = findProtectedPathViolation(value, call.workDir, protectedPaths);
      if (pathViolation) {
        deny(state, `write to ${pathViolation}`);
        return;
      }
    }
  };
}

/** Contribution: attaches the security pre-listener to the tool-policy listener registry. */
export function createSecurityPolicyContribution(toggles: BuiltInExtensionToggles): HadamardRuntimeContribution {
  return {
    id: 'hadamard.ext.security',
    apply(ctx: ContributionApplyContext) {
      const registry = ctx.services.get(toolPolicyListenerRegistryKey);
      if (!registry) return;
      const listener = createSecurityPreListener(toggles);
      registry.addPre(listener);
      return () => { registry.removePre(listener); };
    },
  };
}
