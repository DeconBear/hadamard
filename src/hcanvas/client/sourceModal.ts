import { basicSetup, EditorView } from 'codemirror';
import { html as htmlLang } from '@codemirror/lang-html';
import { oneDark } from '@codemirror/theme-one-dark';
import { renderMarkdownHtml, renderMathHtml } from '../markdown.js';
import { createAutoSave } from './autoSave.js';
import { esc } from './utils.js';

export interface SourceModalOptions {
  title: string;
  kind: string;
  value: string;
  language: string;
  save(next: string): Promise<boolean>;
}

export interface SourceModalHost {
  open(html: string): void;
  close(): void;
  toast(message: string, kind?: 'success' | 'error' | 'info'): void;
  onOpenChange(open: boolean): void;
}

/** Full-screen source editor with live preview, autosave and a close-flush guarantee. */
export function openSourceModal(options: SourceModalOptions, host: SourceModalHost): void {
  const modalClass = 'modal split' + (options.kind === 'markdown' ? ' markdown-workspace' : '');
  const modalHtml = '<div class="' + modalClass + '"><div class="modal-head"><div><strong>' + esc(options.title) + '</strong><small>' + esc(options.kind.toUpperCase()) + ' · source and live preview</small></div><div class="source-editor-actions"><span id="sourceSaveStatus" class="source-save-status" data-state="saved">Auto-save on</span><button class="icon-btn" data-close title="Close editor" aria-label="Close editor">×</button></div></div><div class="modal-body"><div class="editor-pane"><span>Source</span><div id="codeEditorHost" class="editor-host"></div></div><div class="editor-pane"><span>Preview</span><div class="preview-host"><iframe id="codePreview" sandbox="allow-scripts"></iframe></div></div></div><div class="modal-foot"><span class="source-autosave-note">Changes save automatically · Ctrl/Cmd+S to save now</span><button class="btn" data-close>Done</button></div></div>';
  host.open(modalHtml);
  host.onOpenChange(true);
  const hostElement = document.getElementById('codeEditorHost');
  const preview = document.getElementById('codePreview') as HTMLIFrameElement | null;
  const setPreview = (kind: string, value: string): void => {
    if (!preview) return;
    try { preview.srcdoc = previewHtmlFor(kind, value); }
    catch (error) { preview.srcdoc = '<!doctype html><html><body style="margin:0;padding:16px;color:#b42318;font:12px Inter,sans-serif">Preview unavailable: ' + esc(error instanceof Error ? error.message : String(error)) + '</body></html>'; }
  };
  const updatePreview = debounce(() => { setPreview(options.kind, view.state.doc.toString()); }, 280);
  const autoSave = createAutoSave({
    save: options.save,
    onStatus: status => {
      const node = document.getElementById('sourceSaveStatus');
      if (!node) return;
      node.dataset.state = status;
      node.textContent = status === 'pending' ? 'Editing…' : status === 'saving' ? 'Saving…' : status === 'error' ? 'Not saved · edit or retry' : 'Auto-save on';
    },
  });
  const extensions = [basicSetup, EditorView.lineWrapping, oneDark, EditorView.updateListener.of(update => {
    if (!update.docChanged) return;
    updatePreview();
    autoSave.change(update.state.doc.toString());
  })];
  if (options.language === 'html') extensions.push(htmlLang());
  const view = new EditorView({ doc: options.value, extensions, parent: hostElement! });
  setPreview(options.kind, options.value);
  view.dom.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    void autoSave.flush();
  });
  let closing = false;
  const realClose = (): void => {
    if (closing || !document.getElementById('codeEditorHost')) return;
    closing = true;
    void autoSave.close().then(saved => {
      closing = false;
      if (!saved) {
        if (document.getElementById('codeEditorHost')) host.toast('Changes could not be saved. The editor stays open; fix the problem and try again.', 'error');
        return;
      }
      host.onOpenChange(false);
      view.destroy();
      host.close();
    }, () => {
      closing = false;
      host.toast('Changes could not be saved. The editor stays open; fix the problem and try again.', 'error');
    });
  };
  (window as unknown as { __hcCloseModal?: () => void }).__hcCloseModal = realClose;
  document.querySelectorAll<HTMLElement>('[data-close]').forEach(button => button.addEventListener('click', () => realClose()));
}

function previewHtmlFor(kind: string, value: string): string {
  if (kind === 'html') return '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}</style></head><body>' + value + '</body></html>';
  if (kind === 'markdown') return '<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px/1.6 Inter,sans-serif;padding:24px;color:#334155}h1,h2,h3{font-family:Georgia,serif}code{background:#f1f5f9;padding:1px 4px;border-radius:4px}blockquote{margin:12px 0;padding:10px 14px;border-left:3px solid #a855f7;background:#faf7ff;color:#4b4058}blockquote p{margin:0}.hc-math-block{margin:14px 0;overflow-x:auto}.hc-math-inline{display:inline-block;vertical-align:middle}</style></head><body>' + renderMarkdownHtml(value) + '</body></html>';
  if (kind === 'math') return '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:24px;color:#1f2430;font-family:Inter,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;box-sizing:border-box}.katex-display{margin:0;font-size:1.35em}</style></head><body>' + renderMathHtml(value, true) + '</body></html>';
  return '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#171923;color:#e2e8f0;font:12px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap}</style></head><body>' + esc(value) + '</body></html>';
}

function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; fn(...args); }, wait);
  };
}
