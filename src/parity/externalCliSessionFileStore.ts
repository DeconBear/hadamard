import type { Dirent, Stats } from 'node:fs';
import { realpath as realpathCallback } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ExternalCliRuntime } from './externalCliSessionTypes.js';

const realpathNative = promisify(realpathCallback.native);

export interface ExternalCliSessionRoot {
  runtime: ExternalCliRuntime;
  root: string;
}

export interface ExternalCliSessionFileCandidate {
  runtime: ExternalCliRuntime;
  path: string;
  stats: Stats;
}

export interface ExternalCliSessionFileStore {
  resolveDirectory(directory: string): Promise<string | undefined>;
  resolveFile(filePath: string): Promise<string | undefined>;
  inspectSessionFile(
    runtime: ExternalCliRuntime,
    root: string,
    filePath: string,
  ): Promise<ExternalCliSessionFileCandidate | undefined>;
  collectJsonlFiles(directory: string): Promise<string[]>;
  collectCodewhaleSessionFiles(directory: string): Promise<string[]>;
  collectReasonixSessionFiles(directory: string): Promise<string[]>;
  isSessionFileForRuntime(root: ExternalCliSessionRoot, filePath: string): boolean;
  sameResolvedPath(left: string, right: string): boolean;
  isPathInside(root: string, candidate: string): boolean;
}

export const nodeExternalCliSessionFileStore: ExternalCliSessionFileStore = {
  resolveDirectory,
  resolveFile,
  inspectSessionFile,
  collectJsonlFiles,
  collectCodewhaleSessionFiles,
  collectReasonixSessionFiles,
  isSessionFileForRuntime,
  sameResolvedPath,
  isPathInside,
};

async function resolveDirectory(directory: string): Promise<string | undefined> {
  try {
    const requestedInfo = await lstat(directory);
    if (requestedInfo.isSymbolicLink() || !requestedInfo.isDirectory()) return undefined;
    const canonicalPath = await realpathNative(directory);
    return (await stat(canonicalPath)).isDirectory() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

async function resolveFile(filePath: string): Promise<string | undefined> {
  try {
    const requestedInfo = await lstat(filePath);
    if (requestedInfo.isSymbolicLink() || !requestedInfo.isFile()) return undefined;
    const canonicalPath = await realpathNative(filePath);
    const canonicalInfo = await lstat(canonicalPath);
    return !canonicalInfo.isSymbolicLink() && canonicalInfo.isFile() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

async function inspectSessionFile(
  runtime: ExternalCliRuntime,
  root: string,
  filePath: string,
): Promise<ExternalCliSessionFileCandidate | undefined> {
  try {
    const resolvedPath = path.resolve(filePath);
    if (!isPathInside(root, resolvedPath)) return undefined;
    const fileInfo = await lstat(resolvedPath);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) return undefined;
    return { runtime, path: resolvedPath, stats: fileInfo };
  } catch {
    return undefined;
  }
}

async function collectJsonlFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJsonlFiles(entryPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }
  return files;
}

async function collectCodewhaleSessionFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => !entry.isSymbolicLink() && entry.isFile() && isCodewhaleSessionFileName(entry.name))
    .map(entry => path.join(directory, entry.name));
}

async function collectReasonixSessionFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => !entry.isSymbolicLink() && entry.isFile() && isReasonixSessionFileName(entry.name))
    .map(entry => path.join(directory, entry.name));
}

function isSessionFileForRuntime(root: ExternalCliSessionRoot, filePath: string): boolean {
  const fileName = path.basename(filePath);
  if (root.runtime === 'codewhale') {
    return isCodewhaleSessionFileName(fileName) && path.dirname(filePath) === root.root;
  }
  if (root.runtime === 'reasonix') {
    return isReasonixSessionFileName(fileName) && path.dirname(filePath) === root.root;
  }
  return path.extname(filePath).toLowerCase() === '.jsonl';
}

function isCodewhaleSessionFileName(fileName: string): boolean {
  return /^[A-Za-z0-9_-]+\.json$/u.test(fileName);
}

function isReasonixSessionFileName(fileName: string): boolean {
  return /^[^\\/\u0000-\u001f\u007f]+\.jsonl$/iu.test(fileName)
    && !/(?:^|\.)(?:events|guardian)\.jsonl$/iu.test(fileName);
}

function sameResolvedPath(left: string, right: string): boolean {
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  return process.platform === 'win32'
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}
