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
async function migrateLegacyDesign(action) {
  try {
    const res = await api('/api/design/migrate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Migration failed');
    state.projectDocLoadedFor = null;
    await mountProjectDoc(true);
  } catch (error) { setProjectDocStatus(error.message || 'Migration failed', 'error'); }
}
function applyDesignDocumentState(designData) {
  state.projectDocRevision = designData.revision || null;
  state.projectDocMigrationState = designData.state || 'empty';
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
  const migration = el('projectDocMigration');
  if (!migration) return;
  migration.textContent = '';
  migration.classList.toggle('hidden', designData.state !== 'legacy-progress' && designData.state !== 'conflict');
  if (designData.state !== 'legacy-progress' && designData.state !== 'conflict') return;
  const message = document.createElement('span');
  message.textContent = designData.state === 'legacy-progress'
    ? 'Legacy PROGRESS.md is shown as a read-only migration preview.'
    : 'DESIGN.md and legacy PROGRESS.md both exist. No file has been overwritten.';
  const migrate = document.createElement('button');
  migrate.type = 'button'; migrate.className = 'secondary-btn';
  migrate.textContent = designData.state === 'legacy-progress' ? 'Migrate to DESIGN.md' : 'Merge under History';
  migrate.addEventListener('click', () => void migrateLegacyDesign(designData.state === 'legacy-progress' ? 'migrate-legacy' : 'merge-history'));
  migration.append(message, migrate);
  if (designData.state !== 'conflict') return;
  const keep = document.createElement('button');
  keep.type = 'button'; keep.className = 'secondary-btn'; keep.textContent = 'Keep DESIGN.md';
  keep.addEventListener('click', () => void migrateLegacyDesign('keep-design'));
  const replace = document.createElement('button');
  replace.type = 'button'; replace.className = 'secondary-btn'; replace.textContent = 'Use legacy';
  replace.addEventListener('click', () => {
    if (confirm('Replace DESIGN.md with legacy PROGRESS.md after creating a backup?')) void migrateLegacyDesign('replace-with-legacy');
  });
  const details = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = 'Compare';
  const comparison = document.createElement('pre');
  comparison.textContent = '--- DESIGN.md ---\n' + (designData.designContent || '')
    + '\n--- legacy PROGRESS.md ---\n' + (designData.legacyProgressContent || '');
  details.append(summary, comparison);
  migration.append(keep, replace, details);
}
function createProjectDocumentActions() {
  const statusWrap = document.createElement('div'); statusWrap.className = 'project-doc-status-wrap';
  const statusLabel = document.createElement('label'); statusLabel.htmlFor = 'projectStatusSelect'; statusLabel.textContent = '状态';
  const statusSelect = document.createElement('select'); statusSelect.id = 'projectStatusSelect'; statusSelect.className = 'project-status-select'; statusSelect.setAttribute('aria-label', 'Project status');
  const currentStatus = projectStatusOf(state.snapshot?.projects?.find((project) => project.active) || { status: 'not_started' });
  for (const value of PROJECT_STATUSES) {
    const option = document.createElement('option'); option.value = value; option.textContent = PROJECT_STATUS_LABELS[value]; option.selected = value === currentStatus; statusSelect.appendChild(option);
  }
  statusSelect.addEventListener('change', () => void saveProjectStatus(statusSelect.value)); statusWrap.append(statusLabel, statusSelect);
  const planSelect = document.createElement('select'); planSelect.id = 'projectDocPlanSelect'; planSelect.className = 'project-doc-plan-select hidden'; planSelect.setAttribute('aria-label', 'Plan file');
  planSelect.addEventListener('change', () => {
    if (state.projectDocDirty) void saveProjectDocNow();
    state.projectDocPlanPath = planSelect.value || null; state.projectDocLoadedFor = null; void mountProjectDoc(true);
  });
  const templateSelect = document.createElement('select'); templateSelect.id = 'projectDocTemplateSelect'; templateSelect.className = 'project-doc-plan-select'; templateSelect.setAttribute('aria-label', 'Design template');
  templateSelect.addEventListener('change', () => appendMissingTemplateSections(templateSelect.value));
  const themeSelect = document.createElement('select'); themeSelect.id = 'projectDocThemeSelect'; themeSelect.className = 'project-doc-plan-select'; themeSelect.setAttribute('aria-label', 'Design theme');
  for (const theme of [['clean-light', 'Light'], ['clean-dark', 'Dark']]) {
    const option = document.createElement('option'); option.value = theme[0]; option.textContent = theme[1]; themeSelect.appendChild(option);
  }
  themeSelect.addEventListener('change', () => updateDesignFrontmatter('theme', themeSelect.value));
  const profileSelect = document.createElement('select'); profileSelect.id = 'projectDocProfileSelect'; profileSelect.className = 'project-doc-plan-select'; profileSelect.setAttribute('aria-label', 'Engineering Profile');
  for (const profile of state.projectDocProfiles || []) { const option = document.createElement('option'); option.value = profile.id; option.textContent = 'Profile · ' + profile.name; profileSelect.appendChild(option); }
  const importInput = document.createElement('input'); importInput.type = 'file'; importInput.id = 'projectDocImportInput'; importInput.className = 'hidden'; importInput.accept = '.hadamard-design.zip,.zip,.md,.html,.htm,.pdf,text/markdown,text/html,application/pdf';
  importInput.addEventListener('change', () => { void importDesignFile(importInput.files?.[0]); importInput.value = ''; });
  const button = (id, label, action) => {
    const control = document.createElement('button'); control.type = 'button'; control.id = id; control.className = 'pill-btn'; control.textContent = label; control.addEventListener('click', action); return control;
  };
  const importButton = button('projectDocImportBtn', 'Import', () => importInput.click());
  const packageButton = button('projectDocExportPackageBtn', 'Export package', () => void exportDesign('package'));
  const htmlButton = button('projectDocExportBtn', 'Export HTML', () => void exportDesign('html'));
  const pdfButton = button('projectDocExportPdfBtn', 'Export PDF', () => void exportDesign('pdf'));
  const customizeButton = button('projectDocCustomizeBtn', 'Customize', () => openDesignCustomization());
  const profileButton = button('projectDocProfileBtn', 'Profile diff', () => void previewEngineeringProfile());
  const shareButton = button('projectDocShareBtn', 'Share snapshot', () => void shareDesignSnapshot()); shareButton.title = 'Create an immutable three-format share snapshot';
  const revokeButton = button('projectDocRevokeShareBtn', 'Revoke share', () => void revokeDesignShare());
  const editButton = button('projectDocEditBtn', 'Edit', () => toggleProjectDocEdit()); editButton.classList.add('project-doc-edit-btn');
  const documentStatus = document.createElement('span'); documentStatus.id = 'projectDocStatus'; documentStatus.className = 'project-doc-status';
  return [statusWrap, planSelect, templateSelect, themeSelect, profileSelect, importInput, importButton, packageButton, htmlButton, pdfButton,
    customizeButton, profileButton, shareButton, revokeButton, editButton, documentStatus];
}
`;
