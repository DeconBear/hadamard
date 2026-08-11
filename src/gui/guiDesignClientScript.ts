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
    if (typeof data.bodyHtml === 'string') view.innerHTML = data.bodyHtml;
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
async function exportDesignHtml() {
  setProjectDocStatus('Exporting…', '');
  try {
    const res = await api('/api/design/export/html', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: getProjectDocContent() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Export failed');
    downloadBase64File(data.fileName, data.mediaType, data.contentBase64);
    setProjectDocStatus('HTML exported', '');
  } catch (error) { setProjectDocStatus(error.message || 'Export failed', 'error'); }
}
async function importDesignFile(file) {
  if (!file) return;
  setProjectDocStatus('Inspecting import…', '');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const res = await api('/api/design/import/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, contentBase64: btoa(binary) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed');
    if (!data.editable || typeof data.markdown !== 'string') {
      setProjectDocStatus((data.warnings || ['Read-only reference']).join(' '), 'error');
      return;
    }
    if (!confirm('Replace the current Design with the validated imported document?')) return;
    state.projectDocRaw = data.markdown;
    const src = el('projectDocSource');
    if (src) src.value = data.markdown;
    scheduleProjectDocSave();
    renderProjectDocPreview(data.markdown);
  } catch (error) { setProjectDocStatus(error.message || 'Import failed', 'error'); }
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
  templateSelect.addEventListener('change', () => updateDesignFrontmatter('template', templateSelect.value));
  const themeSelect = document.createElement('select'); themeSelect.id = 'projectDocThemeSelect'; themeSelect.className = 'project-doc-plan-select'; themeSelect.setAttribute('aria-label', 'Design theme');
  for (const theme of [['clean-light', 'Light'], ['clean-dark', 'Dark']]) {
    const option = document.createElement('option'); option.value = theme[0]; option.textContent = theme[1]; themeSelect.appendChild(option);
  }
  themeSelect.addEventListener('change', () => updateDesignFrontmatter('theme', themeSelect.value));
  const importInput = document.createElement('input'); importInput.type = 'file'; importInput.id = 'projectDocImportInput'; importInput.className = 'hidden'; importInput.accept = '.md,.html,.htm,.pdf,text/markdown,text/html,application/pdf';
  importInput.addEventListener('change', () => { void importDesignFile(importInput.files?.[0]); importInput.value = ''; });
  const button = (id, label, action) => {
    const control = document.createElement('button'); control.type = 'button'; control.id = id; control.className = 'pill-btn'; control.textContent = label; control.addEventListener('click', action); return control;
  };
  const importButton = button('projectDocImportBtn', 'Import', () => importInput.click());
  const exportButton = button('projectDocExportBtn', 'Export HTML', () => void exportDesignHtml());
  const shareButton = button('projectDocShareBtn', 'Share snapshot', () => void exportDesignHtml()); shareButton.title = 'Export an immutable, self-contained HTML snapshot';
  const editButton = button('projectDocEditBtn', 'Edit', () => toggleProjectDocEdit()); editButton.classList.add('project-doc-edit-btn');
  const documentStatus = document.createElement('span'); documentStatus.id = 'projectDocStatus'; documentStatus.className = 'project-doc-status';
  return [statusWrap, planSelect, templateSelect, themeSelect, importInput, importButton, exportButton, shareButton, editButton, documentStatus];
}
`;
