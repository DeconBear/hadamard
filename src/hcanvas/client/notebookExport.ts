import { renderStoredOutputsHtml } from '../execOutputs.js';
import { renderMarkdownHtml } from '../markdown.js';
import { serializeIpynb } from '../notebook/ipynb.js';
import type { NotebookEditorData } from '../notebook/types.js';
import type { KernelDescriptor } from './kernelManager.js';
import { sanitizeMarkdownHtml } from './markdownSanitize.js';
import { esc } from './utils.js';

function download(url: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function filename(title: string, extension: string): string {
  return title.replace(/\.(?:hnb\.md|ipynb)$/iu, '').replace(/[\\/:*?"<>|]+/g, '-') + extension;
}

function kernelFor(data: NotebookEditorData, kernels: KernelDescriptor[], cell: NotebookEditorData['cells'][number]): KernelDescriptor | undefined {
  return kernels.find(kernel => kernel.id === cell.kernelId)
    || kernels.find(kernel => kernel.language === cell.language || kernel.id === cell.language || (kernel.defaultFor || []).includes(cell.language || ''))
    || kernels.find(kernel => kernel.id === data.defaultKernelId)
    || kernels[0];
}

export function exportNotebookHtml(title: string, data: NotebookEditorData, kernels: KernelDescriptor[]): void {
  const body = data.cells.map(cell => {
    if (cell.kind === 'markdown') return '<section class="md">' + sanitizeMarkdownHtml(renderMarkdownHtml(cell.source)) + '</section>';
    const kernel = kernelFor(data, kernels, cell);
    return '<section class="code"><div class="cell-kernel">' + esc(kernel?.label || cell.language || 'code') + '</div><pre>' + esc(cell.source) + '</pre><div class="out">' + (cell.outputs?.length ? renderStoredOutputsHtml(cell.outputs) : '') + '</div></section>';
  }).join('\n');
  const initial = Object.keys(data.initialVariables || {}).length ? '<details><summary>Initial variables</summary><pre>' + esc(JSON.stringify(data.initialVariables, null, 2)) + '</pre></details>' : '';
  const current = Object.keys(data.variables || {}).length ? '<details><summary>Current variables</summary><pre>' + esc(JSON.stringify(data.variables, null, 2)) + '</pre></details>' : '';
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title><style>' +
    'body{font:15px/1.65 Inter,system-ui,sans-serif;color:#252b36;max-width:900px;margin:40px auto;padding:0 24px;background:#faf8f3}.md h1,.md h2{font-family:Georgia,serif}.code{margin:20px 0}.cell-kernel{font:10px Inter,sans-serif;color:#8a8276;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}.code>pre{background:#181b23;color:#e6e9f0;padding:16px;border-radius:12px;overflow:auto;font:12.5px/1.6 ui-monospace,Consolas,monospace}.out img,section img{max-width:100%;height:auto}.out pre{white-space:pre-wrap;background:#fff;border:1px solid #e3ded3;border-radius:8px;padding:10px}.out iframe{width:100%;min-height:180px;border:1px solid #e3ded3;border-radius:8px}.exec-out-error{color:#b42318}details{margin:28px 0}details pre{white-space:pre-wrap}.export-document .hc-data-table-actions button{display:none}</style></head><body class="export-document">' + body + initial + current + '</body></html>';
  download(URL.createObjectURL(new Blob([html], { type: 'text/html' })), filename(title, '.html'));
}

export function exportNotebookIpynb(title: string, data: NotebookEditorData): void {
  download(URL.createObjectURL(new Blob([serializeIpynb(data)], { type: 'application/x-ipynb+json' })), filename(title, '.ipynb'));
}
