/**
 * Serves the locally built Excalidraw client bundle and its font assets from
 * dist/gui-canvas. No CDN or network access is required at runtime.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GuiHttpRouter } from './guiHttpRouter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, { body: Buffer; type: string; mtimeMs: number }>();

function candidateDirs(): string[] {
  const configured = process.env.HADAMARD_GUI_CANVAS_DIR;
  return [
    ...(configured ? [configured] : []),
    path.resolve(process.cwd(), 'dist', 'gui-canvas'),
    path.resolve(here, '..', '..', 'dist', 'gui-canvas'),
    path.resolve(here, '..', '..', '..', 'dist', 'gui-canvas'),
  ];
}

async function resolveAssetDir(): Promise<string | undefined> {
  for (const candidate of candidateDirs()) {
    try {
      await stat(path.join(candidate, 'excalidraw.js'));
      return candidate;
    } catch { /* try next */ }
  }
  return undefined;
}

function contentType(file: string): string {
  const extension = file.split('.').pop()?.toLowerCase();
  if (extension === 'js') return 'text/javascript; charset=utf-8';
  if (extension === 'css') return 'text/css; charset=utf-8';
  if (extension === 'woff2') return 'font/woff2';
  if (extension === 'woff') return 'font/woff';
  if (extension === 'ttf') return 'font/ttf';
  if (extension === 'json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

export function registerGuiCanvasAssetsHttpController(router: GuiHttpRouter): void {
  const assetPath = (pathname: string): string | undefined => {
    if (pathname === '/gui-canvas/excalidraw.js') return 'excalidraw.js';
    for (const prefix of ['/gui-canvas/fonts/', '/gui-canvas/locales/', '/gui-canvas/data/']) {
      if (pathname.startsWith(prefix)) return pathname.slice('/gui-canvas/'.length);
    }
    for (const prefix of ['/fonts/', '/locales/', '/data/']) {
      if (pathname.startsWith(prefix)) return pathname.slice(1);
    }
    return undefined;
  };
  router.route('GET', url => Boolean(assetPath(url.pathname)), async (req, res, url) => {
    const directory = await resolveAssetDir();
    if (!directory) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('Canvas editor assets are not built yet. Run: node scripts/build-gui-canvas.mjs');
      return;
    }
    const relative = decodeURIComponent(assetPath(url.pathname) || '');
    if (!relative || relative.includes('..') || relative.includes('\\') || relative.startsWith('/')) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Invalid asset path');
      return;
    }
    const filePath = path.resolve(directory, relative);
    if (!filePath.startsWith(directory + path.sep)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Invalid asset path');
      return;
    }
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('not a file');
      const cached = cache.get(filePath);
      let body: Buffer;
      if (cached && cached.mtimeMs === info.mtimeMs) body = cached.body;
      else {
        body = await readFile(filePath);
        cache.set(filePath, { body, type: contentType(filePath), mtimeMs: info.mtimeMs });
      }
      res.writeHead(200, {
        'content-type': contentType(filePath),
        'content-length': body.length,
        'cache-control': 'public, max-age=3600',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Asset not found');
    }
  });
}
