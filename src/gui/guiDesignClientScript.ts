export const GUI_DESIGN_CLIENT_SCRIPT = String.raw`
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
async function shareDesignSnapshot() {
  try {
    if (state.projectDocDirty) await saveProjectDocNow();
    const hours = Number(prompt('Share expiry in hours (1–720)', '72') || '72');
    const res = await api('/api/design/share', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: state.projectDocRevision, expiresInHours: hours }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Share failed');
    state.projectDocShareToken = data.token;
    const absolute = location.origin + data.url;
    prompt('Immutable share snapshot created. Copy this URL:', absolute);
    setProjectDocStatus('Share snapshot created · expires ' + data.snapshot.expiresAt, '');
  } catch (error) { setProjectDocStatus(error.message || 'Share failed', 'error'); }
}
async function revokeDesignShare() {
  if (!state.projectDocShareToken || !confirm('Revoke the most recently created share token?')) return;
  const res = await api('/api/design/share/revoke', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: state.projectDocShareToken }),
  });
  const data = await res.json();
  if (!res.ok) return setProjectDocStatus(data.error || 'Revoke failed', 'error');
  state.projectDocShareToken = null;
  setProjectDocStatus('Share token revoked', '');
}
function appendMissingTemplateSections(templateId) {
  const selected = (state.projectDocTemplates || []).find(item => item.id === templateId);
  if (!selected || !Array.isArray(selected.sections)) return;
  let source = getProjectDocContent();
  const missing = selected.sections.filter(section => !new RegExp('^##\\s+' + section.title.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&') + '\\s*$', 'mi').test(source));
  if (missing.length && confirm('Add ' + missing.length + ' missing scaffold sections from ' + selected.name + '?')) {
    source = source.trimEnd() + '\n\n' + missing.map(section => '<!-- hadamard-section:' + section.id + ' -->\n## ' + section.title + '\n\n<!-- ' + section.prompt + ' -->\n').join('\n');
    state.projectDocRaw = source;
    const editor = el('projectDocSource'); if (editor) editor.value = source;
  }
  updateDesignFrontmatter('template', templateId);
}
function modalShell(title) {
  const overlay = document.createElement('div'); overlay.className = 'modal'; overlay.classList.remove('hidden');
  const panel = document.createElement('div'); panel.className = 'modal-panel auto-dialog design-modal';
  const heading = document.createElement('h2'); heading.textContent = title;
  const content = document.createElement('div'); content.className = 'design-modal-content';
  panel.append(heading, content); overlay.appendChild(panel); document.body.appendChild(overlay);
  return { overlay, panel, content, close: () => overlay.remove() };
}
function openDesignCustomization() {
  const modal = modalShell('Customize Design');
  const config = state.projectDocConfiguration || {};
  const tokens = config.theme?.tokens || {};
  const field = (label, value, type) => {
    const row = document.createElement('label'); row.className = 'settings-row';
    const caption = document.createElement('span'); caption.textContent = label;
    const input = document.createElement('input'); input.type = type || 'text'; input.value = value == null ? '' : String(value);
    row.append(caption, input); modal.content.appendChild(row); return input;
  };
  const accent = field('Accent color', tokens.accentColor || '#2563eb', 'color');
  const width = field('Page width', tokens.pageWidth || 920, 'number'); width.min = '560'; width.max = '1440';
  const header = field('Header', tokens.header || '');
  const footer = field('Footer', tokens.footer || '');
  const sectionTitle = document.createElement('h3'); sectionTitle.textContent = 'Sections'; modal.content.appendChild(sectionTitle);
  const template = (state.projectDocTemplates || []).find(item => item.id === config.template?.id);
  const sectionRows = [];
  for (const section of template?.sections || []) {
    const row = document.createElement('div'); row.className = 'design-section-row';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = !(config.sections?.hidden || []).includes(section.id);
    const textNode = document.createElement('span'); textNode.textContent = section.title;
    const up = document.createElement('button'); up.type = 'button'; up.className = 'secondary-btn'; up.textContent = '↑'; up.title = 'Move section up';
    const down = document.createElement('button'); down.type = 'button'; down.className = 'secondary-btn'; down.textContent = '↓'; down.title = 'Move section down';
    const record = { id: section.id, checkbox, row };
    up.addEventListener('click', () => {
      const index = sectionRows.indexOf(record); if (index <= 0) return;
      const previous = sectionRows[index - 1]; sectionRows[index - 1] = record; sectionRows[index] = previous;
      modal.content.insertBefore(row, previous.row);
    });
    down.addEventListener('click', () => {
      const index = sectionRows.indexOf(record); if (index < 0 || index >= sectionRows.length - 1) return;
      const next = sectionRows[index + 1]; sectionRows[index + 1] = record; sectionRows[index] = next;
      modal.content.insertBefore(next.row, row);
    });
    row.append(checkbox, textNode, up, down); modal.content.appendChild(row); sectionRows.push(record);
  }
  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const cancel = document.createElement('button'); cancel.className = 'secondary-btn'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', modal.close);
  const save = document.createElement('button'); save.className = 'primary-btn'; save.textContent = 'Save customization';
  save.addEventListener('click', async () => {
    const res = await api('/api/design/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: state.projectDocRevision, themeId: config.theme?.id,
        themeTokens: { ...tokens, accentColor: accent.value, pageWidth: Number(width.value), header: header.value, footer: footer.value },
        hiddenSections: sectionRows.filter(item => !item.checkbox.checked).map(item => item.id),
        sectionOrder: sectionRows.map(item => item.id) }),
    });
    const data = await res.json();
    if (!res.ok) return setProjectDocStatus(data.error || 'Customization failed', 'error');
    state.projectDocConfiguration = data.configuration; modal.close(); renderProjectDocPreview(getProjectDocContent());
  });
  actions.append(cancel, save); modal.panel.appendChild(actions);
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
function openDesignTemplateCenter() {
  const modal = modalShell('Design templates');
  const grid = document.createElement('div'); grid.className = 'design-template-grid';
  for (const template of state.projectDocTemplates || []) {
    const card = document.createElement('button'); card.type = 'button'; card.className = 'design-template-card';
    const preview = document.createElement('div'); preview.className = 'design-template-preview';
    preview.textContent = (template.sections || []).slice(0, 5).map(section => section.title).join('\n');
    const title = document.createElement('strong'); title.textContent = template.name;
    const description = document.createElement('span'); description.textContent = template.description || '';
    card.append(preview, title, description);
    card.addEventListener('click', () => { modal.close(); appendMissingTemplateSections(template.id); });
    grid.appendChild(card);
  }
  modal.content.appendChild(grid);
  modal.overlay.addEventListener('click', event => { if (event.target === modal.overlay) modal.close(); });
}
async function refreshDesignEntry() {
  if (state.projectDocDirty && !confirm('Discard unsaved document changes and reload from disk?')) return;
  const response = await api('/api/design/refresh', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: state.designEntryMode }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return setProjectDocStatus(data.error || 'Refresh failed', 'error');
  state.projectDocLoadedFor = null;
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
