import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The shipped Hcanvas release version.
 *
 * hcanvas.version.json is the single source of truth for the app version. The
 * file is kept beside the compiled server in the npm package and in the desktop
 * bundle; the source checkout uses the same file. Do not hardcode a second
 * version number for health, extension-host compatibility, or client info.
 */
function readHcanvasVersion(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // src/hcanvas/version.ts (tsx): two levels below the repository root.
    path.resolve(moduleDir, '..', '..', 'hcanvas.version.json'),
    // dist/src/hcanvas/version.js (tsc/esbuild): three levels below the package root.
    path.resolve(moduleDir, '..', '..', '..', 'hcanvas.version.json'),
    path.resolve(process.cwd(), 'hcanvas.version.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && /^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(parsed.version)) return parsed.version;
    } catch {
      // Try the next known location; the final error below is actionable.
    }
  }
  throw new Error('Cannot resolve the Hcanvas version: hcanvas.version.json is missing or invalid. Expected it beside the package root or the current working directory.');
}

export const HCANVAS_VERSION = readHcanvasVersion();
