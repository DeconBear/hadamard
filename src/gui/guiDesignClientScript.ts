export const GUI_DESIGN_CLIENT_SCRIPT = String.raw`
function normalizeDesignAssetPath(basePath, reference) {
  const value = String(reference || '').trim().replace(/\\/g, '/');
  if (!value || value.startsWith('/') || value.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  const base = String(basePath || '').split('/').filter(Boolean);
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { if (!base.length) return null; base.pop(); }
    else base.push(segment);
  }
  return base.join('/');
}
async function designAssetDataUrl(relativePath) {
  const response = await api('/api/design/asset?path=' + encodeURIComponent(relativePath));
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return 'data:' + (response.headers.get('content-type') || 'application/octet-stream') + ';base64,' + bytesToBase64(bytes);
}
async function inlineDesignCssAssets(css, basePath) {
  const matches = [...String(css || '').matchAll(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/gi)];
  let result = String(css || '');
  for (const match of matches.reverse()) {
    const relativePath = normalizeDesignAssetPath(basePath, match[1]);
    if (!relativePath || match.index == null) continue;
    const dataUrl = await designAssetDataUrl(relativePath);
    if (dataUrl) result = result.slice(0, match.index) + 'url("' + dataUrl + '")' + result.slice(match.index + match[0].length);
  }
  return result;
}
async function loadDesignHtmlPreview(frame) {
  try {
    const response = await api('/api/design/preview?load=' + Date.now());
    if (!response.ok) throw new Error(await response.text());
    const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
    parsed.querySelectorAll('script').forEach(node => node.remove());
    parsed.querySelectorAll('*').forEach(node => {
      for (const attribute of [...node.attributes]) if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
    });
    for (const link of [...parsed.querySelectorAll('link[rel="stylesheet"][href]')]) {
      const relativePath = normalizeDesignAssetPath('', link.getAttribute('href'));
      if (!relativePath) { link.remove(); continue; }
      const cssResponse = await api('/api/design/asset?path=' + encodeURIComponent(relativePath));
      if (!cssResponse.ok) { link.remove(); continue; }
      const style = parsed.createElement('style');
      style.textContent = await inlineDesignCssAssets(await cssResponse.text(), relativePath.split('/').slice(0, -1).join('/'));
      link.replaceWith(style);
    }
    for (const node of [...parsed.querySelectorAll('img[src], source[src]')]) {
      const relativePath = normalizeDesignAssetPath('', node.getAttribute('src'));
      if (!relativePath) { node.removeAttribute('src'); continue; }
      const dataUrl = await designAssetDataUrl(relativePath);
      if (dataUrl) node.setAttribute('src', dataUrl); else node.removeAttribute('src');
    }
    const meta = parsed.createElement('meta');
    meta.httpEquiv = 'Content-Security-Policy';
    meta.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
    parsed.head.prepend(meta);
    frame.srcdoc = '<!doctype html>' + parsed.documentElement.outerHTML;
  } catch (error) {
    frame.srcdoc = '<!doctype html><meta charset="utf-8"><p style="font:14px system-ui;color:#b42318;padding:24px">' + escapeHtml(error?.message || 'Could not load Design HTML preview') + '</p>';
  }
}
async function renderDesignPreviewServer(content) {
  const view = el('projectDocView');
  if (!view || state.projectDocSubTab !== 'design' || state.projectDocEditing) return;
  try {
    const res = await api('/api/design/render', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }),
    });
    if (!res.ok || state.projectDocRaw !== content) return;
    const data = await res.json();
    if (typeof data.bodyHtml === 'string') {
      view.innerHTML = data.bodyHtml;
      if (data.theme) {
        view.style.maxWidth = Math.min(1440, Math.max(560, Number(data.theme.pageWidth) || 920)) + 'px';
        view.style.setProperty('--design-accent', data.theme.accentColor || '#2563eb');
      }
    }
  } catch { /* local safe Markdown renderer remains the fallback */ }
}
function updateDesignFrontmatter(key, value) {
  let source = getProjectDocContent();
  const header = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!header) {
    source = '---\nhadamardDesignVersion: 1\ntemplate: software.general\ntemplateVersion: 1\ntheme: clean-light\nupdatedAt: ' + new Date().toISOString() + '\n---\n' + source;
  }
  const line = new RegExp('^' + key + ':.*$', 'm');
  source = line.test(source) ? source.replace(line, key + ': ' + value) : source.replace(/^---\n/, '---\n' + key + ': ' + value + '\n');
  source = source.replace(/^updatedAt:.*$/m, 'updatedAt: ' + new Date().toISOString());
  state.projectDocRaw = source;
  const src = el('projectDocSource');
  if (src) src.value = source;
  scheduleProjectDocSave();
  if (!state.projectDocEditing) renderProjectDocPreview(source);
}
function downloadBase64File(fileName, mediaType, contentBase64) {
  const bytes = Uint8Array.from(atob(contentBase64), char => char.charCodeAt(0));
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
async function exportDesign(format) {
  setProjectDocStatus('Exporting…', '');
  try {
    const res = await api('/api/design/export/' + format, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: getProjectDocContent(), sourceUrl: location.href }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Export failed');
    downloadBase64File(data.fileName, data.mediaType, data.contentBase64);
    setProjectDocStatus(format.toUpperCase() + ' exported', '');
  } catch (error) { setProjectDocStatus(error.message || 'Export failed', 'error'); }
}
function bytesToBase64(bytes) {
  let binary = '';
  const stride = 0x8000;
  for (let start = 0; start < bytes.length; start += stride) {
    binary += String.fromCharCode.apply(null, bytes.subarray(start, start + stride));
  }
  return btoa(binary);
}
async function importDesignFile(file) {
  if (!file) return;
  setProjectDocStatus('Inspecting import…', '');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const contentBase64 = bytesToBase64(bytes);
    const res = await api('/api/design/import/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, contentBase64 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed');
    if (data.kind === 'hadamard-workspace-bundle' && Array.isArray(data.changes)) {
      const modal = modalShell('Import Design bundle');
      const hint = document.createElement('p'); hint.className = 'muted';
      hint.textContent = 'Review every file before writing to .hadamard/design. Files not included in the bundle are preserved.';
      const list = document.createElement('div'); list.className = 'design-change-list';
      for (const change of data.changes) {
        const row = document.createElement('div'); row.className = 'design-change-row'; row.dataset.action = change.action;
        const action = document.createElement('span'); action.className = 'design-change-action'; action.textContent = change.action;
        const name = document.createElement('code'); name.textContent = change.path;
        row.append(action, name); list.appendChild(row);
      }
      const actions = document.createElement('div'); actions.className = 'modal-actions';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary-btn'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', modal.close);
      const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'primary-btn'; apply.textContent = 'Import bundle';
      apply.addEventListener('click', async () => {
        apply.disabled = true;
        const commit = await api('/api/design/import/commit', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName: file.name, contentBase64, expectedChanges: data.changes, confirmed: true }),
        });
        const committed = await commit.json().catch(() => ({}));
        if (!commit.ok) { apply.disabled = false; return setProjectDocStatus(committed.error || 'Import commit failed', 'error'); }
        modal.close(); state.projectDocLoadedFor = null; await mountProjectDoc(true);
        setProjectDocStatus('Design bundle imported', '');
      });
      actions.append(cancel, apply); modal.content.append(hint, list); modal.panel.appendChild(actions);
      return;
    }
    if (!data.editable || typeof data.markdown !== 'string') {
      if (!confirm((data.warnings || ['Read-only reference']).join(' ') + '\n\nAttach this immutable reference to the Design project?')) return;
      const attach = await api('/api/design/import/reference', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentBase64, confirmed: true }),
      });
      const attached = await attach.json();
      if (!attach.ok) throw new Error(attached.error || 'Reference attachment failed');
      setProjectDocStatus('Reference attached · ' + attached.artifact.id.slice(0, 20), '');
      return;
    }
    if (state.projectDocDirty) await saveProjectDocNow();
    const choice = prompt(
      'Validated ' + data.kind + ' import. Choose: new (new local identity), replace, or merge.',
      data.kind === 'hadamard-package' ? 'new' : 'merge',
    );
    const action = choice === 'new' ? 'new-copy' : choice === 'replace' ? 'replace-current' : choice === 'merge' ? 'merge-sections' : '';
    if (!action || !confirm('Commit import action "' + action + '"? The current revision will be checked first.')) return;
    const commit = await api('/api/design/import/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, contentBase64, action, expectedRevision: state.projectDocRevision, confirmed: true }),
    });
    const committed = await commit.json();
    if (!commit.ok) throw new Error(committed.error || 'Import commit failed');
    state.projectDocLoadedFor = null;
    await mountProjectDoc(true);
    setProjectDocStatus('Imported as ' + action, '');
  } catch (error) { setProjectDocStatus(error.message || 'Import failed', 'error'); }
}
function modalShell(title) {
  const overlay = document.createElement('div'); overlay.className = 'modal'; overlay.classList.remove('hidden');
  const panel = document.createElement('div'); panel.className = 'modal-panel auto-dialog design-modal';
  const heading = document.createElement('h2'); heading.textContent = title;
  const content = document.createElement('div'); content.className = 'design-modal-content';
  panel.append(heading, content); overlay.appendChild(panel); document.body.appendChild(overlay);
  return { overlay, panel, content, close: () => overlay.remove() };
}
async function previewEngineeringProfile() {
  const profileId = el('projectDocProfileSelect')?.value;
  if (!profileId) return;
  const res = await api('/api/design/engineering-profile/preview', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId }),
  });
  const proposal = await res.json();
  if (!res.ok) return setProjectDocStatus(proposal.error || 'Profile preview failed', 'error');
  const auditRes = await api('/api/design/engineering-profile/audit', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId }),
  });
  const audit = auditRes.ok ? await auditRes.json() : null;
  const modal = modalShell('Engineering Profile diff');
  if (audit) {
    const drift = document.createElement('p');
    drift.textContent = 'Drift · expressed but not fully enforced: ' + (audit.expressedNotExecuted.join(', ') || 'none')
      + ' · enforced but missing from Design: ' + (audit.executedNotDesigned.join(', ') || 'none');
    modal.content.appendChild(drift);
  }
  const choices = [];
  for (const target of ['design', 'agents', 'policy', 'validators']) {
    const candidate = proposal.diffs[target];
    const details = document.createElement('details'); details.open = target === 'design';
    const summary = document.createElement('summary');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = candidate.changed; checkbox.disabled = !candidate.changed;
    const label = document.createTextNode(' ' + target + (candidate.changed ? ' · change' : ' · no change'));
    summary.append(checkbox, label); const pre = document.createElement('pre'); pre.textContent = '--- before\n' + candidate.before + '\n+++ after\n' + candidate.after;
    details.append(summary, pre); modal.content.appendChild(details); choices.push({ target, checkbox });
  }
  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const cancel = document.createElement('button'); cancel.className = 'secondary-btn'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', modal.close);
  const apply = document.createElement('button'); apply.className = 'primary-btn'; apply.textContent = 'Confirm selected changes';
  apply.addEventListener('click', async () => {
    if (!confirm('Apply only the selected independent patches? This never raises permissions automatically.')) return;
    const result = await api('/api/design/engineering-profile/apply', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId, proposalId: proposal.proposalId,
        targets: choices.filter(item => item.checkbox.checked).map(item => item.target), confirmed: true }),
    });
    const data = await result.json();
    if (!result.ok) return setProjectDocStatus(data.error || 'Profile apply failed', 'error');
    modal.close(); state.projectDocLoadedFor = null; await mountProjectDoc(true);
    setProjectDocStatus('Engineering Profile applied: ' + data.applied.join(', '), '');
  });
  actions.append(cancel, apply); modal.panel.appendChild(actions);
}
function applyDesignDocumentState(designData) {
  state.projectDocRevision = designData.revision || null;
  state.projectDocTemplates = Array.isArray(designData.templates) ? designData.templates : [];
  state.projectDocConfiguration = designData.configuration || null;
  state.projectDocProfiles = Array.isArray(designData.profiles) ? designData.profiles : [];
  const templateSelect = el('projectDocTemplateSelect');
  if (templateSelect) {
    templateSelect.textContent = '';
    for (const template of state.projectDocTemplates) {
      const option = document.createElement('option');
      option.value = template.id; option.textContent = template.name; templateSelect.appendChild(option);
    }
    templateSelect.value = designData.parsed?.frontmatter?.template || 'software.general';
  }
  const themeSelect = el('projectDocThemeSelect');
  if (themeSelect) themeSelect.value = designData.parsed?.frontmatter?.theme || 'clean-light';
  const profileSelect = el('projectDocProfileSelect');
  if (profileSelect) {
    profileSelect.textContent = '';
    for (const profile of state.projectDocProfiles) {
      const option = document.createElement('option'); option.value = profile.id; option.textContent = 'Profile · ' + profile.name; profileSelect.appendChild(option);
    }
    profileSelect.value = designData.configuration?.template?.id || designData.parsed?.frontmatter?.template || 'software.general';
  }
}
function designIconButton(id, icon, title, action) {
  const control = document.createElement('button');
  control.type = 'button';
  control.id = id;
  control.className = 'icon-btn project-doc-command-icon';
  control.innerHTML = guiIcon(icon);
  control.title = title;
  control.setAttribute('aria-label', title);
  control.addEventListener('click', action);
  return control;
}
function setDesignEntryMode(mode) {
  const next = mode === 'html' ? 'html' : 'markdown';
  if (state.designEntryMode === next) return;
  if (state.projectDocDirty) void saveProjectDocNow();
  state.designEntryMode = next;
  state.projectDocLoadedFor = null;
  state.projectDocEditing = false;
  void mountProjectDoc(true);
}
function openDesignExportDialog() {
  const modal = modalShell('Export Design');
  const hint = document.createElement('p');
  hint.className = 'muted';
  hint.textContent = 'Choose one export artifact. Package is the lossless format for importing into Hadamard.';
  modal.content.appendChild(hint);
  const actions = document.createElement('div'); actions.className = 'design-export-options';
  for (const item of [['package', 'Design package', 'Lossless bundle for sharing and re-import'], ['html', 'HTML', 'Portable human-readable page'], ['pdf', 'PDF', 'Fixed-layout document']]) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'design-export-option';
    button.innerHTML = '<strong>' + item[1] + '</strong><span>' + item[2] + '</span>';
    button.addEventListener('click', () => { modal.close(); void exportDesign(item[0]); });
    actions.appendChild(button);
  }
  modal.content.appendChild(actions);
  modal.overlay.addEventListener('click', event => { if (event.target === modal.overlay) modal.close(); });
}
async function openDesignTemplateCenter() {
  const modal = modalShell('Design templates');
  modal.panel.classList.add('design-template-center');
  const toolbar = document.createElement('div'); toolbar.className = 'design-template-toolbar';
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search templates'; search.setAttribute('aria-label', 'Search Design templates');
  const category = document.createElement('select'); category.setAttribute('aria-label', 'Template category');
  const all = document.createElement('option'); all.value = ''; all.textContent = 'All categories'; category.appendChild(all);
  const categories = [...new Set((state.projectDocTemplates || []).map(item => item.category).filter(Boolean))];
  for (const value of categories) { const option = document.createElement('option'); option.value = value; option.textContent = value; category.appendChild(option); }
  toolbar.append(search, category);
  const layout = document.createElement('div'); layout.className = 'design-template-layout';
  const grid = document.createElement('div'); grid.className = 'design-template-grid';
  const preview = document.createElement('section'); preview.className = 'design-template-detail';
  const previewFrame = document.createElement('iframe'); previewFrame.className = 'design-template-frame'; previewFrame.setAttribute('sandbox', ''); previewFrame.title = 'Template preview';
  const previewMeta = document.createElement('div'); previewMeta.className = 'design-template-meta';
  preview.append(previewFrame, previewMeta);
  let activeId = '';
  async function selectTemplate(template) {
    activeId = template.id;
    grid.querySelectorAll('.design-template-card').forEach(card => card.classList.toggle('active', card.dataset.id === activeId));
    previewMeta.textContent = 'Loading preview...';
    const response = await api('/api/design/template/preview?id=' + encodeURIComponent(template.id));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { previewMeta.textContent = data.error || 'Preview failed'; return; }
    previewFrame.srcdoc = data.html || '';
    previewMeta.textContent = '';
    const heading = document.createElement('div'); heading.innerHTML = '<strong></strong><span></span>';
    heading.querySelector('strong').textContent = data.template.name;
    heading.querySelector('span').textContent = data.template.description;
    const changes = document.createElement('div'); changes.className = 'design-change-list compact';
    for (const change of data.changes || []) {
      const row = document.createElement('div'); row.className = 'design-change-row'; row.dataset.action = change.action;
      row.innerHTML = '<span class="design-change-action"></span><code></code>';
      row.querySelector('.design-change-action').textContent = change.action;
      row.querySelector('code').textContent = change.path;
      changes.appendChild(row);
    }
    const use = document.createElement('button'); use.type = 'button'; use.className = 'primary-btn'; use.textContent = 'Use template';
    use.addEventListener('click', async () => {
      use.disabled = true;
      const applied = await api('/api/design/template/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: template.id, expectedChanges: data.changes, confirmed: true }) });
      const result = await applied.json().catch(() => ({}));
      if (!applied.ok) { use.disabled = false; return setProjectDocStatus(result.error || 'Template apply failed', 'error'); }
      modal.close(); state.projectDocLoadedFor = null; state.designEntryMode = 'markdown'; await mountProjectDoc(true);
      setProjectDocStatus('Template applied: ' + template.name, '');
    });
    previewMeta.append(heading, changes, use);
  }
  function renderCards() {
    const query = search.value.trim().toLowerCase(); const selectedCategory = category.value;
    grid.textContent = '';
    const visible = (state.projectDocTemplates || []).filter(template => (!selectedCategory || template.category === selectedCategory)
      && (!query || (template.name + ' ' + template.description + ' ' + template.category).toLowerCase().includes(query)));
    for (const template of visible) {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'design-template-card';
    card.dataset.id = template.id;
    const image = document.createElement('img'); image.className = 'design-template-thumbnail'; image.src = template.thumbnail; image.alt = '';
    const title = document.createElement('strong'); title.textContent = template.name;
    const description = document.createElement('span'); description.textContent = template.description || '';
    const tags = document.createElement('small'); tags.textContent = template.category + ' · ' + (template.entries || []).join(' + ');
    card.append(image, title, description, tags);
    card.addEventListener('click', () => { void selectTemplate(template); });
    grid.appendChild(card);
    }
    if (visible.length && !visible.some(item => item.id === activeId)) void selectTemplate(visible[0]);
  }
  search.addEventListener('input', renderCards); category.addEventListener('change', renderCards);
  layout.append(grid, preview); modal.content.append(toolbar, layout); renderCards();
  modal.overlay.addEventListener('click', event => { if (event.target === modal.overlay) modal.close(); });
}
async function refreshDesignEntry() {
  if (state.projectDocDirty) {
    const choice = prompt('Unsaved document changes. Type save, discard, or cancel before refreshing.', 'save');
    if (choice === 'save') {
      await saveProjectDocNow();
      if (state.projectDocDirty) return;
    } else if (choice !== 'discard') return;
  }
  const response = await api('/api/design/refresh', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: state.designEntryMode }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return setProjectDocStatus(data.error || 'Refresh failed', 'error');
  state.projectDocLoadedFor = null;
  state.designPreviewStale = false;
  await mountProjectDoc(true);
  setProjectDocStatus('Refreshed', '');
}
async function openDesignFolder() {
  const response = await api('/api/design/open-folder', { method: 'POST' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) setProjectDocStatus(data.error || 'Could not open Design folder', 'error');
}
async function openDesignHtmlInFiles() {
  ensureAuxVisible();
  state.auxView = 'files';
  el('auxLauncher')?.classList.add('hidden');
  el('auxView')?.classList.remove('hidden');
  el('auxCloseBtn')?.classList.remove('hidden');
  const manifest = await api('/api/design').then(res => res.json());
  let target = manifest?.workspace?.entries?.html?.path;
  if (target && manifest?.workspace?.entries?.html?.exists !== true) {
    const created = await api('/api/design/entry', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'html', content: '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>Project Design</title>\n</head>\n<body>\n  <main>\n    <h1>Project Design</h1>\n  </main>\n</body>\n</html>\n' }),
    });
    const data = await created.json().catch(() => ({}));
    if (!created.ok) return setProjectDocStatus(data.error || 'Could not create design.html', 'error');
    target = data.entry?.path || target;
    state.projectDocRevision = data.entry?.revision || null;
  }
  if (target) await renderAuxFileEditor(target);
}
function createProjectDocumentActions() {
  const documentSelect = document.createElement('select'); documentSelect.id = 'projectDocumentSelect'; documentSelect.className = 'project-doc-command-select'; documentSelect.setAttribute('aria-label', 'Document');
  for (const item of [['design', 'DESIGN'], ['plans', 'PLAN'], ['memory', 'MEMORY'], ['rules', 'RULES']]) {
    const option = document.createElement('option'); option.value = item[0]; option.textContent = item[1]; option.selected = item[0] === state.projectDocSubTab; documentSelect.appendChild(option);
  }
  documentSelect.addEventListener('change', () => setProjectDocSubTab(documentSelect.value));
  const planSelect = document.createElement('select'); planSelect.id = 'projectDocPlanSelect'; planSelect.className = 'project-doc-plan-select hidden'; planSelect.setAttribute('aria-label', 'Plan file');
  planSelect.addEventListener('change', () => {
    if (state.projectDocDirty) void saveProjectDocNow();
    state.projectDocPlanPath = planSelect.value || null; state.projectDocLoadedFor = null; void mountProjectDoc(true);
  });
  const modeSelect = document.createElement('select'); modeSelect.id = 'projectDesignModeSelect'; modeSelect.className = 'project-doc-command-select design-only'; modeSelect.setAttribute('aria-label', 'Design source format');
  for (const mode of [['markdown', 'Markdown'], ['html', 'HTML']]) { const option = document.createElement('option'); option.value = mode[0]; option.textContent = mode[1]; option.selected = state.designEntryMode === mode[0]; modeSelect.appendChild(option); }
  modeSelect.addEventListener('change', () => setDesignEntryMode(modeSelect.value));
  const importInput = document.createElement('input'); importInput.type = 'file'; importInput.id = 'projectDocImportInput'; importInput.className = 'hidden'; importInput.accept = '.hadamard-design.zip,.zip,.md,.html,.htm,.pdf,text/markdown,text/html,application/pdf';
  importInput.addEventListener('change', () => { void importDesignFile(importInput.files?.[0]); importInput.value = ''; });
  const templateButton = designIconButton('projectDocTemplateBtn', 'list', 'Templates', openDesignTemplateCenter);
  const importButton = designIconButton('projectDocImportBtn', 'plus', 'Import', () => importInput.click());
  const exportButton = designIconButton('projectDocExportBtn', 'drive', 'Export', openDesignExportDialog);
  const profileButton = designIconButton('projectDocProfileBtn', 'git', 'Engineering profile diff', () => void previewEngineeringProfile());
  const folderButton = designIconButton('projectDocFolderBtn', 'folder', 'Open Design folder', () => void openDesignFolder());
  const refreshButton = designIconButton('projectDocRefreshBtn', 'refresh', 'Refresh from disk', () => void refreshDesignEntry());
  const editButton = designIconButton('projectDocEditBtn', 'edit', 'Edit', () => toggleProjectDocEdit()); editButton.classList.add('project-doc-edit-btn');
  const documentStatus = document.createElement('span'); documentStatus.id = 'projectDocStatus'; documentStatus.className = 'project-doc-status';
  for (const control of [templateButton, importButton, exportButton, profileButton, folderButton, refreshButton]) control.classList.add('design-only');
  const left = document.createElement('div'); left.className = 'project-doc-command-left'; left.append(documentSelect, modeSelect, planSelect);
  const right = document.createElement('div'); right.className = 'project-doc-command-right'; right.id = 'projectDocDesignControls'; right.append(templateButton, importButton, exportButton, profileButton, folderButton, refreshButton, editButton, documentStatus);
  return [left, right, importInput];
}
`;
