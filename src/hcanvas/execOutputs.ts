import { renderMathHtml } from './markdown.js';
import { renderNotebookTableHtml } from './notebook/table.js';

export type HcStoredOutput =
  | { id: string; kind: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'markdown'; text: string }
  | { id: string; kind: 'math'; tex: string; display?: boolean }
  | { id: string; kind: 'image'; mime: 'image/png' | 'image/jpeg' | 'image/svg+xml'; url: string; assetId?: string; size?: number; alt?: string; width?: number; height?: number }
  | { id: string; kind: 'html'; html: string }
  | { id: string; kind: 'json'; value: unknown }
  | { id: string; kind: 'error'; ename: string; evalue: string; traceback: string[] }
  | { id: string; kind: 'notice'; text: string };

export interface HcExecStoredData {
  execution?: { kernelId?: string; scope?: { kind: string; key: string } };
  outputs?: HcStoredOutput[];
  lastRun?: { status: string; startedAt: string; durationMs?: number };
}

export const EXEC_OUTPUT_LIMITS = {
  text: 64 * 1024,
  html: 256 * 1024,
  total: 1024 * 1024,
  image: 2 * 1024 * 1024,
  images: 10,
} as const;

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

export function storedOutputs(blockData: unknown): HcStoredOutput[] {
  if (!blockData || typeof blockData !== 'object') return [];
  const outputs = (blockData as { outputs?: unknown }).outputs;
  return Array.isArray(outputs) ? outputs as HcStoredOutput[] : [];
}

/** Render stored outputs as static HTML (Present/export/thumbnails and canvas fallback). */
export function renderStoredOutputsHtml(outputs: HcStoredOutput[] | undefined): string {
  if (!outputs || !outputs.length) return '<div class="exec-out-empty">No output yet.</div>';
  return outputs.map(output => {
    if (output.kind === 'stream') return '<pre class="exec-out-stream' + (output.name === 'stderr' ? ' stderr' : '') + '">' + escapeHtml(output.text) + '</pre>';
    if (output.kind === 'text') return '<pre class="exec-out-text">' + escapeHtml(output.text) + '</pre>';
    if (output.kind === 'markdown') return '<pre class="exec-out-text">' + escapeHtml(output.text) + '</pre>';
    if (output.kind === 'math') return '<div class="exec-out-math">' + renderMathHtml(output.tex, output.display === true) + '</div>';
    if (output.kind === 'image') {
      return '<img class="exec-out-image" src="' + escapeAttr(output.url) + '" alt="' + escapeAttr(output.alt || 'output') + '" loading="lazy" decoding="async" tabindex="0" title="Click to preview"' +
        (output.width ? ' width="' + Number(output.width) + '"' : '') + (output.height ? ' height="' + Number(output.height) + '"' : '') + '>';
    }
    if (output.kind === 'html') {
      const resize = '<script>(()=>{const post=()=>parent.postMessage({hcOutputResize:1,height:Math.ceil(document.documentElement.scrollHeight)},\'*\');if(window.ResizeObserver)new ResizeObserver(post).observe(document.body);addEventListener(\'load\',post);post()})()</script>';
      const doc = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:;"></head><body style="margin:0;font:13px/1.5 Inter,sans-serif;color:#1f2430">' + output.html + resize + '</body></html>';
      return '<iframe class="exec-out-html" sandbox="allow-scripts" loading="lazy" title="HTML output" srcdoc="' + escapeAttr(doc) + '"></iframe>';
    }
    if (output.kind === 'json') {
      const table = renderNotebookTableHtml(output.value);
      return table || '<pre class="exec-out-text exec-out-json">' + escapeHtml(JSON.stringify(output.value, null, 2)) + '</pre>';
    }
    if (output.kind === 'error') return '<div class="exec-out-error"><strong>' + escapeHtml(output.ename + ': ' + output.evalue) + '</strong><pre>' + escapeHtml(output.traceback.join('\n')) + '</pre></div>';
    return '<div class="exec-out-notice">' + escapeHtml(output.text) + '</div>';
  }).join('');
}

export function execData(blockData: unknown): HcExecStoredData {
  if (!blockData || typeof blockData !== 'object') return {};
  return blockData as HcExecStoredData;
}

/** Keep newest cache entries within a byte budget (approximate JSON size). */
export function selectOutputCacheEntries<T>(entries: Array<[string, T]>, budgetBytes: number): Array<[string, T]> {
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) return [];
  const kept: Array<[string, T]> = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const size = JSON.stringify({ [entry[0]]: entry[1] }).length;
    if (used + size > budgetBytes) continue;
    kept.unshift(entry);
    used += size;
  }
  return kept;
}
export function truncateText(text: string, limit = EXEC_OUTPUT_LIMITS.text): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n… output truncated (' + text.length + ' chars)';
}
