import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface HcanvasSettings {
  dataRoot?: string;
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

/** Priority: explicit HCANVAS_HOME -> saved setting -> ~/.hcanvas. */
export function resolveDataRootSync(): string {
  if (process.env.HCANVAS_HOME) return path.resolve(process.env.HCANVAS_HOME);
  const configured = readHcanvasSettingsSync().dataRoot;
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured);
  return path.join(os.homedir(), '.hcanvas');
}

export async function writeDataRootSetting(dataRoot: string): Promise<string> {
  const next = path.resolve(dataRoot);
  await mkdir(hcanvasConfigDir(), { recursive: true });
  const current = await readHcanvasSettings();
  await writeFile(hcanvasSettingsPath(), JSON.stringify({ ...current, dataRoot: next }, null, 2), 'utf8');
  process.env.HCANVAS_HOME = next;
  return next;
}
