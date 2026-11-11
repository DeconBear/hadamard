import { renderMarkdownHtml } from './markdown.js';
import type { HcPage } from './types.js';

const MARKDOWN_PAGE_CSS = [
  'html,body{margin:0;padding:0;background:#ffffff;color:#20242b;}',
  'body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif;}',
  '.hc-markdown-page{box-sizing:border-box;max-width:780px;margin:0 auto;padding:72px 64px 88px;font:15px/1.75 Georgia,"Songti SC",serif;color:#20242b;}',
  '.hc-markdown-page h1,.hc-markdown-page h2,.hc-markdown-page h3,.hc-markdown-page h4{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Inter,sans-serif;line-height:1.22;color:#151922;margin:1.4em 0 .5em;}',
  '.hc-markdown-page h1{font-size:2.35em;letter-spacing:-.03em;}.hc-markdown-page h2{font-size:1.55em;}.hc-markdown-page h3{font-size:1.2em;}',
  '.hc-markdown-page p{margin:.8em 0;}.hc-markdown-page ul,.hc-markdown-page ol{padding-left:1.4em;}.hc-markdown-page li{margin:.25em 0;}',
  '.hc-markdown-page blockquote{margin:1.2em 0;padding:.4em 0 .4em 1em;border-left:3px solid #6d5bd0;color:#555c66;}',
  '.hc-markdown-page code{font:0.88em/1.5 ui-monospace,Consolas,monospace;background:#f2ede4;padding:.12em .35em;border-radius:4px;}',
  '.hc-markdown-page pre{background:#1c2028;color:#f7f0e6;padding:18px 20px;border-radius:8px;overflow:auto;}.hc-markdown-page pre code{background:transparent;padding:0;color:inherit;}',
  '.hc-markdown-page table{border-collapse:collapse;width:100%;margin:1.2em 0;font-family:Inter,sans-serif;font-size:.9em;}.hc-markdown-page th,.hc-markdown-page td{border:1px solid #ded8cc;padding:8px 10px;text-align:left;}.hc-markdown-page th{background:#f8f4ed;}',
  '.hc-markdown-page img{max-width:100%;height:auto;}.hc-markdown-page hr{border:0;border-top:1px solid #ded8cc;margin:2em 0;}',
  '.hc-markdown-page a{color:#5b4ac0;text-decoration:none;border-bottom:1px solid rgba(91,74,192,.3);}',
  '.hc-markdown-page .markdown-empty{color:#8a8173;font-style:italic;}',
].join('\n');

/** Convert a Markdown document page into a standalone HTML page. */
export function markdownPageHtml(markdown: string, page?: Pick<HcPage, 'background'>): string {
  const background = page?.background || '#ffffff';
  const body = markdown.trim() ? renderMarkdownHtml(markdown) : '<p class="markdown-empty">Start writing this Markdown document…</p>';
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + MARKDOWN_PAGE_CSS.replace(/background:#ffffff;/g, 'background:' + background + ';') + '</style></head><body style="background:' + background + '"><article class="hc-markdown-page">' + body + '</article></body></html>';
}
