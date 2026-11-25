import { getLanguage, setLanguage, translatePhrase } from './i18n.js';
import { openSettingsDialog } from './settingsDialog.js';
import { esc } from './utils.js';

export interface ProjectHubDesktopBridge {
  openProject?(projectPath?: string): Promise<unknown>;
  chooseProject?(): Promise<unknown>;
  listProjects?(): Promise<Array<{ id: string; name: string; projectPath: string; workspacePath: string; runningUrl: string | null; workspaceExists: boolean }>>;
  getDataRoot?(): Promise<{ dataRoot: string; settingsPath: string }>;
  chooseDataRoot?(): Promise<{ dataRoot: string; migrated: boolean; existingData: boolean; restartRequired: boolean } | null>;
  chooseRuntimePath?(kind: 'python' | 'octave' | 'cpp'): Promise<string | null>;
  restartApp?(): Promise<boolean>;
}

export interface ProjectHubDeps {
  request<T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T>;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
  openModal(html: string): void;
  closeModal(): void;
  copyText(text: string, successMessage?: string): Promise<void>;
  renderAll(): void;
  desktop(): ProjectHubDesktopBridge | undefined;
}

export interface ProjectHubController {
  openProjectHub(): Promise<void>;
  closeProjectHub(): void;
  renderProjectHub(): Promise<void>;
  revealProjectFolder(projectPath?: string, kind?: 'project' | 'workspace' | 'documents'): Promise<void>;
  changeAppLanguage(language: 'en' | 'zh'): Promise<void>;
  changeHubDataRoot(): Promise<void>;
  openSettings(): Promise<void>;
  openWorkspaceModal(): Promise<void>;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error('Missing element #' + id);
  return element as T;
}

function qs<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

/** Project hub / workspace modal (extracted from main.ts). */
export function createProjectHub(deps: ProjectHubDeps): ProjectHubController {
  const closeProjectHub = (): void => {
    byId('projectHub').classList.add('hidden');
  };

  const revealProjectFolder = async (projectPath?: string, kind: 'project' | 'workspace' | 'documents' = 'project'): Promise<void> => {
    try {
      const result = await deps.request<{ ok: boolean; path: string }>('/api/projects/reveal', { method: 'POST', body: JSON.stringify({ projectPath: projectPath || '', kind }) });
      deps.toast('Opened folder: ' + result.path, 'success');
    } catch (error) {
      deps.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const renderProjectHub = async (): Promise<void> => {
    const grid = byId<HTMLElement>('hubProjectGrid');
    const languageSelect = qs<HTMLSelectElement>('#hubLanguageSelect');
    if (languageSelect) languageSelect.value = getLanguage();
    const dataRootRow = document.querySelector<HTMLElement>('.hub-data-root');
    const dataRootCode = qs<HTMLElement>('#hubDataRoot');
    const desktop = deps.desktop();
    if (desktop?.getDataRoot) {
      try {
        const info = await desktop.getDataRoot();
        if (dataRootCode) dataRootCode.textContent = info.dataRoot;
        if (dataRootRow) { dataRootRow.classList.remove('hidden'); dataRootRow.title = 'Default workspace and project registry. Settings: ' + info.settingsPath; }
      } catch { dataRootRow?.classList.add('hidden'); }
    } else dataRootRow?.classList.add('hidden');
    const current = await deps.request<{ current: { workspace: string; project?: string | null }; projects: Array<{ id: string; name: string; projectPath: string; workspacePath: string; runningUrl: string | null; workspaceExists: boolean }> }>('/api/projects').catch(() => null);
    if (!current) { grid.innerHTML = '<p class="empty-state">Could not read the project registry.</p>'; return; }
    let projects = current.projects;
    if (desktop) {
      try {
        const nativeProjects = await desktop.listProjects?.();
        if (nativeProjects?.length) projects = nativeProjects.map(project => ({ ...project, workspaceExists: project.workspaceExists, runningUrl: project.runningUrl }));
      } catch { /* use server registry */ }
    }
    byId('hubCurrentWorkspace').textContent = translatePhrase('Current workspace:') + ' ' + current.current.workspace;
    if (!projects.length) {
      grid.innerHTML = '<div class="hub-empty"><h2>No projects yet</h2><p>Create a project from a folder. hcanvas will initialize <code>.hcanvas/</code> inside it and keep all data there.</p><button id="hubEmptyNewBtn" class="btn primary">Choose a project folder…</button></div>';
      qs<HTMLButtonElement>('#hubEmptyNewBtn')?.addEventListener('click', () => { if (deps.desktop()) void deps.desktop()?.chooseProject?.(); else deps.toast('Browser mode: run hcanvas app --project <folder>.', 'info'); });
      return;
    }
    grid.innerHTML = projects.map(project => {
      const active = current.current.project === project.projectPath;
      const running = Boolean(project.runningUrl);
      const action = active ? 'Return to this canvas →' : desktop ? 'Open in new window ↗' : running ? 'Open in new tab ↗' : 'Not running';
      return '<article class="hub-card' + (active ? ' current' : '') + '" role="button" tabindex="0" data-hub-project="' + esc(project.projectPath) + '">' +
        '<div class="hub-card-top"><strong>' + esc(project.name) + '</strong><span class="hub-badge ' + (active ? 'current' : running ? 'running' : 'idle') + '">' + (active ? 'current' : running ? 'running' : 'closed') + '</span></div>' +
        '<small class="hub-card-path">' + esc(project.projectPath) + '</small>' +
        '<small class="hub-card-workspace">' + esc(project.workspacePath) + '</small>' +
        '<div class="hub-card-actions"><span class="hub-card-action">' + action + '</span><button type="button" class="hub-folder-btn" data-hub-folder="' + esc(project.projectPath) + '" title="Open project folder">📁 Open folder</button></div></article>';
    }).join('');
    grid.querySelectorAll<HTMLElement>('[data-hub-project]').forEach(card => {
      const openProject = (): void => {
        const projectPath = card.dataset.hubProject!;
        if (current.current.project === projectPath) { closeProjectHub(); return; }
        if (deps.desktop()) { void deps.desktop()?.openProject?.(projectPath); return; }
        const record = projects.find(project => project.projectPath === projectPath);
        if (record?.runningUrl) window.open(record.runningUrl, '_blank', 'noopener');
        else deps.toast('Project is not running. Start it with: hcanvas app --project ' + projectPath, 'info');
      };
      card.addEventListener('click', openProject);
      card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openProject(); } });
    });
    grid.querySelectorAll<HTMLButtonElement>('[data-hub-folder]').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation();
      void revealProjectFolder(button.dataset.hubFolder!);
    }));
  };

  const openProjectHub = async (): Promise<void> => {
    const settingsButton = document.getElementById('hubSettingsBtn');
    if (settingsButton) settingsButton.onclick = () => { void openSettings(); };
    byId('projectHub').classList.remove('hidden');
    await renderProjectHub();
  };

  const changeAppLanguage = async (language: 'en' | 'zh'): Promise<void> => {
    try {
      await deps.request('/api/settings/language', { method: 'POST', body: JSON.stringify({ language }) });
      setLanguage(language);
      deps.renderAll();
      await renderProjectHub();
      deps.toast(language === 'zh' ? '语言已切换为中文' : 'Language set to English', 'success');
    } catch (error) {
      deps.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const changeHubDataRoot = async (): Promise<void> => {
    const bridge = deps.desktop();
    if (!bridge?.chooseDataRoot) { deps.toast('Data location can be changed in the desktop app.', 'info'); return; }
    try {
      const result = await bridge.chooseDataRoot();
      if (!result) return;
      await renderProjectHub();
      const copied = result.migrated ? 'Existing data was copied to the new location. ' : result.existingData ? 'Existing Hcanvas data was found there. ' : '';
      const restart = result.restartRequired ? 'Restart Hadamard Canvas to use the new location for this window.' : '';
      const html = '<div class="modal small"><div class="modal-head"><div><strong>Data location changed</strong><small>Stored in the app profile, outside the install directory.</small></div><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="field"><span>New data location</span><input readonly value="' + esc(result.dataRoot) + '"></div><p class="hint-card">' + esc(copied + restart) + '</p><p class="history-restore-note">The previous location is left untouched as a safety copy.</p></div><div class="modal-foot"><button class="btn" data-close>Later</button><button id="restartForDataRootBtn" class="btn primary">Restart now</button></div></div>';
      deps.openModal(html);
      qs<HTMLButtonElement>('#restartForDataRootBtn')?.addEventListener('click', () => { void bridge.restartApp?.(); });
      deps.toast('Data location updated.', 'success');
    } catch (error) {
      deps.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const openSettings = async (): Promise<void> => {
    await openSettingsDialog({
      request: deps.request,
      toast: deps.toast,
      openModal: deps.openModal,
      closeModal: deps.closeModal,
      desktop: deps.desktop,
      applyLanguage: language => { setLanguage(language); deps.renderAll(); },
    });
  };

  const openWorkspaceModal = async (): Promise<void> => {
    try {
      const info = await deps.request<{ workspace: string; project?: string | null; guidePath: string; guide: string }>('/api/workspace');
      const canOpen = Boolean(deps.desktop());
      const html = '<div class="modal"><div class="modal-head"><div><strong>Workspace</strong><small>All hcanvas content lives in this directory.</small></div><button class="icon-btn" data-close>×</button></div><div class="modal-body">' +
        '<div class="field"><span>Workspace</span><input readonly value="' + esc(info.workspace) + '"></div>' +
        (info.project ? '<div class="field"><span>Project</span><input readonly value="' + esc(info.project) + '"></div>' : '') +
        '<div class="field"><span>CLI guide</span><input readonly value="' + esc(info.guidePath) + '"></div>' +
        '<div class="hint-card">Start another app on a project folder:<br><br><code>hcanvas app --project /path/to/project</code><br><br>The project gets a <code>.hcanvas/</code> directory with docs, state, masters, exports and CLI.md.</div>' +
        '<div class="workspace-guide">' + esc(info.guide) + '</div>' +
        '</div><div class="modal-foot"><button id="revealWorkspaceFolderBtn" class="btn">Open project folder</button>' + (canOpen ? '<button id="workspaceOpenProjectBtn" class="btn">Open Project…</button>' : '') + '<button id="copyWorkspaceGuideBtn" class="btn">Copy CLI guide</button><button class="btn" data-close>Close</button></div></div>';
      deps.openModal(html);
      qs<HTMLButtonElement>('#copyWorkspaceGuideBtn')?.addEventListener('click', () => { void deps.copyText(info.guide); });
      qs<HTMLButtonElement>('#revealWorkspaceFolderBtn')?.addEventListener('click', () => { void revealProjectFolder(info.project || undefined); });
      qs<HTMLButtonElement>('#workspaceOpenProjectBtn')?.addEventListener('click', () => { if (deps.desktop()) void deps.desktop()?.chooseProject?.(); });
    } catch (error) { deps.toast(error instanceof Error ? error.message : String(error), 'error'); }
  };

  return { openProjectHub, closeProjectHub, renderProjectHub, revealProjectFolder, changeAppLanguage, changeHubDataRoot, openSettings, openWorkspaceModal };
}
