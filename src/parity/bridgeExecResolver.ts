/**
 * Executable resolution primitives shared by the bridge SDK and its provider
 * layer. Kept in a leaf module so `bridgeProviders.ts` can resolve a provider
 * binary on PATH without importing the full `hadamardBridgeSdk.ts` (which would
 * create a circular import).
 */

import { constants as fsConstants } from 'node:fs';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, IS_WINDOWS ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function splitPathEnv(pathValue: string | undefined): string[] {
  if (!pathValue) {
    return [];
  }
  return pathValue.split(path.delimiter).filter(Boolean);
}

export async function findExecutableOnPath(name: string): Promise<string | undefined> {
  const pathDirectories = splitPathEnv(process.env.PATH);
  const extensions = IS_WINDOWS
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter(Boolean)
    : [''];

  for (const directory of pathDirectories) {
    const directCandidate = path.join(directory, name);
    if (!IS_WINDOWS && (await isExecutable(directCandidate))) {
      return directCandidate;
    }

    for (const extension of extensions) {
      const candidate = directCandidate.endsWith(extension.toLowerCase())
        ? directCandidate
        : `${directCandidate}${extension.toLowerCase()}`;
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

export async function findFirstExistingPath(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export interface ResolvedExecutableInvocation {
  file: string;
  args: string[];
}

/**
 * Resolve an npm-generated Windows .cmd/.bat shim to its real executable.
 * User-controlled prompts must never be concatenated into a cmd.exe command
 * line: cmd expands `%VAR%` even inside quotes and its quote rules cannot make
 * arbitrary argv safe. Standard npm shims point at either a package .exe or a
 * JavaScript entry point; both can be launched directly with shell:false.
 */
export async function resolveExecutableInvocation(
  executable: string,
  args: string[],
): Promise<ResolvedExecutableInvocation> {
  if (!IS_WINDOWS || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { file: executable, args };
  }

  let source: string;
  try {
    source = await readFile(executable, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read Windows CLI shim: ${executable}`, { cause: error });
  }

  const candidates = [...source.matchAll(/%~?dp0%?[\\/]([^"\r\n]+?\.(?:exe|com|cjs|mjs|js))(?=["\s])/giu)];
  const match = candidates.at(-1);
  if (!match?.[1]) {
    // Not an npm-style shim. The Cursor CLI ships a PowerShell shim that
    // dispatches to versions/<version>/node.exe versions/<version>/index.js
    // next to the wrapper; resolve that bundle directly.
    const bundled = await resolveVersionedNodeBundle(path.dirname(executable), args);
    if (bundled) {
      return bundled;
    }
    throw new Error(
      `Unsupported Windows CLI wrapper: ${executable}. Configure the underlying .exe or JavaScript entry point instead.`,
    );
  }

  const target = path.resolve(
    path.dirname(executable),
    match[1].replace(/[\\/]+/gu, path.sep),
  );
  if (!(await pathExists(target))) {
    throw new Error(`Windows CLI shim target was not found: ${target}`);
  }
  if (/\.(?:cjs|mjs|js)$/i.test(target)) {
    // `process.execPath` is electron.exe inside the desktop app. Launching a
    // JavaScript npm shim with it would start another Electron application,
    // not the CLI runtime. An npm-installed CLI necessarily has a Node host
    // available on PATH, so resolve that host explicitly in Electron.
    const nodeExecutable = process.versions.electron
      ? await findExecutableOnPath('node')
      : process.execPath;
    if (!nodeExecutable) {
      throw new Error(
        `Node.js was not found on PATH for Windows CLI shim target: ${target}`,
      );
    }
    return { file: nodeExecutable, args: [target, ...args] };
  }
  return { file: target, args };
}

const VERSIONED_BUNDLE_DIR = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/iu;

/**
 * Resolve a Cursor-style versioned Node bundle next to a Windows shim:
 * versions/<YYYY.MM.DD[-HH-MM-SS]-commit>/node.exe plus index.js. Mirrors the
 * version selection of the vendor PowerShell shim (latest date wins).
 */
async function resolveVersionedNodeBundle(
  shimDir: string,
  args: string[],
): Promise<ResolvedExecutableInvocation | undefined> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(path.join(shimDir, 'versions'), { withFileTypes: true });
  } catch {
    return undefined;
  }

  const versions = entries
    .filter(entry => entry.isDirectory())
    .map(entry => ({ name: entry.name, match: VERSIONED_BUNDLE_DIR.exec(entry.name) }))
    .filter((candidate): candidate is { name: string; match: RegExpExecArray } => candidate.match !== null)
    .map(candidate => ({
      name: candidate.name,
      key: Number(candidate.match[1]) * 10000 + Number(candidate.match[2]) * 100 + Number(candidate.match[3]),
    }))
    .sort((a, b) => b.key - a.key || b.name.localeCompare(a.name));

  for (const version of versions) {
    const bundleDir = path.join(shimDir, 'versions', version.name);
    const nodeExecutable = path.join(bundleDir, 'node.exe');
    const entryPoint = path.join(bundleDir, 'index.js');
    if (await pathExists(nodeExecutable) && await pathExists(entryPoint)) {
      return { file: nodeExecutable, args: [entryPoint, ...args] };
    }
  }
  return undefined;
}

export { IS_WINDOWS };
