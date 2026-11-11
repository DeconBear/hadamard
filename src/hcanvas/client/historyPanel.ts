import type { HcBlock, HcDocument, HcPage } from '../types.js';

interface RevisionSummary {
  revision: number;
  actor: string;
  summary: string;
  createdAt: string;
  opCount: number;
  bytes: number;
}

interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

export interface HistoryPanelOptions {
  mount: HTMLElement;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  getDoc(): HcDocument | null;
  onRestored(docId: string): Promise<void> | void;
  confirm(message: string): Promise<boolean>;
  toast(message: string, kind?: 'success' | 'error' | 'info'): void;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pageText(page: HcPage): string {
  if (page.markdown !== undefined) return page.markdown;
  if (page.mode === 'html') return (page.html || '').replace(/></g, '>\n<');
  return (page.blocks || []).map(block => blockSummary(block)).join('\n');
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
  return [
    ...left.slice(0, prefix).map(text => ({ type: 'same' as const, text })),
    ...middle,
    ...left.slice(left.length - suffix).map(text => ({ type: 'same' as const, text })),
  ];
}

function renderDiff(before: HcDocument, after: HcDocument): string {
  const sections: string[] = [];
  sections.push('<div class="history-diff-title">revision ' + before.revision + ' → current revision ' + after.revision + '</div>');
  if (before.title !== after.title) sections.push('<div class="history-diff-section"><h4>Title</h4><pre>' + escapeHtml('- ' + before.title + '\n+ ' + after.title) + '</pre></div>');
  const beforePages = new Map(before.pages.map(page => [page.id, page]));
  const afterPages = new Map(after.pages.map(page => [page.id, page]));
  for (const page of after.pages) {
    const old = beforePages.get(page.id);
    if (!old) { sections.push('<div class="history-diff-section"><h4>+ Page: ' + escapeHtml(page.name) + '</h4></div>'); continue; }
    const lines = diffLines(pageText(old), pageText(page)).slice(0, 220);
    const nameChanged = old.name !== page.name;
    if (nameChanged || lines.some(line => line.type !== 'same')) {
      sections.push('<div class="history-diff-section"><h4>Page: ' + escapeHtml(page.name) + ' <span>' + escapeHtml(old.markdown !== undefined ? 'markdown' : page.mode) + '</span></h4>' + (nameChanged ? '<pre>- ' + escapeHtml(old.name) + '\n+ ' + escapeHtml(page.name) + '</pre>' : '') + (lines.some(line => line.type !== 'same') ? '<pre>' + lines.map(line => (line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  ') + escapeHtml(line.text.slice(0, 300))).join('\n') + '</pre>' : '') + '</div>');
    }
  }
  for (const page of before.pages) if (!afterPages.has(page.id)) sections.push('<div class="history-diff-section"><h4>- Page: ' + escapeHtml(page.name) + '</h4></div>');
  return sections.length > 1 ? sections.join('') : '<p class="empty-state">No textual differences in this revision.</p>';
}

export function installHistoryPanel(options: HistoryPanelOptions): { render(): void } {
  let revisions: RevisionSummary[] = [];
  let selected: number | null = null;
  let loading = false;

  async function load(): Promise<void> {
    const doc = options.getDoc();
    if (!doc) { options.mount.innerHTML = '<p class="empty-state">Open a document to see history.</p>'; return; }
    loading = true;
    options.mount.innerHTML = '<p class="empty-state">Loading revisions…</p>';
    try { revisions = (await options.request<{ revisions: RevisionSummary[] }>('/api/docs/' + doc.id + '/revisions')).revisions || []; }
    catch (error) { options.mount.innerHTML = '<p class="empty-state">' + escapeHtml(error instanceof Error ? error.message : String(error)) + '</p>'; return; }
    finally { loading = false; }
    paint();
  }

  function paint(): void {
    const doc = options.getDoc();
    if (!doc) { options.mount.innerHTML = '<p class="empty-state">Open a document to see history.</p>'; return; }
    let html = '<div class="history-head"><div><strong>Revision history</strong><small>' + revisions.length + ' saved revisions · current r' + doc.revision + '</small></div><button type="button" id="historyRefreshBtn" class="btn tiny">Refresh</button></div>';
    if (!revisions.length) html += '<p class="empty-state">No revision snapshots yet. New edits will appear here.</p>';
    html += '<div class="history-list">';
    for (const revision of revisions) {
      const current = revision.revision === doc.revision;
      html += '<div class="history-item' + (selected === revision.revision ? ' selected' : '') + '"><button type="button" class="history-main" data-history-rev="' + revision.revision + '"><span class="history-rev">r' + revision.revision + '</span><span class="history-copy"><strong>' + escapeHtml(revision.summary) + '</strong><small>' + escapeHtml(revision.actor) + ' · ' + escapeHtml(new Date(revision.createdAt).toLocaleString()) + ' · ' + revision.opCount + ' ops</small></span>' + (current ? '<span class="history-current">current</span>' : '') + '</button><div class="history-actions"><button type="button" class="btn tiny" data-history-restore="' + revision.revision + '">Restore</button></div></div>';
    }
    html += '</div><div id="historyDiff" class="history-diff"></div>';
    options.mount.innerHTML = html;
    options.mount.querySelector('#historyRefreshBtn')?.addEventListener('click', () => void load());
    options.mount.querySelectorAll<HTMLButtonElement>('[data-history-rev]').forEach(button => {
      button.addEventListener('click', () => { selected = Number(button.dataset.historyRev); paint(); if (selected !== null) void showDiff(selected); });
    });
    options.mount.querySelectorAll<HTMLButtonElement>('[data-history-restore]').forEach(button => {
      button.addEventListener('click', async () => {
        const revision = Number(button.dataset.historyRestore);
        const ok = await options.confirm('Restore revision ' + revision + '? This creates a new revision and keeps the current one in history.');
        if (!ok) return;
        try {
          const result = await options.request<{ doc: HcDocument }>('/api/docs/' + doc.id + '/restore', { method: 'POST', body: JSON.stringify({ revision, baseRevision: doc.revision, actor: 'human' }) });
          options.toast('Restored revision ' + revision + ' as r' + result.doc.revision, 'success');
          await options.onRestored(result.doc.id);
          await load();
        } catch (error) { options.toast(error instanceof Error ? error.message : String(error), 'error'); }
      });
    });
  }

  async function showDiff(revision: number): Promise<void> {
    const doc = options.getDoc();
    if (!doc) return;
    const host = options.mount.querySelector<HTMLElement>('#historyDiff');
    if (!host) return;
    host.innerHTML = '<p class="empty-state">Loading diff…</p>';
    try {
      const snapshot = (await options.request<{ doc: HcDocument }>('/api/docs/' + doc.id + '/revisions/' + revision)).doc;
      host.innerHTML = renderDiff(snapshot, doc);
    } catch (error) { host.innerHTML = '<p class="empty-state">' + escapeHtml(error instanceof Error ? error.message : String(error)) + '</p>'; }
  }

  return { render: () => void load() };
}
