import { getLanguage, setLanguage, translatePhrase } from './i18n.js';
import { openSettingsDialog, type DesktopUpdateState } from './settingsDialog.js';
import { esc } from './utils.js';

export interface ProjectHubDesktopBridge {
  openProject?(projectPath?: string): Promise<unknown>;
  chooseProject?(): Promise<unknown>;
  listProjects?(): Promise<Array<{ id: string; name: string; projectPath: string; workspacePath: string; runningUrl: string | null; workspaceExists: boolean }>>;
  getDataRoot?(): Promise<{ dataRoot: string; settingsPath: string }>;
  chooseDataRoot?(): Promise<{ dataRoot: string; migrated: boolean; existingData: boolean; restartRequired: boolean } | null>;
  chooseRuntimePath?(kind: 'python' | 'octave' | 'cpp'): Promise<string | null>;
  getUpdateState?(): Promise<DesktopUpdateState>;
  checkForUpdates?(): Promise<DesktopUpdateState>;
  downloadUpdate?(): Promise<DesktopUpdateState>;
  installUpdate?(): Promise<boolean>;
  openUpdateRelease?(url: string): Promise<boolean>;
  onUpdateState?(callback: (state: DesktopUpdateState) => void): () => void;
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
    const language = getLanguage();
    const zh = language === 'zh';
    const desktop = deps.desktop();
    const footNote = document.getElementById('hubFootNote');
    if (footNote) footNote.textContent = zh
      ? '运行中：项目服务正在运行；已关闭：项目已登记但当前没有运行。语言和数据位置在 Settings 中设置。'
      : 'Running: project server is active. Closed: project is registered but not running. Language and data location are configured in Settings.';
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
      const badgeLabel = active ? (zh ? '当前' : 'current') : running ? (zh ? '运行中' : 'running') : (zh ? '已关闭' : 'closed');
      const badgeTitle = active ? (zh ? '当前窗口正在显示此项目' : 'This project is open in the current window') : running ? (zh ? '此项目的本地服务正在运行' : 'The project server is running') : (zh ? '项目已登记，但当前没有运行' : 'Project is registered but not running');
      return '<article class="hub-card' + (active ? ' current' : '') + '" role="button" tabindex="0" data-hub-project="' + esc(project.projectPath) + '">' +
        '<div class="hub-card-top"><strong>' + esc(project.name) + '</strong><span class="hub-badge ' + (active ? 'current' : running ? 'running' : 'idle') + '" title="' + esc(badgeTitle) + '">' + esc(badgeLabel) + '</span></div>' +
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

  return { openProjectHub, closeProjectHub, renderProjectHub, revealProjectFolder, openSettings, openWorkspaceModal };
}
