import { basicSetup, EditorView } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { completeFromList } from '@codemirror/autocomplete';
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
interface FileContent { path: string; name: string; ext: string; size: number; binary: boolean; content: string; language: string; }
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
  mode: 'view' | 'edit';
  dirty: boolean;
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
        closeTab(tab.id);
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
    activeId = id;
    document.body.classList.add('file-browser-mode');
    renderTabs();
    renderSurface(tab);
  }

  function closeTab(id: string): void {
    const tab = tabs.find(item => item.id === id);
    if (!tab) return;
    if (tab.dirty && !window.confirm('Discard unsaved changes in ' + tab.name + '?')) return;
    tab.editor?.destroy();
    tabs = tabs.filter(item => item.id !== id);
    if (activeId !== id) { renderTabs(); return; }
    activeId = tabs[0]?.id || canvasTabs[0]?.id || '';
    if (!activeId) { renderTabs(); return; }
    if (activeId.startsWith('canvas:')) {
      const canvas = canvasTabs.find(item => item.id === activeId);
      if (canvas) activateCanvasTab(canvas);
      else renderTabs();
    } else void activateFile(activeId);
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
    }));
    return extensions;
  }

  function mountEditor(host: HTMLElement, tab: FileTab, value: string): void {
    tab.editor?.destroy();
    const editorHost = document.createElement('div');
    editorHost.className = 'file-editor-host';
    host.appendChild(editorHost);
    tab.editor = new EditorView({ doc: value, extensions: editorExtensions(tab, tab.mode === 'edit'), parent: editorHost });
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
    tab.editor = new EditorView({ doc: tab.content, extensions: editorExtensions(tab, true), parent: editorHost });
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
    const image = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'].includes(tab.ext);
    const editable = !image && !tab.binary;
    surface.innerHTML = '<div class="file-surface-head"><div class="file-surface-title"><span class="file-type">' + escapeHtml(iconFor(tab.name)) + '</span><div><strong>' + escapeHtml(tab.name) + '</strong><small>' + escapeHtml(tab.language) + ' · ' + escapeHtml(tab.path) + '</small></div></div><div class="file-surface-actions">' + (editable ? '<button type="button" class="btn tiny" data-file-action="toggle">' + (tab.mode === 'edit' ? 'Preview' : 'Edit') + '</button><button type="button" class="btn tiny primary" data-file-action="save">Save</button>' : '') + '<button type="button" class="btn tiny" data-file-action="close">Close</button></div></div><div class="file-surface-body"></div>';
    options.viewport.appendChild(surface);
    for (const eventName of ['pointerdown', 'mousedown', 'click', 'wheel']) {
      surface.addEventListener(eventName, event => event.stopPropagation(), { passive: eventName === 'wheel' });
    }
    const body = surface.querySelector<HTMLElement>('.file-surface-body')!;
    surface.querySelector('[data-file-action="toggle"]')?.addEventListener('click', () => {
      tab.mode = tab.mode === 'edit' ? 'view' : 'edit';
      renderSurface(tab);
    });
    surface.querySelector('[data-file-action="save"]')?.addEventListener('click', () => { void saveTab(tab); });
    surface.querySelector('[data-file-action="close"]')?.addEventListener('click', () => closeTab(tab.id));
    if (image) { body.innerHTML = '<div class="file-image-view"><img src="' + escapeAttr(options.serveUrl(tab.rootId, tab.path)) + '" alt="' + escapeAttr(tab.name) + '"></div>'; return; }
    if (tab.binary) { body.innerHTML = '<div class="file-binary">Binary file · ' + escapeHtml(tab.name) + '</div>'; return; }
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

  async function saveTab(tab: FileTab): Promise<void> {
    const content = tab.editor?.state.doc.toString() ?? tab.content;
    try {
      await options.request('/api/files/write', { method: 'POST', body: JSON.stringify({ root: tab.rootId, path: tab.path, content }) });
      tab.content = content;
      tab.dirty = false;
      renderTabs();
      options.toast('Saved ' + tab.name, 'success');
    } catch (error) { options.toast(error instanceof Error ? error.message : String(error), 'error'); }
  }

  async function openFile(rootId: string, relative: string): Promise<void> {
    const existing = tabs.find(tab => tab.rootId === rootId && tab.path === relative);
    if (existing) { await activateFile(existing.id); return; }
    try {
      const result = await options.request<{ file: FileContent }>('/api/files/read?root=' + encodeURIComponent(rootId) + '&path=' + encodeURIComponent(relative));
      const file = result.file;
      const tab: FileTab = { id: 'file_' + rootId + '_' + relative, rootId, path: relative, name: file.name, language: file.language, content: file.content, binary: file.binary, ext: file.ext, mode: 'view', dirty: false };
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

  function renderRoots(): void {
    panel.innerHTML = '';
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
        if (open) { children.classList.add('hidden'); head.querySelector('.file-tree-disclosure')!.textContent = '▸'; return; }
        children.classList.remove('hidden');
        head.querySelector('.file-tree-disclosure')!.textContent = '▾';
        if (!children.dataset.loaded) { children.dataset.loaded = '1'; void renderDirectory(root.id, '', children); }
      };
      head.querySelector('.file-tree-disclosure')!.addEventListener('click', toggle);
      head.querySelector('.file-tree-root-name')!.addEventListener('click', toggle);
      head.querySelector('.file-tree-root-remove')!.addEventListener('click', async event => {
        event.stopPropagation();
        if (!window.confirm('Remove workspace folder ' + root.path + '?')) return;
        await options.request('/api/files/roots/' + encodeURIComponent(root.id), { method: 'DELETE' }).catch(() => undefined);
        await loadRoots();
      });
      group.appendChild(head);
      group.appendChild(children);
      panel.appendChild(group);
    }
    if (!roots.length) panel.innerHTML = '<p class="files-empty">No workspace folders</p>';
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
        if (entry.type === 'directory') {
          const nested = document.createElement('div');
          nested.className = 'file-tree-nested hidden';
          row.after(nested);
          row.addEventListener('click', () => {
            const open = !nested.classList.contains('hidden');
            if (open) { nested.classList.add('hidden'); row.querySelector('.file-tree-icon')!.textContent = '▸'; return; }
            nested.classList.remove('hidden');
            row.querySelector('.file-tree-icon')!.textContent = '▾';
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
    if (button) button.textContent = collapsed ? '⌄' : '⌃';
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
