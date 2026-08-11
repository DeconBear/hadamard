import { createHash } from 'node:crypto';

import { escapeHtml, renderMarkdown } from '../ui/safeMarkdown.js';
import { parseDesignDocument, type DesignFrontmatter } from './designSchema.js';
import { resolveDesignTheme, validateDesignThemeTokens, type DesignThemeTokens } from './designTheme.js';

export interface DesignRenderResult {
  html: string;
  bodyHtml: string;
  checksum: string;
  metadata: DesignFrontmatter;
  theme: DesignThemeTokens;
}

export interface DesignRenderSections {
  order: readonly string[];
  hidden: readonly string[];
}

function sectionId(title: string): string {
  return title.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
}

function arrangeSections(markdown: string, options?: DesignRenderSections): string {
  const withoutMarkers = (value: string): string =>
    value.replace(/^<!--\s*hadamard-section:[A-Za-z0-9._-]+\s*-->\r?\n/gmu, '');
  if (!options || (options.order.length === 0 && options.hidden.length === 0)) return withoutMarkers(markdown);
  const matches = [...markdown.matchAll(/^(?:<!--\s*hadamard-section:([A-Za-z0-9._-]+)\s*-->\r?\n)?##\s+(.+)$/gmu)];
  if (matches.length === 0) return markdown;
  const introduction = markdown.slice(0, matches[0]!.index);
  const blocks = matches.map((match, index) => ({
    id: match[1] ?? sectionId(match[2]!),
    source: markdown.slice(match.index!, matches[index + 1]?.index ?? markdown.length).trimEnd(),
    sourceIndex: index,
  }));
  const hidden = new Set(options.hidden);
  const rank = new Map(options.order.map((id, index) => [id, index]));
  return `${introduction.trimEnd()}\n\n${blocks
    .filter(block => !hidden.has(block.id))
    .sort((left, right) => (rank.get(left.id) ?? options.order.length + left.sourceIndex)
      - (rank.get(right.id) ?? options.order.length + right.sourceIndex))
    .map(block => withoutMarkers(block.source))
    .join('\n\n')}\n`;
}

/** Strict renderer: Markdown is escaped by guiMarkdown and the shell has no scripts or remote resources. */
export class DesignRenderService {
  render(
    source: string,
    overrides: Partial<DesignThemeTokens> = {},
    sections?: DesignRenderSections,
  ): DesignRenderResult {
    const parsed = parseDesignDocument(source);
    const body = renderMarkdown(arrangeSections(parsed.markdown, sections));
    const checksum = createHash('sha256').update(source).digest('hex');
    const selected = resolveDesignTheme(parsed.frontmatter.theme);
    const theme = validateDesignThemeTokens(overrides, selected.tokens);
    const colorScheme = theme.codeTheme === 'dark' ? 'dark' : 'light';
    const css = `:root{color-scheme:${colorScheme};--page:${theme.backgroundColor};--ink:${theme.textColor};--muted:${theme.mutedColor};--accent:${theme.accentColor}}`
      + `body{margin:0;background:var(--page);color:var(--ink);font:16px/1.65 ${theme.fontFamily}}`
      + `main{max-width:${theme.pageWidth}px;margin:auto;padding:48px 32px}`
      + `code,pre{font-family:${theme.codeFontFamily}}a{color:var(--accent)}`
      + 'pre{overflow:auto;padding:16px;background:color-mix(in srgb,var(--ink) 8%,var(--page));border-radius:8px}'
      + '.design-meta,.design-footer{color:var(--muted);font-size:13px}.design-header{margin-bottom:24px}'
      + '@media print{body{background:#fff;color:#111}main{max-width:none;padding:18mm}.design-footer{position:fixed;bottom:8mm}}';
    const logo = theme.logoDataUrl
      ? `<img alt="Project logo" src="${escapeHtml(theme.logoDataUrl)}" style="max-height:64px;max-width:220px">`
      : '';
    const header = theme.header ? `<header class="design-header">${escapeHtml(theme.header)}</header>` : '';
    const footer = theme.footer ? `<footer class="design-footer">${escapeHtml(theme.footer)}</footer>` : '';
    const contentHtml = `${logo}${header}<div class="design-meta">${escapeHtml(parsed.frontmatter.template)}`
      + ` · v${parsed.frontmatter.templateVersion}</div>${body}${footer}`;
    return {
      checksum,
      bodyHtml: contentHtml,
      metadata: parsed.frontmatter,
      theme,
      html: '<!doctype html><html><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + `<meta name="hadamard-design-checksum" content="${checksum}">`
        + `<style>${css}</style></head><body><main>${contentHtml}</main></body></html>`,
    };
  }
}
