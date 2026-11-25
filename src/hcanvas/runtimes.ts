import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  readHcanvasSettings,
  type HcanvasRuntimeKind,
  type HcanvasSettings,
} from './dataRoot.js';

export interface HcRuntimeProbe {
  kind: HcanvasRuntimeKind;
  ok: boolean;
  command: string;
  path?: string;
  version?: string;
  source: 'configured' | 'auto' | 'missing';
  error?: string;
}

const CANDIDATES: Record<HcanvasRuntimeKind, string[]> = {
  python: ['python', 'python3'],
  octave: ['octave'],
  cpp: ['g++', 'clang++'],
};

const VERSION_ARGS: Record<HcanvasRuntimeKind, string[]> = {
  python: ['--version'],
  octave: ['--version'],
  cpp: ['--version'],
};

function configuredPath(settings: HcanvasSettings | undefined, kind: HcanvasRuntimeKind): string | undefined {
  const value = settings?.runtimes?.[kind];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function pathExtensions(platform = process.platform, env = process.env): string[] {
  if (platform !== 'win32') return [''];
  const raw = env.PATHEXT || '.EXE;.CMD;.BAT;.COM';
  return ['', ...raw.split(';').map(item => item.trim().toLowerCase()).filter(Boolean)];
}

/** Resolve an executable name against PATH without invoking a shell. */
export function findRuntimeExecutable(name: string, platform = process.platform, env = process.env): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const hasSeparator = trimmed.includes('/') || trimmed.includes('\\');
  if (path.isAbsolute(trimmed) || hasSeparator) {
    const candidate = path.resolve(trimmed);
    return existsSync(candidate) && statSync(candidate).isFile() ? candidate : undefined;
  }
  const extensions = pathExtensions(platform, env);
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    const base = dir.trim().replace(/^"|"$/g, '');
    if (!base) continue;
    for (const extension of extensions) {
      const candidate = path.join(base, trimmed + extension);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return undefined;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? '';
}

/** Probe one runtime command and report its version. */
export function probeRuntime(kind: HcanvasRuntimeKind, command: string, source: 'configured' | 'auto' = 'configured'): HcRuntimeProbe {
  const executable = findRuntimeExecutable(command) || (path.isAbsolute(command) && existsSync(command) ? command : undefined);
  if (!executable) {
    return { kind, ok: false, command, source: source === 'auto' ? 'missing' : 'configured', error: 'Executable not found: ' + command };
  }
  try {
    const result = spawnSync(executable, VERSION_ARGS[kind], { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false });
    const output = firstLine(String(result.stdout || result.stderr || ''));
    if (result.error || (result.status !== 0 && !output)) {
      return { kind, ok: false, command, path: executable, source, error: result.error?.message || 'Exit code ' + result.status };
    }
    return { kind, ok: true, command, path: executable, ...(output ? { version: output } : {}), source };
  } catch (error) {
    return { kind, ok: false, command, path: executable, source, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Detect a runtime using settings first, then the platform PATH. */
function windowsOctaveCandidates(): string[] {
  if (process.platform !== 'win32') return [];
  const candidates: string[] = [];
  for (const hive of ['HKLM', 'HKCU']) {
    const probe = spawnSync('reg.exe', ['query', hive + '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'Octave', '/d'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    for (const line of String(probe.stdout || '').split(/\r?\n/u)) {
      const match = /InstallLocation\s+REG_\w+\s+(.+)$/iu.exec(line);
      if (!match) continue;
      const location = match[1]!.trim().replace(/\\+$/u, '');
      if (!location) continue;
      candidates.push(path.join(location, 'mingw64', 'bin', 'octave.exe'), path.join(location, 'bin', 'octave.exe'), path.join(location, 'octave.exe'));
    }
  }
  return candidates;
}
export function detectRuntime(kind: HcanvasRuntimeKind, settings?: HcanvasSettings): HcRuntimeProbe {
  const configured = configuredPath(settings, kind);
  if (configured) return probeRuntime(kind, configured, 'configured');
  const candidates = kind === 'octave' ? [...CANDIDATES[kind], ...windowsOctaveCandidates()] : CANDIDATES[kind];
  for (const candidate of candidates) {
    const probe = probeRuntime(kind, candidate, 'auto');
    if (probe.ok) return probe;
  }
  return { kind, ok: false, command: CANDIDATES[kind][0] || kind, source: 'missing', error: 'No ' + kind + ' runtime found on PATH' };
}

export function detectAllRuntimes(settings: HcanvasSettings): HcRuntimeProbe[] {
  return (['python', 'octave', 'cpp'] as const).map(kind => detectRuntime(kind, settings));
}

/** Command/executable the sidecar should use (configured value or auto candidate). */
export function runtimeCommand(kind: HcanvasRuntimeKind, settings?: HcanvasSettings): string {
  return configuredPath(settings, kind) || CANDIDATES[kind][0]!;
}

/** Environment overrides consumed by the C++ and Octave sidecars. */
export function runtimeEnvironment(settings?: HcanvasSettings): Record<string, string> {
  const env: Record<string, string> = {};
  const cpp = configuredPath(settings, 'cpp');
  const octave = configuredPath(settings, 'octave');
  if (cpp) env.CXX = cpp;
  if (octave) env.OCTAVE_BIN = octave;
  return env;
}

/** Apply configured interpreter/compiler settings to a sidecar declaration. */
export function applyRuntimeOverrides(command: readonly string[], env: Record<string, string> | undefined, settings: HcanvasSettings): { command: string[]; env?: Record<string, string> } {
  const nextCommand = [...command];
  if (nextCommand.length && /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(path.basename(nextCommand[0]!))) nextCommand[0] = runtimeCommand('python', settings);
  const nextEnv = { ...(env ?? {}), ...runtimeEnvironment(settings) };
  return Object.keys(nextEnv).length ? { command: nextCommand, env: nextEnv } : { command: nextCommand };
}
export async function readRuntimeProbeSettings(): Promise<{ settings: HcanvasSettings; probes: HcRuntimeProbe[] }> {
  const settings = await readHcanvasSettings();
  return { settings, probes: detectAllRuntimes(settings) };
}
