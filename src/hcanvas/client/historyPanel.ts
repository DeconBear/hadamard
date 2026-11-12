import type { HcBlock, HcDocument, HcPage } from '../types.js';
import { historyEntryLabel } from '../historySummary.js';
import { renderHistoryPreview } from './historyPreview.js';

interface RevisionSummary {
  revision: number;
  actor: string;
  summary: string;
  createdAt: string;
  opCount: number;
  bytes: number;
}

interface DiffLine {
  type: 'same' | 'add' | 'del' | 'gap';
  text: string;
}

export interface HistoryPanelOptions {
  mount: HTMLElement;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  getDoc(): HcDocument | null;
  getActivePageId?(): string | null;
  onRestored(docId: string): Promise<void> | void;
  confirm(message: string): Promise<boolean>;
  toast(message: string, kind?: 'success' | 'error' | 'info'): void;
}

export interface HistoryPanelController {
  render(): void;
  refresh(): void;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pageText(page: HcPage): string {
  const layout = 'Size: ' + page.width + ' × ' + page.height + '\nBackground: ' + page.background + (page.notes ? '\nNotes: ' + page.notes : '');
  if (page.markdown !== undefined) return layout + '\n\n' + page.markdown;
  if (page.mode === 'html') return layout + '\n\n' + (page.html || '').replace(/></g, '>\n<');
  return layout + '\n\n' + (page.blocks || []).map(block => blockSummary(block)).join('\n');
}

function blockSummary(block: HcBlock): string {
  const name = block.name || block.alt || block.text || block.markdown || block.code || block.src || block.type;
  return 'block ' + block.id + ' [' + block.type + '] ' + block.x + ',' + block.y + ' ' + block.w + '×' + block.h + ' ' + String(name).replace(/\s+/g, ' ').slice(0, 120);
}

function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split('\n');
  const right = after.split('\n');
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  const a = left.slice(prefix, left.length - suffix);
  const b = right.slice(prefix, right.length - suffix);
  if (a.length * b.length > 250000) {
    return [...left.slice(0, prefix).map(text => ({ type: 'same' as const, text })), ...a.map(text => ({ type: 'del' as const, text })), ...b.map(text => ({ type: 'add' as const, text })), ...left.slice(left.length - suffix).map(text => ({ type: 'same' as const, text }))];
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0) as number[]);
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const middle: DiffLine[] = [];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { middle.push({ type: 'same', text: a[i]! }); i += 1; j += 1; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { middle.push({ type: 'del', text: a[i]! }); i += 1; }
    else { middle.push({ type: 'add', text: b[j]! }); j += 1; }
  }
  while (i < a.length) { middle.push({ type: 'del', text: a[i]! }); i += 1; }
  while (j < b.length) { middle.push({ type: 'add', text: b[j]! }); j += 1; }
  return [...left.slice(0, prefix).map(text => ({ type: 'same' as const, text })), ...middle, ...left.slice(left.length - suffix).map(text => ({ type: 'same' as const, text }))];
}

function compactDiff(lines: DiffLine[]): DiffLine[] {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.type === 'same') return;
    for (let i = Math.max(0, index - 2); i <= Math.min(lines.length - 1, index + 2); i += 1) keep.add(i);
  });
  const result: DiffLine[] = [];
  lines.forEach((line, index) => {
    if (keep.has(index)) result.push(line);
    else if (result[result.length - 1]?.type !== 'gap') result.push({ type: 'gap', text: '…' });
  });
  return result.slice(0, 220);
}

export function renderRevisionDiff(before: HcDocument, after: HcDocument): string {
  const sections: string[] = [];
  const beforePages = new Map(before.pages.map(page => [page.id, page]));
  const afterPages = new Map(after.pages.map(page => [page.id, page]));
  const added = after.pages.filter(page => !beforePages.has(page.id)).length;
  const removed = before.pages.filter(page => !afterPages.has(page.id)).length;
  const changed = after.pages.filter(page => {
    const old = beforePages.get(page.id);
    return old && (old.name !== page.name || pageText(old) !== pageText(page));
  }).length;
  sections.push('<div class="history-diff-title"><span>r' + before.revision + ' → r' + after.revision + '</span><span>' + changed + ' edited' + (added ? ' · ' + added + ' added' : '') + (removed ? ' · ' + removed + ' removed' : '') + '</span></div>');
  if (before.title !== after.title) sections.push('<div class="history-diff-section"><h4>Canvas title</h4><pre><span class="diff-del">- ' + escapeHtml(before.title) + '</span>\n<span class="diff-add">+ ' + escapeHtml(after.title) + '</span></pre></div>');
  for (const page of after.pages) {
    const old = beforePages.get(page.id);
    if (!old) { sections.push('<div class="history-diff-section"><h4><span class="diff-add">Added page</span> · ' + escapeHtml(page.name) + '</h4></div>'); continue; }
    const lines = compactDiff(diffLines(pageText(old), pageText(page)));
    const nameChanged = old.name !== page.name;
    if (nameChanged || lines.some(line => line.type !== 'same' && line.type !== 'gap')) {
      sections.push('<div class="history-diff-section"><h4>' + escapeHtml(page.name) + ' <span>' + escapeHtml(page.markdown !== undefined ? 'Markdown' : page.mode) + '</span></h4>' + (nameChanged ? '<pre><span class="diff-del">- ' + escapeHtml(old.name) + '</span>\n<span class="diff-add">+ ' + escapeHtml(page.name) + '</span></pre>' : '') + (lines.some(line => line.type === 'add' || line.type === 'del') ? '<pre>' + lines.map(line => '<span class="diff-' + line.type + '">' + (line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  ') + escapeHtml(line.text.slice(0, 300)) + '</span>').join('\n') + '</pre>' : '') + '</div>');
    }
  }
  for (const page of before.pages) if (!afterPages.has(page.id)) sections.push('<div class="history-diff-section"><h4><span class="diff-del">Removed page</span> · ' + escapeHtml(page.name) + '</h4></div>');
  return sections.length > 1 ? sections.join('') : '<p class="empty-state">No content changes in this comparison.</p>';
}

function relativeTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsed < 60000) return 'just now';
  if (elapsed < 3600000) return Math.floor(elapsed / 60000) + 'm ago';
  if (elapsed < 86400000) return Math.floor(elapsed / 3600000) + 'h ago';
  if (elapsed < 604800000) return Math.floor(elapsed / 86400000) + 'd ago';
  return new Date(value).toLocaleDateString();
}

export function installHistoryPanel(options: HistoryPanelOptions): HistoryPanelController {
  let revisions: RevisionSummary[] = [];
  let selected: number | null = null;
  let previewPageId: string | null = null;
  let loadedDocId = '';
  let loadedRevision = -1;
  let query = '';
  let comparison: 'edit' | 'current' = 'edit';
  let listRequest = 0;
  let detailRequest = 0;
  let pendingDocId = '';
  let restoring = false;
  const snapshots = new Map<string, HcDocument>();

  async function readSnapshot(docId: string, revision: number): Promise<HcDocument> {
    const key = docId + ':' + revision;
    const cached = snapshots.get(key);
    if (cached) return cached;
    const snapshot = (await options.request<{ doc: HcDocument }>('/api/docs/' + docId + '/revisions/' + revision)).doc;
    snapshots.set(key, snapshot);
    if (snapshots.size > 10) snapshots.delete(snapshots.keys().next().value || '');
    return snapshot;
  }

  async function load(force = false): Promise<void> {
    const doc = options.getDoc();
    if (!doc || (pendingDocId === doc.id && !force)) return;
    pendingDocId = doc.id;
    const requestId = ++listRequest;
    try {
      const result = await options.request<{ revisions: RevisionSummary[] }>('/api/docs/' + doc.id + '/revisions');
      if (requestId !== listRequest || options.getDoc()?.id !== doc.id) return;
      revisions = result.revisions || [];
      loadedDocId = doc.id;
      loadedRevision = doc.revision;
      if (selected === null || !revisions.some(item => item.revision === selected)) selected = revisions.find(item => item.revision === doc.revision)?.revision ?? revisions[0]?.revision ?? null;
      paint();
      if (selected !== null) void showRevision(selected);
    } catch (error) {
      if (requestId === listRequest && options.getDoc()?.id === doc.id) {
        const host = options.mount.querySelector('#historyList');
        if (host) host.innerHTML = '<p class="empty-state">' + escapeHtml(error instanceof Error ? error.message : String(error)) + '</p>';
      }
    } finally {
      if (requestId === listRequest && pendingDocId === doc.id) pendingDocId = '';
    }
  }

  function renderList(): void {
    const doc = options.getDoc();
    const host = options.mount.querySelector<HTMLElement>('#historyList');
    if (!host || !doc) return;
    const normalized = query.trim().toLowerCase();
    const filtered = revisions.filter(revision => !normalized || (historyEntryLabel(revision.summary) + ' ' + revision.actor + ' r' + revision.revision).toLowerCase().includes(normalized));
    const count = options.mount.querySelector('#historyMatchCount');
    if (count) count.textContent = normalized ? filtered.length + ' of ' + revisions.length : revisions.length + ' revisions';
    host.innerHTML = filtered.length ? filtered.map(revision => {
      const current = revision.revision === doc.revision;
      const active = selected === revision.revision;
      const summary = historyEntryLabel(revision.summary);
      return '<div class="history-item' + (active ? ' selected' : '') + '" role="presentation"><button type="button" class="history-main" data-history-rev="' + revision.revision + '" aria-pressed="' + active + '"><span class="history-rev">r' + revision.revision + '</span><span class="history-copy"><strong title="' + escapeHtml(summary) + '">' + escapeHtml(summary) + '</strong><small>' + escapeHtml(revision.actor) + ' · <span title="' + escapeHtml(new Date(revision.createdAt).toLocaleString()) + '">' + escapeHtml(relativeTime(revision.createdAt)) + '</span></small></span>' + (current ? '<span class="history-current">Current</span>' : '') + '</button></div>';
    }).join('') : '<p class="empty-state">' + (revisions.length ? 'No revisions match this filter.' : 'No revision snapshots yet. New edits will appear here.') + '</p>';
  }

  function paint(): void {
    const doc = options.getDoc();
    if (!doc) { options.mount.innerHTML = '<p class="empty-state">Open a document to see history.</p>'; return; }
    if (!options.mount.querySelector('.history-head')) {
      options.mount.innerHTML = '<div class="history-head"><div><strong>Revision history</strong><small id="historyHeadMeta"></small></div><button type="button" class="btn tiny history-refresh" title="Refresh history" aria-label="Refresh history">↻</button></div><div class="history-tools"><input id="historySearch" type="search" placeholder="Filter edits…" aria-label="Filter revision history" /><span id="historyMatchCount"></span></div><div id="historyList" class="history-list" role="listbox" aria-label="Saved revisions"></div><div id="historyDetail" class="history-detail"></div>';
      options.mount.querySelector<HTMLInputElement>('#historySearch')?.addEventListener('input', event => { query = (event.target as HTMLInputElement).value; renderList(); });
    }
    const search = options.mount.querySelector<HTMLInputElement>('#historySearch');
    if (search && search.value !== query) search.value = query;
    const meta = options.mount.querySelector('#historyHeadMeta');
    if (meta) meta.textContent = 'Current r' + doc.revision + ' · automatic snapshots';
    renderList();
  }

  async function showRevision(revision: number): Promise<void> {
    const doc = options.getDoc();
    const host = options.mount.querySelector<HTMLElement>('#historyDetail');
    if (!doc || !host) return;
    const requestId = ++detailRequest;
    const currentRevision = doc.revision;
    host.innerHTML = '<p class="empty-state history-loading">Loading r' + revision + '…</p>';
    try {
      const snapshot = await readSnapshot(doc.id, revision);
      const index = revisions.findIndex(item => item.revision === revision);
      const previousRevision = comparison === 'edit' ? revisions[index + 1]?.revision : undefined;
      const before = comparison === 'current' ? snapshot : previousRevision !== undefined ? await readSnapshot(doc.id, previousRevision) : null;
      if (requestId !== detailRequest || selected !== revision || options.getDoc()?.id !== doc.id) return;
      const isCurrent = currentRevision === revision;
      const pages = snapshot.pages;
      if (!previewPageId || !pages.some(page => page.id === previewPageId)) previewPageId = pages.find(page => page.id === options.getActivePageId?.())?.id || pages[0]?.id || null;
      host.innerHTML = '<div class="history-detail-head"><div><strong>r' + revision + (isCurrent ? ' <span>Current</span>' : '') + '</strong><small>' + escapeHtml(new Date(snapshot.updatedAt).toLocaleString()) + '</small></div><button type="button" class="btn tiny" data-history-restore="' + revision + '"' + (isCurrent || restoring ? ' disabled' : '') + '>Restore</button></div>' + (pages.length ? '<div class="history-preview-tools"><select data-history-page aria-label="Preview page">' + pages.map(page => '<option value="' + escapeHtml(page.id) + '"' + (page.id === previewPageId ? ' selected' : '') + '>' + escapeHtml(page.name) + '</option>').join('') + '</select><span>Read-only</span></div><div id="historyPreview" class="history-preview"></div>' : '<p class="empty-state">This revision has no pages.</p>') + '<div class="history-compare" role="group" aria-label="Revision comparison"><button type="button" data-history-mode="edit" class="' + (comparison === 'edit' ? 'active' : '') + '" aria-pressed="' + (comparison === 'edit') + '">This edit</button><button type="button" data-history-mode="current" class="' + (comparison === 'current' ? 'active' : '') + '" aria-pressed="' + (comparison === 'current') + '">Vs current</button></div><div id="historyDiff" class="history-diff">' + (before ? renderRevisionDiff(before, comparison === 'edit' ? snapshot : doc) : '<p class="empty-state history-initial">Initial snapshot · no earlier version to compare.</p>') + '</div><p class="history-restore-note">Restoring creates a new revision. Your current work remains in history.</p>';
      const preview = host.querySelector<HTMLElement>('#historyPreview');
      const page = pages.find(item => item.id === previewPageId);
      if (preview && page) renderHistoryPreview(preview, page);
    } catch (error) {
      if (requestId === detailRequest) host.innerHTML = '<p class="empty-state">' + escapeHtml(error instanceof Error ? error.message : String(error)) + '</p>';
    }
  }

  options.mount.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const revisionButton = target.closest<HTMLButtonElement>('[data-history-rev]');
    if (revisionButton) {
      selected = Number(revisionButton.dataset.historyRev);
      previewPageId = null;
      renderList();
      void showRevision(selected);
      return;
    }
    if (target.closest('.history-refresh')) { void load(true); return; }
    const mode = target.closest<HTMLButtonElement>('[data-history-mode]')?.dataset.historyMode;
    if (mode === 'edit' || mode === 'current') { comparison = mode; if (selected !== null) void showRevision(selected); }
  });
  options.mount.addEventListener('change', event => {
    const select = (event.target as HTMLElement).closest<HTMLSelectElement>('[data-history-page]');
    const doc = options.getDoc();
    if (!select || selected === null || !doc) return;
    previewPageId = select.value;
    const snapshot = snapshots.get(doc.id + ':' + selected);
    const page = snapshot?.pages.find(item => item.id === previewPageId);
    const preview = options.mount.querySelector<HTMLElement>('#historyPreview');
    if (page && preview) renderHistoryPreview(preview, page);
  });
  options.mount.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !(event.target as HTMLElement).matches('[data-history-rev]')) return;
    event.preventDefault();
    const buttons = Array.from(options.mount.querySelectorAll<HTMLButtonElement>('[data-history-rev]'));
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    const next = buttons[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) { next.focus(); next.click(); }
  });

  async function restore(revision: number): Promise<void> {
    const doc = options.getDoc();
    if (!doc || restoring || revision === doc.revision) return;
    const ok = await options.confirm('Restore revision ' + revision + '? This creates a new revision and keeps the current one in history.');
    if (!ok || restoring) return;
    const current = options.getDoc();
    if (!current || current.id !== doc.id) return;
    restoring = true;
    if (selected !== null) void showRevision(selected);
    try {
      const result = await options.request<{ doc: HcDocument }>('/api/docs/' + doc.id + '/restore', { method: 'POST', body: JSON.stringify({ revision, baseRevision: current.revision, actor: 'human' }) });
      selected = result.doc.revision;
      options.toast('Restored r' + revision + ' as r' + result.doc.revision + '. Previous work is still in history.', 'success');
      await options.onRestored(result.doc.id);
      await load(true);
    } catch (error) { options.toast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { restoring = false; if (selected !== null) void showRevision(selected); }
  }
  options.mount.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-history-restore]');
    if (button) void restore(Number(button.dataset.historyRestore));
  });

  return {
    render: () => {
      const doc = options.getDoc();
      if (!doc) { loadedDocId = ''; loadedRevision = -1; revisions = []; selected = null; ++detailRequest; paint(); return; }
      if (loadedDocId !== doc.id) { revisions = []; selected = null; previewPageId = null; query = ''; loadedRevision = -1; }
      paint();
      if (loadedDocId !== doc.id || loadedRevision !== doc.revision) void load();
    },
    refresh: () => { if (options.getDoc()) { loadedRevision = -1; void load(); } },
  };
}
