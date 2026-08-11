import { createHash } from 'node:crypto';

import { renderMarkdown } from '../ui/safeMarkdown.js';
import { parseDesignDocument, type DesignFrontmatter } from './designSchema.js';

export interface DesignRenderResult {
  html: string;
  bodyHtml: string;
  checksum: string;
  metadata: DesignFrontmatter;
}

const THEMES: Readonly<Record<string, string>> = {
  'clean-light': ':root{color-scheme:light;--page:#fff;--ink:#172033;--muted:#687386;--accent:#315efb}',
  'clean-dark': ':root{color-scheme:dark;--page:#111827;--ink:#f3f4f6;--muted:#9ca3af;--accent:#8ba5ff}',
};

function safeTheme(theme: string): string {
  return THEMES[theme] ?? THEMES['clean-light']!;
}

/** Strict renderer: Markdown is escaped by guiMarkdown and the shell has no scripts or remote resources. */
export class DesignRenderService {
  render(source: string): DesignRenderResult {
    const parsed = parseDesignDocument(source);
    const body = renderMarkdown(parsed.markdown);
    const checksum = createHash('sha256').update(source).digest('hex');
    const css = `${safeTheme(parsed.frontmatter.theme)}body{margin:0;background:var(--page);color:var(--ink);font:16px/1.65 system-ui,sans-serif}main{max-width:920px;margin:auto;padding:48px 32px}a{color:var(--accent)}pre{overflow:auto;padding:16px;background:color-mix(in srgb,var(--ink) 8%,var(--page));border-radius:8px}.design-meta{color:var(--muted);font-size:13px}`;
    return {
      checksum,
      bodyHtml: body,
      metadata: parsed.frontmatter,
      html: '<!doctype html><html><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + `<meta name="hadamard-design-checksum" content="${checksum}">`
        + `<style>${css}</style></head><body><main><div class="design-meta">`
        + `${parsed.frontmatter.template} · v${parsed.frontmatter.templateVersion}</div>${body}</main></body></html>`,
    };
  }
}
