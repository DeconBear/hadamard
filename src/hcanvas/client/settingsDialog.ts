import { getLanguage, setLanguage } from './i18n.js';
import { esc } from './utils.js';

export interface RuntimeProbe {
  kind: 'python' | 'octave' | 'cpp';
  ok: boolean;
  command: string;
  path?: string;
  version?: string;
  source: 'configured' | 'auto' | 'missing';
  error?: string;
}

export interface RuntimeSettings {
  python?: string;
  octave?: string;
  cpp?: string;
}

export interface SettingsPayload {
  dataRoot?: string;
  language?: 'en' | 'zh';
  runtimes?: RuntimeSettings;
  notebook?: { defaultKernel?: string; outputCacheBytes?: number };
  updates?: { autoCheck?: boolean; autoDownload?: boolean; channel?: 'stable' | 'preview' };
}

interface SettingsResponse {
  ok: boolean;
  settings: SettingsPayload;
  configPath: string;
}

interface RuntimeResponse {
  ok: boolean;
  runtimes: RuntimeProbe[];
}

export interface SettingsDialogDeps {
  request<T = Record<string, unknown>>(pathname: string, init?: RequestInit): Promise<T>;
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
  openModal(html: string): void;
  closeModal(): void;
  desktop(): {
    getDataRoot?(): Promise<{ dataRoot: string; settingsPath: string }>;
    chooseDataRoot?(): Promise<{ dataRoot: string; migrated: boolean; existingData: boolean; restartRequired: boolean } | null>;
    restartApp?(): Promise<boolean>;
    chooseRuntimePath?(kind: 'python' | 'octave' | 'cpp'): Promise<string | null>;
  } | undefined;
  applyLanguage(language: 'en' | 'zh'): void;
}

function badge(probe: RuntimeProbe): string {
  if (probe.ok) return '<span class="runtime-badge ok">' + esc(probe.version || 'ready') + '</span>';
  return '<span class="runtime-badge missing">' + esc(probe.error || 'not found') + '</span>';
}

function runtimeRow(kind: 'python' | 'octave' | 'cpp', label: string, hint: string, value: string, probe: RuntimeProbe | undefined): string {
  return '<div class="settings-row" data-runtime-row="' + kind + '">' +
    '<div class="settings-label"><strong>' + esc(label) + '</strong><small>' + esc(hint) + '</small>' + badge(probe || { kind, ok: false, command: '', source: 'missing', error: 'not checked' }) + '</div>' +
    '<div class="settings-input-group"><input id="settings-runtime-' + kind + '" data-runtime="' + kind + '" value="' + esc(value) + '" placeholder="Auto-detect from PATH" spellcheck="false">' +
    '<button type="button" class="btn tiny" data-browse-runtime="' + kind + '">Browse…</button>' +
    '<button type="button" class="btn tiny" data-test-runtime="' + kind + '">Test</button></div>' +
    '</div>';
}

export async function openSettingsDialog(deps: SettingsDialogDeps): Promise<void> {
  let settings: SettingsPayload = {};
  let probes: RuntimeProbe[] = [];
  let configPath = '';
  let detected: RuntimeResponse['runtimes'] = [];
  try {
    const [settingsResponse, runtimeResponse] = await Promise.all([
      deps.request<SettingsResponse>('/api/settings'),
      deps.request<RuntimeResponse>('/api/runtimes'),
    ]);
    settings = settingsResponse.settings || {};
    configPath = settingsResponse.configPath || '';
    probes = runtimeResponse.runtimes || [];
    detected = probes;
  } catch (error) {
    deps.toast(error instanceof Error ? error.message : String(error), 'error');
    return;
  }
  const dataRoot = await deps.desktop()?.getDataRoot?.().catch(() => null) || null;
  const runtimeValue = (kind: 'python' | 'octave' | 'cpp'): string => settings.runtimes?.[kind] || '';
  const probeFor = (kind: 'python' | 'octave' | 'cpp'): RuntimeProbe | undefined => probes.find(item => item.kind === kind);
  const language = settings.language || getLanguage();
  const defaultKernel = settings.notebook?.defaultKernel || 'python';
  const html = '<div class="modal settings-modal">' +
    '<div class="modal-head"><div><strong>Settings</strong><small>' + esc(configPath) + '</small></div><button class="icon-btn" data-close>×</button></div>' +
    '<div class="modal-body settings-body">' +
      '<section class="settings-section"><h3>General</h3>' +
        '<div class="settings-row"><div class="settings-label"><strong>Interface language</strong><small>Applies to the editor and project hub.</small></div><select id="settings-language"><option value="en"' + (language === 'en' ? ' selected' : '') + '>English</option><option value="zh"' + (language === 'zh' ? ' selected' : '') + '>中文</option></select></div>' +
        '<div class="settings-row"><div class="settings-label"><strong>Data location</strong><small>' + esc(dataRoot?.dataRoot || settings.dataRoot || 'Resolved from Hcanvas settings') + '</small></div><button type="button" class="btn tiny" id="settings-change-data-root">Change…</button></div>' +
      '</section>' +
      '<section class="settings-section"><h3>Language runtimes</h3><p class="settings-note">Leave empty to detect from PATH. Changes apply to new kernel sessions.</p>' +
        runtimeRow('python', 'Python', 'Interpreter used by the Python kernel.', runtimeValue('python'), probeFor('python')) +
        runtimeRow('octave', 'GNU Octave', 'Executable used by the Octave kernel.', runtimeValue('octave'), probeFor('octave')) +
        runtimeRow('cpp', 'C++ compiler', 'g++ or clang++ used by the C++ kernel.', runtimeValue('cpp'), probeFor('cpp')) +
        '<div class="settings-actions"><button type="button" class="btn tiny" id="settings-detect-all">Auto-detect all</button><span id="settings-runtime-status" class="settings-status"></span></div>' +
      '</section>' +
      '<section class="settings-section"><h3>Notebook</h3>' +
        '<div class="settings-row"><div class="settings-label"><strong>Default kernel</strong><small>Used for new Notebook pages when available.</small></div><select id="settings-default-kernel"><option value="python"' + (defaultKernel === 'python' ? ' selected' : '') + '>Python</option><option value="cpp"' + (defaultKernel === 'cpp' ? ' selected' : '') + '>C++</option><option value="octave"' + (defaultKernel === 'octave' ? ' selected' : '') + '>GNU Octave</option></select></div>' +
      '</section>' +
      '<section class="settings-section"><h3>Updates</h3>' +
        '<div class="settings-row"><div class="settings-label"><strong>Check for updates</strong><small>Check GitHub Releases when the desktop app starts.</small></div><input type="checkbox" id="settings-auto-check"' + (settings.updates?.autoCheck ? ' checked' : '') + '></div>' +
        '<div class="settings-row"><div class="settings-label"><strong>Download updates automatically</strong><small>Download in the background; installation still asks first.</small></div><input type="checkbox" id="settings-auto-download"' + (settings.updates?.autoDownload ? ' checked' : '') + '></div>' +
        '<div class="settings-row"><div class="settings-label"><strong>Channel</strong><small>Preview receives pre-release builds when available.</small></div><select id="settings-update-channel"><option value="stable"' + (settings.updates?.channel !== 'preview' ? ' selected' : '') + '>Stable</option><option value="preview"' + (settings.updates?.channel === 'preview' ? ' selected' : '') + '>Preview</option></select></div>' +
      '</section>' +
    '</div>' +
    '<div class="modal-foot"><span id="settings-save-status" class="settings-status"></span><button class="btn" data-close>Close</button><button id="settings-save" class="btn primary">Save settings</button></div>' +
  '</div>';
  deps.openModal(html);

  const status = (message: string, kind: 'info' | 'success' | 'error' = 'info'): void => {
    const target = document.getElementById('settings-save-status') || document.getElementById('settings-runtime-status');
    if (target) { target.textContent = message; target.className = 'settings-status ' + kind; }
  };
  const readRuntimeInputs = (): RuntimeSettings => {
    const result: RuntimeSettings = {};
    for (const kind of ['python', 'octave', 'cpp'] as const) {
      const input = document.getElementById('settings-runtime-' + kind) as HTMLInputElement | null;
      const value = input?.value.trim() || '';
      if (value) result[kind] = value;
    }
    return result;
  };
  const applyRuntimeBadge = (probe: RuntimeProbe): void => {
    const row = document.querySelector<HTMLElement>('[data-runtime-row="' + probe.kind + '"]');
    const target = row?.querySelector('.runtime-badge');
    if (!target) return;
    target.className = 'runtime-badge ' + (probe.ok ? 'ok' : 'missing');
    target.textContent = probe.ok ? (probe.version || 'ready') : (probe.error || 'not found');
    target.title = [probe.path, probe.command].filter(Boolean).join(' · ');
  };
  const testRuntime = async (kind: 'python' | 'octave' | 'cpp'): Promise<void> => {
    const input = document.getElementById('settings-runtime-' + kind) as HTMLInputElement | null;
    try {
      status('Testing ' + kind + '…');
      const result = await deps.request<{ ok: boolean; runtime: RuntimeProbe }>('/api/runtimes/test', { method: 'POST', body: JSON.stringify({ kind, path: input?.value.trim() || '' }) });
      applyRuntimeBadge(result.runtime);
      status(result.runtime.ok ? kind + ' is ready' : (result.runtime.error || kind + ' is unavailable'), result.runtime.ok ? 'success' : 'error');
    } catch (error) { status(error instanceof Error ? error.message : String(error), 'error'); }
  };
  document.querySelectorAll<HTMLButtonElement>('[data-test-runtime]').forEach(button => {
    button.addEventListener('click', () => { void testRuntime(button.dataset.testRuntime as 'python' | 'octave' | 'cpp'); });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-browse-runtime]').forEach(button => {
    button.addEventListener('click', async () => {
      const bridge = deps.desktop();
      if (!bridge?.chooseRuntimePath) { deps.toast('Use the manual path field in browser mode.', 'info'); return; }
      const selected = await bridge.chooseRuntimePath(button.dataset.browseRuntime as 'python' | 'octave' | 'cpp').catch(() => null);
      if (!selected) return;
      const input = document.getElementById('settings-runtime-' + button.dataset.browseRuntime) as HTMLInputElement | null;
      if (input) input.value = selected;
    });
  });
  document.getElementById('settings-detect-all')?.addEventListener('click', async () => {
    try {
      status('Detecting runtimes…');
      const result = await deps.request<RuntimeResponse>('/api/runtimes');
      probes = result.runtimes || [];
      for (const probe of probes) applyRuntimeBadge(probe);
      status('Detection complete', 'success');
    } catch (error) { status(error instanceof Error ? error.message : String(error), 'error'); }
  });
  document.getElementById('settings-change-data-root')?.addEventListener('click', async () => {
    const bridge = deps.desktop();
    if (!bridge?.chooseDataRoot) { deps.toast('Data location can be changed in the desktop app.', 'info'); return; }
    const result = await bridge.chooseDataRoot().catch(() => null);
    if (result) deps.toast(result.restartRequired ? 'Restart Hcanvas to use the new data location.' : 'Data location updated.', 'success');
  });
  document.getElementById('settings-save')?.addEventListener('click', async () => {
    const button = document.getElementById('settings-save') as HTMLButtonElement;
    button.disabled = true;
    try {
      const languageValue = (document.getElementById('settings-language') as HTMLSelectElement).value === 'zh' ? 'zh' : 'en';
      const payload: SettingsPayload = {
        language: languageValue,
        runtimes: readRuntimeInputs(),
        notebook: { defaultKernel: (document.getElementById('settings-default-kernel') as HTMLSelectElement).value },
        updates: {
          autoCheck: (document.getElementById('settings-auto-check') as HTMLInputElement).checked,
          autoDownload: (document.getElementById('settings-auto-download') as HTMLInputElement).checked,
          channel: (document.getElementById('settings-update-channel') as HTMLSelectElement).value === 'preview' ? 'preview' : 'stable',
        },
      };
      await deps.request('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
      if (languageValue !== getLanguage()) {
        setLanguage(languageValue);
        deps.applyLanguage(languageValue);
      }
      deps.toast('Settings saved', 'success');
      status('Saved. New kernel sessions use the selected paths.', 'success');
      await openSettingsDialog(deps);
    } catch (error) {
      status(error instanceof Error ? error.message : String(error), 'error');
      deps.toast(error instanceof Error ? error.message : String(error), 'error');
    } finally { button.disabled = false; }
  });
}
