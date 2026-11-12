import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const FONT_FILES = [
  { family: 'Inter', file: 'Inter-Variable.woff2', weight: '100 900' },
  { family: 'Source Serif 4', file: 'SourceSerif4-Variable.woff2', weight: '100 900' },
  { family: 'JetBrains Mono', file: 'JetBrainsMono-Variable.woff2', weight: '100 800' },
];

function fontDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'dist', 'hcanvas', 'assets', 'fonts'),
    path.resolve(here, '..', '..', 'hcanvas', 'assets', 'fonts'),
    path.resolve(process.cwd(), 'src', 'hcanvas', 'client', 'fonts'),
  ];
  return candidates.find(candidate => existsSync(path.join(candidate, FONT_FILES[0]!.file))) || null;
}

let cachedCss: string | null = null;

/** @font-face rules with embedded WOFF2 data, for standalone HTML/PDF/PNG exports. */
export function bundledFontFaceCss(): string {
  if (cachedCss !== null) return cachedCss;
  const dir = fontDir();
  if (!dir) { cachedCss = ''; return cachedCss; }
  cachedCss = FONT_FILES.map(font => {
    const bytes = readFileSync(path.join(dir, font.file));
    return '@font-face{font-family:"' + font.family + '";font-style:normal;font-weight:' + font.weight + ';font-display:swap;src:url(data:font/woff2;base64,' + bytes.toString('base64') + ') format("woff2");}';
  }).join('\n');
  return cachedCss;
}

/** Map bundled families to a font PowerPoint can reasonably resolve on common desktops. */
export function pptxSafeFont(family: string | undefined): string {
  const first = String(family || '').split(',')[0]!.replace(/["']/g, '').trim();
  const map: Record<string, string> = {
    Inter: 'Arial',
    'Source Serif 4': 'Georgia',
    'JetBrains Mono': 'Consolas',
    'Cascadia Code': 'Consolas',
    'ui-sans-serif': 'Arial',
    'system-ui': 'Arial',
    'Microsoft YaHei': 'Microsoft YaHei',
    'PingFang SC': 'PingFang SC',
    'Songti SC': 'SimSun',
    SimSun: 'SimSun',
    Georgia: 'Georgia',
    Arial: 'Arial',
  };
  return map[first] || first || 'Arial';
}
