import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type HcanvasLanguage = 'en' | 'zh';
export type HcanvasRuntimeKind = 'python' | 'octave' | 'cpp';
export type HcanvasUpdateChannel = 'stable' | 'preview';

export interface HcanvasRuntimeSettings {
  /** Absolute path or executable name; empty means auto-detect from PATH. */
  python?: string;
  octave?: string;
  cpp?: string;
}

export interface HcanvasNotebookSettings {
  defaultKernel?: string;
  outputCacheBytes?: number;
}

export interface HcanvasUpdateSettings {
  autoCheck?: boolean;
  autoDownload?: boolean;
  channel?: HcanvasUpdateChannel;
}

export interface HcanvasSettings {
  dataRoot?: string;
  language?: HcanvasLanguage;
  runtimes?: HcanvasRuntimeSettings;
  notebook?: HcanvasNotebookSettings;
  updates?: HcanvasUpdateSettings;
}

/** Stable per-user config location; deliberately outside the install directory. */
export function hcanvasConfigDir(): string {
  if (process.env.HCANVAS_CONFIG_HOME) return path.resolve(process.env.HCANVAS_CONFIG_HOME);
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Hadamard Canvas');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Hadamard Canvas');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'hcanvas');
}

export function hcanvasSettingsPath(): string {
  return path.join(hcanvasConfigDir(), 'hcanvas-settings.json');
}

export function readHcanvasSettingsSync(): HcanvasSettings {
  try {
    const parsed = JSON.parse(readFileSync(hcanvasSettingsPath(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as HcanvasSettings : {};
  } catch {
    return {};
  }
}

export async function readHcanvasSettings(): Promise<HcanvasSettings> {
  try {
    const parsed = JSON.parse(await readFile(hcanvasSettingsPath(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as HcanvasSettings : {};
  } catch {
    return {};
  }
}

function normalizeSettingsString(value: unknown, max = 4096): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : '';
}

function normalizeRuntimeSettings(input: unknown, current: HcanvasRuntimeSettings | undefined): HcanvasRuntimeSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return current ?? {};
  const box = input as Record<string, unknown>;
  const next: HcanvasRuntimeSettings = { ...(current ?? {}) };
  for (const kind of ['python', 'octave', 'cpp'] as const) {
    if (!(kind in box)) continue;
    const value = normalizeSettingsString(box[kind]);
    if (value === undefined) continue;
    if (value) next[kind] = value; else delete next[kind];
  }
  return next;
}

function normalizeNotebookSettings(input: unknown, current: HcanvasNotebookSettings | undefined): HcanvasNotebookSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return current ?? {};
  const box = input as Record<string, unknown>;
  const next: HcanvasNotebookSettings = { ...(current ?? {}) };
  if ('defaultKernel' in box) {
    const value = normalizeSettingsString(box.defaultKernel, 200);
    if (value) next.defaultKernel = value; else delete next.defaultKernel;
  }
  if ('outputCacheBytes' in box) {
    const value = box.outputCacheBytes;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) next.outputCacheBytes = Math.floor(value);
    else if (value === null) delete next.outputCacheBytes;
  }
  return next;
}

function normalizeUpdateSettings(input: unknown, current: HcanvasUpdateSettings | undefined): HcanvasUpdateSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return current ?? {};
  const box = input as Record<string, unknown>;
  const next: HcanvasUpdateSettings = { ...(current ?? {}) };
  if (typeof box.autoCheck === 'boolean') next.autoCheck = box.autoCheck;
  if (typeof box.autoDownload === 'boolean') next.autoDownload = box.autoDownload;
  if (box.channel === 'stable' || box.channel === 'preview') next.channel = box.channel;
  return next;
}
/** Priority: explicit HCANVAS_HOME -> saved setting -> ~/.hcanvas. */
export function resolveDataRootSync(): string {
  if (process.env.HCANVAS_HOME) return path.resolve(process.env.HCANVAS_HOME);
  const configured = readHcanvasSettingsSync().dataRoot;
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured);
  return path.join(os.homedir(), '.hcanvas');
}

/** Merge a partial settings patch and persist atomically. */
export async function updateHcanvasSettings(patch: Partial<HcanvasSettings>): Promise<HcanvasSettings> {
  const current = await readHcanvasSettings();
  const next: HcanvasSettings = { ...current };
  if ('dataRoot' in patch) {
    const value = normalizeSettingsString(patch.dataRoot);
    if (value) next.dataRoot = path.resolve(value); else delete next.dataRoot;
  }
  if (patch.language === 'zh' || patch.language === 'en') next.language = patch.language;
  if ('runtimes' in patch) next.runtimes = normalizeRuntimeSettings(patch.runtimes, current.runtimes);
  if ('notebook' in patch) next.notebook = normalizeNotebookSettings(patch.notebook, current.notebook);
  if ('updates' in patch) next.updates = normalizeUpdateSettings(patch.updates, current.updates);
  await mkdir(hcanvasConfigDir(), { recursive: true });
  const target = hcanvasSettingsPath();
  const temporary = target + '.' + process.pid + '.' + Date.now() + '.tmp';
  await writeFile(temporary, JSON.stringify(next, null, 2) + String.fromCharCode(10), 'utf8');
  try { await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
  if (next.dataRoot) process.env.HCANVAS_HOME = next.dataRoot;
  return next;
}

export async function writeDataRootSetting(dataRoot: string): Promise<string> {
  const next = path.resolve(dataRoot);
  await updateHcanvasSettings({ dataRoot: next });
  return next;
}


export function readHcanvasLanguageSync(): HcanvasLanguage {
  return readHcanvasSettingsSync().language === 'zh' ? 'zh' : 'en';
}

export async function writeHcanvasLanguage(language: HcanvasLanguage): Promise<HcanvasLanguage> {
  const next: HcanvasLanguage = language === 'zh' ? 'zh' : 'en';
  await updateHcanvasSettings({ language: next });
  return next;
}
