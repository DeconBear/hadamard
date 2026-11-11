import { basicSetup, EditorView } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { completeFromList } from '@codemirror/autocomplete';
import { undo, redo } from '@codemirror/commands';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { r } from '@codemirror/legacy-modes/mode/r';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { sql } from '@codemirror/lang-sql';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { xml } from '@codemirror/lang-xml';
import { php } from '@codemirror/lang-php';
import { yaml } from '@codemirror/lang-yaml';
import { renderMarkdownHtml } from '../markdown.js';

interface FileRoot { id: string; name: string; path: string; }
interface FileEntry { name: string; path: string; type: 'file' | 'directory'; ext?: string; size?: number; }
type FilePreview = 'text' | 'image' | 'pdf' | 'office' | 'binary';
interface FileContent { path: string; name: string; ext: string; size: number; binary: boolean; content: string; language: string; preview: FilePreview; }
interface CanvasTab { id: string; docId: string; pageId: string; label: string; }
interface FileTab {
  id: string;
  rootId: string;
  path: string;
  name: string;
  language: string;
  content: string;
  binary: boolean;
  ext: string;
  preview: FilePreview;
  mode: 'view' | 'edit';
  dirty: boolean;
  fontSize: number;
  editor?: EditorView;
}

export interface FileBrowserOptions {
  mount: HTMLElement;
  tabs: HTMLElement;
  viewport: HTMLElement;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
  chooseDirectory?(): Promise<string | null> | null;
  serveUrl(rootId: string, path: string): string;
  canvasLabel(): string;
  openCanvas(docId: string, pageId: string): void;
  onShowCanvas(): void;
}

export interface FileBrowserController {
  syncCanvasTab(docId: string, pageId: string, label: string): void;
}

const KEYWORDS: Record<string, string[]> = {
  javascript: ['const', 'let', 'function', 'return', 'import', 'export', 'class', 'async', 'await', 'interface', 'type', 'if', 'else', 'for', 'while', 'try', 'catch', 'throw'],
  typescript: ['interface', 'type', 'enum', 'implements', 'extends', 'readonly', 'public', 'private', 'protected', 'as', 'satisfies', 'keyof', 'unknown', 'never'],
  python: ['def', 'class', 'return', 'import', 'from', 'as', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'lambda', 'yield', 'async', 'await', 'True', 'False', 'None'],
  rust: ['fn', 'let', 'mut', 'pub', 'struct', 'enum', 'impl', 'trait', 'match', 'if', 'else', 'loop', 'while', 'for', 'return', 'use', 'mod', 'async', 'await', 'Result', 'Option'],
  go: ['func', 'package', 'import', 'type', 'struct', 'interface', 'var', 'const', 'if', 'else', 'for', 'range', 'return', 'go', 'defer', 'select', 'switch', 'case'],
  java: ['class', 'interface', 'public', 'private', 'protected', 'static', 'final', 'void', 'new', 'return', 'if', 'else', 'for', 'while', 'try', 'catch', 'throws', 'extends', 'implements'],
  cpp: ['int', 'float', 'double', 'char', 'void', 'const', 'auto', 'class', 'struct', 'namespace', 'template', 'return', 'if', 'else', 'for', 'while', 'public', 'private', 'std'],
  sql: ['SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'GROUP BY', 'ORDER BY', 'INSERT INTO', 'UPDATE', 'DELETE', 'CREATE TABLE', 'ALTER TABLE', 'LIMIT'],
  shell: ['if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'function', 'export', 'local', 'echo', 'cd', 'set'],
  markdown: ['# ', '## ', '### ', '- ', '1. ', '> ', '**', '[]()', '- [ ] '],
  csharp: ['class', 'interface', 'public', 'private', 'protected', 'static', 'void', 'var', 'new', 'return', 'if', 'else', 'for', 'foreach', 'while', 'try', 'catch', 'using', 'namespace'],
  kotlin: ['fun', 'class', 'object', 'interface', 'val', 'var', 'when', 'if', 'else', 'for', 'while', 'return', 'package', 'import', 'data'],
  swift: ['func', 'class', 'struct', 'enum', 'protocol', 'let', 'var', 'if', 'else', 'for', 'while', 'return', 'guard', 'import', 'extension'],
  ruby: ['def', 'class', 'module', 'end', 'if', 'else', 'elsif', 'unless', 'while', 'do', 'each', 'require', 'attr_accessor'],
  lua: ['function', 'local', 'end', 'if', 'then', 'else', 'elseif', 'for', 'while', 'repeat', 'until', 'return', 'require'],
  powershell: ['function', 'param', 'if', 'else', 'elseif', 'foreach', 'while', 'return', 'Write-Host', 'Get-ChildItem', 'Set-Location'],
};

function languageExtension(language: string, filePath: string): Extension | null {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') return javascript({ typescript: true, jsx: ext === '.tsx' });
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return javascript({ jsx: ext === '.jsx' });
  if (['.html', '.htm', '.vue', '.svelte'].includes(ext)) return html();
  if (['.css', '.scss', '.less'].includes(ext)) return css();
  if (ext === '.json') return json();
  if (['.md', '.markdown'].includes(ext)) return markdown();
  if (ext === '.py') return python();
  if (ext === '.sql') return sql();
  if (['.c', '.h', '.cc', '.cpp', '.hpp'].includes(ext)) return cpp();
  if (ext === '.java') return java();
  if (['.cs', '.kt', '.kts', '.scala', '.dart'].includes(ext)) return java();
  if (ext === '.rs') return rust();
  if (ext === '.go') return go();
  if (['.xml', '.svg'].includes(ext)) return xml();
  if (ext === '.php') return php();
  if (['.yaml', '.yml'].includes(ext)) return yaml();
  if (['.sh', '.bash', '.zsh', '.fish'].includes(ext)) return StreamLanguage.define(shell);
  if (ext === '.rb') return StreamLanguage.define(ruby);
  if (ext === '.swift') return StreamLanguage.define(swift);
  if (ext === '.lua') return StreamLanguage.define(lua);
  if (ext === '.pl') return StreamLanguage.define(perl);
  if (ext === '.ps1') return StreamLanguage.define(powerShell);
  if (ext === '.r') return StreamLanguage.define(r);
  if (filePath.toLowerCase().endsWith('dockerfile') || ext === '.dockerfile') return StreamLanguage.define(dockerFile);
  return null;
}

function completionExtension(language: string): Extension | null {
  const items = KEYWORDS[language];
  if (!items) return null;
  return EditorState.languageData.of(() => [{ autocomplete: completeFromList(items.map(label => ({ label, type: 'keyword' }))) }]);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
function iconFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (['.html', '.htm'].includes(ext)) return '<>';
  if (['.md', '.markdown'].includes(ext)) return 'M';
  if (['.json', '.css', '.scss'].includes(ext)) return '{}';
  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return 'JS';
  if (ext === '.py') return 'PY';
  if (['.doc', '.docx', '.odt', '.rtf'].includes(ext)) return 'W';
  if (['.ppt', '.pptx', '.odp'].includes(ext)) return 'P';
  if (['.xls', '.xlsx', '.ods'].includes(ext)) return 'X';
  if (ext === '.pdf') return 'PDF';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'I';
  return '.';
}

export function installFileBrowser(options: FileBrowserOptions): FileBrowserController {
  let roots: FileRoot[] = [];
  let tabs: FileTab[] = [];
  let canvasTabs: CanvasTab[] = [];
  let activeId = '';
  let canvasLabel = options.canvasLabel();
  let surface: HTMLElement | null = null;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let collapsed = false;
  let searchQuery = '';
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const expandedRoots = new Set<string>();
  const expandedDirs = new Set<string>();
  const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const saveQueues = new Map<string, Promise<boolean>>();
  const AUTO_SAVE_DELAY = 700;
  const panel = options.mount;
  const tabRoot = document.createElement('div');
  tabRoot.className = 'workspace-tab-list';
  options.tabs.appendChild(tabRoot);

  function renderTabs(): void {
    tabRoot.textContent = '';
    for (const tab of canvasTabs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'workspace-tab canvas-tab' + (activeId === tab.id ? ' active' : '');
      button.innerHTML = '<span class="tab-dot"></span><span class="tab-name"></span>';
      button.querySelector('.tab-name')!.textContent = tab.label;
      button.addEventListener('click', () => activateCanvasTab(tab));
      tabRoot.appendChild(button);
    }
    for (const tab of tabs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'workspace-tab file-tab' + (activeId === tab.id ? ' active' : '') + (tab.dirty ? ' dirty' : '');
      button.innerHTML = '<span class="tab-file-icon">' + escapeHtml(iconFor(tab.name)) + '</span><span class="tab-name"></span><span class="tab-close" title="Close">×</span>';
      button.querySelector('.tab-name')!.textContent = tab.name;
      button.addEventListener('click', event => {
        if ((event.target as HTMLElement).classList.contains('tab-close')) return;
        void activateFile(tab.id);
      });
      button.querySelector('.tab-close')!.addEventListener('click', event => {
        event.stopPropagation();
        void closeTab(tab.id);
      });
      tabRoot.appendChild(button);
    }
  }

  function syncCanvasTab(docId: string, pageId: string, label: string): void {
    if (!docId || !pageId) return;
    const id = 'canvas:' + docId + ':' + pageId;
    let tab = canvasTabs.find(item => item.id === id);
    if (!tab) { tab = { id, docId, pageId, label: label || 'Canvas' }; canvasTabs.push(tab); }
    tab.label = label || tab.label;
    if (!activeId) activeId = id;
    else if (activeId.startsWith('canvas:') && activeId !== id) activeId = id;
    renderTabs();
  }

  function activateCanvasTab(tab: CanvasTab): void {
    flushActiveSave();
    activeId = tab.id;
    surface?.remove();
    surface = null;
    document.body.classList.remove('file-browser-mode');
    renderTabs();
    if (tab.docId && tab.pageId) options.openCanvas(tab.docId, tab.pageId);
  }

  async function activateFile(id: string): Promise<void> {
    const tab = tabs.find(item => item.id === id);
    if (!tab) return;
    flushActiveSave(id);
    activeId = id;
    document.body.classList.add('file-browser-mode');
    renderTabs();
    renderSurface(tab);
  }

  async function closeTab(id: string): Promise<void> {
    const tab = tabs.find(item => item.id === id);
    if (!tab) return;
    if (tab.dirty) {
      const saved = await saveTab(tab, true);
      if (!saved) return;
    }
    clearAutoSave(tab);
    tab.editor?.destroy();
    tabs = tabs.filter(item => item.id !== id);
    if (activeId !== id) { renderTabs(); return; }
    activeId = tabs[0]?.id || canvasTabs[0]?.id || '';
    if (!activeId) { renderTabs(); return; }
    if (activeId.startsWith('canvas:')) {
      const canvas = canvasTabs.find(item => item.id === activeId);
      if (canvas) activateCanvasTab(canvas);
      else renderTabs();
    } else await activateFile(activeId);
  }

  function flushActiveSave(excludeId?: string): void {
    const current = tabs.find(item => item.id === activeId);
    if (!current || current.id === excludeId || !current.dirty) return;
    clearAutoSave(current);
    void saveTab(current, true);
  }

  function setFileSaveStatus(text: string, tone?: 'saving' | 'saved' | 'error'): void {
    const label = surface?.querySelector<HTMLElement>('[data-file-save-status]');
    if (!label) return;
    label.textContent = text;
    label.className = 'file-save-status' + (tone ? ' ' + tone : '');
  }

  function clearAutoSave(tab: FileTab): void {
    const timer = autoSaveTimers.get(tab.id);
    if (timer) clearTimeout(timer);
    autoSaveTimers.delete(tab.id);
  }

  function scheduleAutoSave(tab: FileTab): void {
    clearAutoSave(tab);
    autoSaveTimers.set(tab.id, setTimeout(() => {
      autoSaveTimers.delete(tab.id);
      if (tab.dirty) void saveTab(tab, true);
    }, AUTO_SAVE_DELAY));
  }

  function saveTab(tab: FileTab, auto = false): Promise<boolean> {
    const previous = saveQueues.get(tab.id) || Promise.resolve(true);
    const next = previous.then(() => performSave(tab, auto), () => performSave(tab, auto));
    saveQueues.set(tab.id, next);
    void next.finally(() => { if (saveQueues.get(tab.id) === next) saveQueues.delete(tab.id); });
    return next;
  }

  async function performSave(tab: FileTab, auto: boolean): Promise<boolean> {
    clearAutoSave(tab);
    const content = tab.editor?.state.doc.toString() ?? tab.content;
    if (!tab.dirty) {
      if (auto && activeId === tab.id) setFileSaveStatus('Saved', 'saved');
      return true;
    }
    if (activeId === tab.id) setFileSaveStatus(auto ? 'Auto-saving…' : 'Saving…', 'saving');
    try {
      await options.request('/api/files/write', { method: 'POST', body: JSON.stringify({ root: tab.rootId, path: tab.path, content }) });
      tab.content = content;
      const latest = tab.editor?.state.doc.toString() ?? content;
      tab.dirty = latest !== content;
      if (tab.dirty) scheduleAutoSave(tab);
      renderTabs();
      if (activeId === tab.id) setFileSaveStatus(auto ? 'Auto-saved' : 'Saved', 'saved');
      if (!auto) options.toast('Saved ' + tab.name, 'success');
      return true;
    } catch (error) {
      if (activeId === tab.id) setFileSaveStatus('Save failed', 'error');
      options.toast(error instanceof Error ? error.message : String(error), 'error');
      return false;
    }
  }

  function editorExtensions(tab: FileTab, editable: boolean): Extension[] {
    const extensions: Extension[] = [basicSetup, EditorView.lineWrapping, oneDark, EditorView.editable.of(editable), EditorState.readOnly.of(!editable)];
    const language = languageExtension(tab.language, tab.path);
    if (language) extensions.push(language);
    const completion = completionExtension(tab.language);
    if (completion) extensions.push(completion);
    extensions.push(EditorView.updateListener.of(update => {
      if (!update.docChanged) return;
      tab.content = update.state.doc.toString();
      tab.dirty = true;
      renderTabs();
      if (activeId === tab.id) setFileSaveStatus('Auto-save pending', 'saving');
      scheduleAutoSave(tab);
    }));
    return extensions;
  }

  function mountEditor(host: HTMLElement, tab: FileTab, value: string): void {
    const editorHost = document.createElement('div');
    editorHost.className = 'file-editor-host';
    host.appendChild(editorHost);
    if (tab.editor) {
      editorHost.appendChild(tab.editor.dom);
      applyEditorZoom(tab);
      return;
    }
    tab.editor = new EditorView({ doc: value, extensions: editorExtensions(tab, tab.mode === 'edit'), parent: editorHost });
    applyEditorZoom(tab);
  }
  function applyEditorZoom(tab: FileTab): void {
    tab.editor?.dom.style.setProperty('--hc-editor-font-size', tab.fontSize + 'px');
  }
  function setEditorZoom(tab: FileTab, nextSize: number): void {
    tab.fontSize = Math.max(9, Math.min(30, nextSize));
    applyEditorZoom(tab);
    const label = surface?.querySelector<HTMLElement>('[data-file-zoom]');
    if (label) label.textContent = Math.round(tab.fontSize / 13 * 100) + '%';
  }

  function mountMarkdownEditor(host: HTMLElement, tab: FileTab): void {
    const layout = document.createElement('div');
    layout.className = 'file-markdown-editor';
    const editorHost = document.createElement('div');
    editorHost.className = 'file-editor-host';
    const preview = document.createElement('div');
    preview.className = 'file-markdown-view';
    layout.appendChild(editorHost);
    layout.appendChild(preview);
    host.appendChild(layout);
    if (tab.editor) {
      editorHost.appendChild(tab.editor.dom);
    } else {
      tab.editor = new EditorView({ doc: tab.content, extensions: editorExtensions(tab, true), parent: editorHost });
    }
    applyEditorZoom(tab);
    const paint = (): void => { preview.innerHTML = renderMarkdownHtml(tab.editor?.state.doc.toString() || ''); };
    paint();
    tab.editor.dom.addEventListener('keyup', () => {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(paint, 200);
    });
  }

  function renderSurface(tab: FileTab): void {
    surface?.remove();
    surface = document.createElement('div');
    surface.className = 'file-surface';
    const image = tab.preview === 'image';
    const editable = tab.preview === 'text';
    const isHtml = ['.html', '.htm'].includes(tab.ext);
    const isMarkdown = ['.md', '.markdown'].includes(tab.ext);
    const canToggle = editable && (isHtml || isMarkdown);
    const editorActive = editable && tab.mode === 'edit';
    const toggle = canToggle ? '<button type="button" class="btn tiny" data-file-action="toggle">' + (tab.mode === 'edit' ? 'Preview' : isHtml ? 'Source' : 'Edit') + '</button>' : '';
    const zoom = editorActive ? '<span class="file-zoom-group" title="Ctrl/Cmd + wheel to zoom"><button type="button" class="file-zoom-btn" data-file-action="zoom-out">−</button><span class="file-zoom-value" data-file-zoom>' + Math.round(tab.fontSize / 13 * 100) + '%</span><button type="button" class="file-zoom-btn" data-file-action="zoom-in">+</button></span>' : '';
    const history = editorActive ? '<button type="button" class="btn tiny" data-file-action="undo" title="Undo (Ctrl/Cmd+Z)">Undo</button><button type="button" class="btn tiny" data-file-action="redo" title="Redo (Ctrl/Cmd+Shift+Z)">Redo</button><button type="button" class="btn tiny primary" data-file-action="save">Save</button>' : '';
    const saveStatus = editorActive ? '<span class="file-save-status" data-file-save-status>Auto-save</span>' : '';
    surface.innerHTML = '<div class="file-surface-head"><div class="file-surface-title"><span class="file-type">' + escapeHtml(iconFor(tab.name)) + '</span><div><strong>' + escapeHtml(tab.name) + '</strong><small>' + escapeHtml(tab.language) + ' · ' + escapeHtml(tab.path) + '</small></div></div><div class="file-surface-actions">' + saveStatus + zoom + toggle + history + '<button type="button" class="btn tiny" data-file-action="close">Close</button></div></div><div class="file-surface-body"></div>';
    options.viewport.appendChild(surface);
    for (const eventName of ['pointerdown', 'mousedown', 'click', 'wheel']) {
      surface.addEventListener(eventName, event => event.stopPropagation(), { passive: eventName === 'wheel' });
    }
    const body = surface.querySelector<HTMLElement>('.file-surface-body')!;
    surface.querySelector('[data-file-action="toggle"]')?.addEventListener('click', () => {
      tab.mode = tab.mode === 'edit' ? 'view' : 'edit';
      renderSurface(tab);
    });
    surface.querySelector('[data-file-action="undo"]')?.addEventListener('click', () => { if (tab.editor) { undo(tab.editor); tab.editor.focus(); } });
    surface.querySelector('[data-file-action="redo"]')?.addEventListener('click', () => { if (tab.editor) { redo(tab.editor); tab.editor.focus(); } });
    surface.querySelector('[data-file-action="zoom-out"]')?.addEventListener('click', () => setEditorZoom(tab, tab.fontSize - 1));
    surface.querySelector('[data-file-action="zoom-in"]')?.addEventListener('click', () => setEditorZoom(tab, tab.fontSize + 1));
    surface.addEventListener('wheel', event => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (!tab.editor) return;
      event.preventDefault();
      event.stopPropagation();
      setEditorZoom(tab, tab.fontSize + (event.deltaY < 0 ? 1 : -1));
    }, { passive: false });
    surface.querySelector('[data-file-action="save"]')?.addEventListener('click', () => { void saveTab(tab, false); });
    surface.querySelector('[data-file-action="close"]')?.addEventListener('click', () => { void closeTab(tab.id); });
    if (image) { body.innerHTML = '<div class="file-image-view"><img src="' + escapeAttr(options.serveUrl(tab.rootId, tab.path)) + '" alt="' + escapeAttr(tab.name) + '"></div>'; return; }
    if (tab.preview === 'pdf') {
      const frame = document.createElement('iframe');
      frame.className = 'file-html-frame';
      frame.title = tab.name;
      frame.setAttribute('src', options.serveUrl(tab.rootId, tab.path));
      body.appendChild(frame);
      return;
    }
    if (tab.preview === 'office') {
      body.innerHTML = '<div class="file-preview-loading">Converting Office document…</div>';
      const frame = document.createElement('iframe');
      frame.className = 'file-html-frame';
      frame.title = tab.name;
      frame.setAttribute('src', options.serveUrl(tab.rootId, tab.path) + '?office=1');
      frame.addEventListener('load', () => body.querySelector('.file-preview-loading')?.remove());
      body.appendChild(frame);
      return;
    }
    if (tab.preview === 'binary') { body.innerHTML = '<div class="file-binary">Binary file · ' + escapeHtml(tab.name) + ' · no inline preview</div>'; return; }
    if (['.html', '.htm'].includes(tab.ext)) {
      if (tab.mode === 'view') {
        const iframe = document.createElement('iframe');
        iframe.className = 'file-html-frame';
        iframe.setAttribute('sandbox', 'allow-scripts');
        iframe.setAttribute('src', options.serveUrl(tab.rootId, tab.path));
        body.appendChild(iframe);
      } else mountEditor(body, tab, tab.editor?.state.doc.toString() || tab.content);
      return;
    }
    if (['.md', '.markdown'].includes(tab.ext)) {
      if (tab.mode === 'view') {
        const doc = document.createElement('div');
        doc.className = 'file-markdown-view';
        doc.innerHTML = renderMarkdownHtml(tab.content || '');
        body.appendChild(doc);
      } else mountMarkdownEditor(body, tab);
      return;
    }
    mountEditor(body, tab, tab.editor?.state.doc.toString() || tab.content);
  }

  async function openFile(rootId: string, relative: string): Promise<void> {
    const existing = tabs.find(tab => tab.rootId === rootId && tab.path === relative);
    if (existing) { await activateFile(existing.id); return; }
    try {
      const result = await options.request<{ file: FileContent }>('/api/files/read?root=' + encodeURIComponent(rootId) + '&path=' + encodeURIComponent(relative));
      const file = result.file;
      const viewOnly = file.preview !== 'text' || ['.html', '.htm'].includes(file.ext);
      const tab: FileTab = { id: 'file_' + rootId + '_' + relative, rootId, path: relative, name: file.name, language: file.language, content: file.content, binary: file.binary, ext: file.ext, preview: file.preview, mode: viewOnly ? 'view' : 'edit', dirty: false, fontSize: 13 };
      tabs.push(tab);
      await activateFile(tab.id);
    } catch (error) { options.toast(error instanceof Error ? error.message : String(error), 'error'); }
  }

  async function loadRoots(): Promise<void> {
    try {
      const result = await options.request<{ roots: FileRoot[] }>('/api/files/roots');
      roots = result.roots || [];
      renderRoots();
    } catch (error) { options.toast(error instanceof Error ? error.message : String(error), 'error'); }
  }

  function fileContextMenu(event: MouseEvent, rootId: string, relative: string, type: 'file' | 'directory', rootName: string): void {
    event.preventDefault();
    event.stopPropagation();
    document.querySelectorAll('.page-context-menu').forEach(node => node.remove());
    const menu = document.createElement('div');
    menu.className = 'page-context-menu file-context-menu';
    const actions: Array<[string, () => void]> = [];
    if (type === 'directory') {
      actions.push(['New file', () => void createEntry(rootId, relative, 'file')]);
      actions.push(['New folder', () => void createEntry(rootId, relative, 'directory')]);
    } else actions.push(['Open', () => void openFile(rootId, relative)]);
    if (relative) {
      actions.push(['Rename', () => void renameEntry(rootId, relative)]);
      actions.push(['Delete', () => void deleteEntry(rootId, relative)]);
    }
    menu.innerHTML = actions.map(([label]) => '<button type="button">' + escapeHtml(label) + '</button>').join('');
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 10)) + 'px';
    menu.style.top = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 10)) + 'px';
    menu.querySelectorAll<HTMLButtonElement>('button').forEach((button, index) => {
      button.addEventListener('click', () => { menu.remove(); actions[index]![1](); });
    });
    const close = (): void => { menu.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); };
    const outside = (down: PointerEvent): void => { if (!menu.contains(down.target as Node)) close(); };
    const escape = (key: KeyboardEvent): void => { if (key.key === 'Escape') close(); };
    setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true); }, 0);
  }

  async function refreshTree(): Promise<void> {
    await loadRoots();
  }

  async function createEntry(rootId: string, directory: string, kind: 'file' | 'directory'): Promise<void> {
    const name = window.prompt(kind === 'directory' ? 'New folder name' : 'New file name');
    if (!name?.trim()) return;
    const relative = directory ? directory + '/' + name.trim() : name.trim();
    expandedRoots.add(rootId);
    if (directory) expandedDirs.add(rootId + ':' + directory);
    try {
      await options.request('/api/files/create', { method: 'POST', body: JSON.stringify({ root: rootId, path: relative, kind }) });
      await refreshTree();
      if (kind === 'file') await openFile(rootId, relative);
      options.toast((kind === 'directory' ? 'Folder' : 'File') + ' created', 'success');
    } catch (error) { options.toast(error instanceof Error ? error.message : String(error), 'error'); }
  }

  async function renameEntry(rootId: string, relative: string): Promise<void> {
    const name = window.prompt('Rename to', relative.split('/').pop() || '');
    if (!name?.trim() || name.trim() === relative.split('/').pop()) return;
    try {
      await options.request('/api/files/rename', { method: 'POST', body: JSON.stringify({ root: rootId, path: relative, name: name.trim() }) });
      await refreshTree();
      options.toast('Renamed', 'success');
    } catch (error) { options.toast(error instanceof Error ? error.message : String(error), 'error'); }
  }

  async function deleteEntry(rootId: string, relative: string): Promise<void> {
    if (!window.confirm('Delete "' + relative + '" from disk?')) return;
    try {
      await options.request('/api/files/delete', { method: 'POST', body: JSON.stringify({ root: rootId, path: relative }) });
      await refreshTree();
      options.toast('Deleted', 'success');
    } catch (error) { options.toast(error instanceof Error ? error.message : String(error), 'error'); }
  }

  function renderToolbar(): void {
    const toolbar = document.createElement('div');
    toolbar.className = 'file-search-row';
    toolbar.innerHTML = '<input id="fileSearchInput" type="search" placeholder="Search files" value="' + escapeAttr(searchQuery) + '"><button type="button" id="fileSearchClear" title="Clear search">×</button>';
    panel.appendChild(toolbar);
    const input = toolbar.querySelector<HTMLInputElement>('#fileSearchInput')!;
    const clear = toolbar.querySelector<HTMLButtonElement>('#fileSearchClear')!;
    clear.style.visibility = searchQuery ? 'visible' : 'hidden';
    input.addEventListener('input', () => {
      searchQuery = input.value;
      clear.style.visibility = searchQuery ? 'visible' : 'hidden';
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { if (searchQuery.trim()) void renderSearchResults(); else renderRoots(); }, 180);
    });
    input.addEventListener('keydown', event => { if (event.key === 'Escape') { searchQuery = ''; input.value = ''; clear.style.visibility = 'hidden'; renderRoots(); } });
    clear.addEventListener('click', () => { searchQuery = ''; input.value = ''; clear.style.visibility = 'hidden'; renderRoots(); });
  }

  async function renderSearchResults(): Promise<void> {
    for (const child of Array.from(panel.children)) {
      if (!child.classList.contains('file-search-row')) child.remove();
    }
    const host = document.createElement('div');
    host.className = 'file-search-results';
    host.innerHTML = '<p class="files-empty">Searching…</p>';
    panel.appendChild(host);
    try {
      const result = await options.request<{ results: Array<{ rootId: string; rootName: string; name: string; path: string; type: 'file' | 'directory' }> }>('/api/files/search?q=' + encodeURIComponent(searchQuery));
      host.innerHTML = '';
      for (const entry of result.results || []) {
        const row = document.createElement('div');
        row.className = 'file-search-result ' + entry.type;
        row.innerHTML = '<span class="file-tree-icon">' + (entry.type === 'directory' ? '▸' : escapeHtml(iconFor(entry.name))) + '</span><span class="file-search-copy"><strong>' + escapeHtml(entry.name) + '</strong><small>' + escapeHtml(entry.rootName + ' / ' + entry.path) + '</small></span>';
        row.addEventListener('click', () => { if (entry.type === 'file') void openFile(entry.rootId, entry.path); });
        row.addEventListener('contextmenu', event => fileContextMenu(event, entry.rootId, entry.path, entry.type, entry.rootName));
        host.appendChild(row);
      }
      if (!result.results?.length) host.innerHTML = '<p class="files-empty">No matching files</p>';
    } catch (error) { host.innerHTML = '<p class="files-empty">' + escapeHtml(error instanceof Error ? error.message : String(error)) + '</p>'; }
  }

  function renderRoots(): void {
    panel.innerHTML = '';
    renderToolbar();
    if (searchQuery.trim()) { void renderSearchResults(); return; }
    for (const root of roots) {
      const group = document.createElement('div');
      group.className = 'file-tree-root';
      const head = document.createElement('div');
      head.className = 'file-tree-root-head';
      head.innerHTML = '<button type="button" class="file-tree-disclosure">▸</button><button type="button" class="file-tree-root-name" title="' + escapeAttr(root.path) + '">' + escapeHtml(root.name) + '</button><button type="button" class="file-tree-root-remove" title="Remove folder">×</button>';
      const children = document.createElement('div');
      children.className = 'file-tree-children hidden';
      const toggle = (): void => {
        const open = !children.classList.contains('hidden');
        if (open) { children.classList.add('hidden'); head.querySelector('.file-tree-disclosure')!.textContent = '▸'; expandedRoots.delete(root.id); return; }
        children.classList.remove('hidden');
        head.querySelector('.file-tree-disclosure')!.textContent = '▾';
        expandedRoots.add(root.id);
        if (!children.dataset.loaded) { children.dataset.loaded = '1'; void renderDirectory(root.id, '', children); }
      };
      head.querySelector('.file-tree-disclosure')!.addEventListener('click', toggle);
      head.querySelector('.file-tree-root-name')!.addEventListener('click', toggle);
      head.addEventListener('contextmenu', event => fileContextMenu(event, root.id, '', 'directory', root.name));
      head.querySelector('.file-tree-root-remove')!.addEventListener('click', async event => {
        event.stopPropagation();
        if (!window.confirm('Remove workspace folder ' + root.path + '?')) return;
        await options.request('/api/files/roots/' + encodeURIComponent(root.id), { method: 'DELETE' }).catch(() => undefined);
        await loadRoots();
      });
      group.appendChild(head);
      group.appendChild(children);
      panel.appendChild(group);
      if (expandedRoots.has(root.id)) {
        children.classList.remove('hidden');
        head.querySelector('.file-tree-disclosure')!.textContent = '▾';
        children.dataset.loaded = '1';
        void renderDirectory(root.id, '', children);
      }
    }
    if (roots.length) {
      const hint = document.createElement('p');
      hint.className = 'files-empty-hint';
      hint.textContent = 'Expand a folder to browse files.';
      panel.appendChild(hint);
    } else panel.innerHTML = '<p class="files-empty">No workspace folders</p>';
  }

  async function renderDirectory(rootId: string, relative: string, host: HTMLElement): Promise<void> {
    host.innerHTML = '<p class="files-empty">Loading…</p>';
    try {
      const result = await options.request<{ entries: FileEntry[] }>('/api/files/list?root=' + encodeURIComponent(rootId) + '&path=' + encodeURIComponent(relative));
      host.innerHTML = '';
      for (const entry of result.entries || []) {
        const row = document.createElement('div');
        row.className = 'file-tree-node ' + entry.type;
        row.innerHTML = '<span class="file-tree-icon">' + (entry.type === 'directory' ? '▸' : escapeHtml(iconFor(entry.name))) + '</span><span class="file-tree-label">' + escapeHtml(entry.name) + '</span>';
        host.appendChild(row);
        row.addEventListener('contextmenu', event => fileContextMenu(event, rootId, entry.path, entry.type, rootId));
        if (entry.type === 'directory') {
          const nested = document.createElement('div');
          const dirKey = rootId + ':' + entry.path;
          nested.className = 'file-tree-nested' + (expandedDirs.has(dirKey) ? '' : ' hidden');
          row.after(nested);
          if (expandedDirs.has(dirKey)) {
            row.querySelector('.file-tree-icon')!.textContent = '▾';
            nested.dataset.loaded = '1';
            void renderDirectory(rootId, entry.path, nested);
          }
          row.addEventListener('click', () => {
            const open = !nested.classList.contains('hidden');
            if (open) { nested.classList.add('hidden'); row.querySelector('.file-tree-icon')!.textContent = '▸'; expandedDirs.delete(dirKey); return; }
            nested.classList.remove('hidden');
            row.querySelector('.file-tree-icon')!.textContent = '▾';
            expandedDirs.add(dirKey);
            if (!nested.dataset.loaded) { nested.dataset.loaded = '1'; void renderDirectory(rootId, entry.path, nested); }
          });
        } else row.addEventListener('click', () => void openFile(rootId, entry.path));
      }
      if (!host.children.length) host.innerHTML = '<p class="files-empty">Empty folder</p>';
    } catch (error) {
      host.innerHTML = '<p class="files-empty">' + escapeHtml(error instanceof Error ? error.message : String(error)) + '</p>';
    }
  }

  async function addRoot(): Promise<void> {
    let chosen: string | null = null;
    if (options.chooseDirectory) chosen = await options.chooseDirectory();
    if (!chosen) chosen = window.prompt('Workspace folder path');
    if (!chosen) return;
    try {
      await options.request('/api/files/roots', { method: 'POST', body: JSON.stringify({ path: chosen }) });
      await loadRoots();
      options.toast('Workspace folder added', 'success');
    } catch (error) { options.toast(error instanceof Error ? error.message : String(error), 'error'); }
  }

  document.getElementById('addRootBtn')?.addEventListener('click', () => void addRoot());
  document.getElementById('collapseFilesBtn')?.addEventListener('click', () => {
    collapsed = !collapsed;
    panel.classList.toggle('files-collapsed', collapsed);
    const button = document.getElementById('collapseFilesBtn');
    if (button) button.textContent = collapsed ? '▸' : '▾';
  });
  window.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && activeId !== '') {
      const tab = tabs.find(item => item.id === activeId);
      if (tab?.mode === 'edit') { event.preventDefault(); void saveTab(tab); }
    }
  });
  window.addEventListener('hcanvas:canvas-opened', event => {
    const detail = (event as CustomEvent<{ docId?: string; pageId?: string; label?: string }>).detail || {};
    if (!detail.docId || !detail.pageId) return;
    const id = 'canvas:' + detail.docId + ':' + detail.pageId;
    syncCanvasTab(detail.docId, detail.pageId, detail.label || 'Canvas');
    const tab = canvasTabs.find(item => item.id === id);
    if (tab) {
      activeId = tab.id;
      surface?.remove();
      surface = null;
      document.body.classList.remove('file-browser-mode');
      renderTabs();
    }
  });
  renderTabs();
  void loadRoots();
  return {
    syncCanvasTab(docId: string, pageId: string, label: string): void {
      syncCanvasTab(docId, pageId, label);
    },
  };
}
