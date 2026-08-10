import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveGuiAssetsDir } from './guiAssets.js';
import {
  createHadamardGuiClientScript,
  createHadamardGuiHtml,
  createHadamardGuiStyles,
} from './hadamardGuiAssets.js';
import { bytes, text, type GuiHttpRouter } from './guiHttpRouter.js';

const xtermAssetsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'assets',
  'xterm',
);
const XTERM_TYPES = new Map<string, string>([
  ['xterm.js', 'text/javascript'],
  ['xterm.css', 'text/css'],
  ['addon-fit.js', 'text/javascript'],
]);

export function registerGuiShellHttpController(router: GuiHttpRouter, authToken: string): void {
  router.route('GET', '/', (_req, res) => {
    const nonce = randomBytes(16).toString('base64');
    const html = createHadamardGuiHtml().replace(
      '<script src="/app.js" type="module"></script>',
      `<script nonce="${nonce}">window.__HADAMARD_TOKEN__=${JSON.stringify(authToken)};</script>\n  <script nonce="${nonce}" src="/app.js" type="module"></script>`,
    );
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': [
        "default-src 'none'",
        `script-src 'self' 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "font-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join('; '),
    });
    res.end(html);
  });
  router.route('GET', '/app.css', (_req, res) => {
    text(res, 200, createHadamardGuiStyles(), 'text/css');
  });
  router.route('GET', '/app.js', (_req, res) => {
    text(res, 200, createHadamardGuiClientScript(), 'text/javascript');
  });
  router.route('GET', /^\/(?:favicon\.ico|app-icon\.png)$/u, (_req, res, url) => {
    const assetsDir = resolveGuiAssetsDir();
    if (!assetsDir) return text(res, 404, 'Not found');
    const file = url.pathname === '/favicon.ico' ? 'hadamard-icon.ico' : 'hadamard-icon.png';
    const type = url.pathname === '/favicon.ico' ? 'image/x-icon' : 'image/png';
    try {
      bytes(res, 200, readFileSync(path.join(assetsDir, file)), type);
    } catch {
      text(res, 404, 'Not found');
    }
  });
  router.route('GET', url => url.pathname.startsWith('/assets/xterm/'), (_req, res, url) => {
    const name = path.basename(url.pathname);
    const type = XTERM_TYPES.get(name);
    if (!type) return text(res, 404, 'Not found');
    try {
      text(res, 200, readFileSync(path.join(xtermAssetsDir, name), 'utf8'), type);
    } catch {
      text(res, 404, 'Not found');
    }
  });
}
