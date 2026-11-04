import { marked } from 'marked';
import katex from 'katex';

function renderLatexHtml(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: false, output: 'mathml', strict: 'ignore' });
  } catch {
    return '<code class="hc-math-error">' + String(tex).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code>';
  }
}

export function renderMathHtml(tex: string, displayMode = false): string {
  return renderLatexHtml(tex, displayMode);
}

function mathTokens(source: string): { source: string; tokens: Array<{ marker: string; html: string; display: boolean }> } {
  const tokens: Array<{ marker: string; html: string; display: boolean }> = [];
  const pattern = /\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;
  const escaped = source.replace(pattern, (_match: string, bracket?: string, dollar?: string, paren?: string, inline?: string) => {
    const tex = bracket ?? dollar ?? paren ?? inline ?? '';
    const display = bracket !== undefined || dollar !== undefined;
    const marker = '\uE000HCMATH' + tokens.length + '\uE001';
    tokens.push({ marker, html: display ? '<div class="hc-math hc-math-block">' + renderLatexHtml(tex, true) + '</div>' : '<span class="hc-math hc-math-inline">' + renderLatexHtml(tex, false) + '</span>', display });
    return marker;
  });
  return { source: escaped, tokens };
}

export function renderMarkdownHtml(source: string): string {
  const { source: escaped, tokens } = mathTokens(source || '');
  let html = marked.parse(escaped, { async: false }) as string;
  for (const token of tokens) {
    if (token.display) html = html.replace('<p>' + token.marker + '</p>', token.html);
  }
  for (const token of tokens) html = html.split(token.marker).join(token.html);
  return html;
}