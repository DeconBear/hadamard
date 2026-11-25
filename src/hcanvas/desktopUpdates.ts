import { fetchHcanvasRelease, type HcanvasReleaseInfo, type HcanvasUpdateChannel } from './updateRelease.js';

export type HcUpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error';

export interface HcUpdateState {
  status: HcUpdateStatus;
  currentVersion: string;
  channel: HcanvasUpdateChannel;
  latest?: Pick<HcanvasReleaseInfo, 'version' | 'tag' | 'name' | 'notes' | 'url' | 'publishedAt' | 'prerelease'>;
  progress?: number;
  error?: string;
  canInstall: boolean;
  checkedAt?: string;
}

export interface HcUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL(options: { provider: 'generic'; url: string }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export interface DesktopUpdateDeps {
  currentVersion: string;
  isPackaged: boolean;
  getUpdater: () => HcUpdaterLike | null;
  getChannel: () => HcanvasUpdateChannel;
  isAutoDownload: () => boolean;
  fetchRelease?: (currentVersion: string, channel: HcanvasUpdateChannel) => Promise<HcanvasReleaseInfo | null>;
  onState?: (state: HcUpdateState) => void;
}

export interface DesktopUpdateController {
  state(): HcUpdateState;
  check(): Promise<HcUpdateState>;
  download(): Promise<HcUpdateState>;
  install(): boolean;
  setChannel(channel: HcanvasUpdateChannel): void;
}

function publicRelease(release: HcanvasReleaseInfo): HcUpdateState['latest'] {
  return {
    version: release.version,
    tag: release.tag,
    name: release.name,
    notes: release.notes,
    url: release.url,
    publishedAt: release.publishedAt,
    prerelease: release.prerelease,
  };
}

export function createDesktopUpdateController(deps: DesktopUpdateDeps): DesktopUpdateController {
  let channel = deps.getChannel();
  let latest: HcanvasReleaseInfo | null = null;
  let state: HcUpdateState = { status: 'idle', currentVersion: deps.currentVersion, channel, canInstall: deps.isPackaged };
  const publish = (next: HcUpdateState): HcUpdateState => {
    state = next;
    deps.onState?.(state);
    return state;
  };
  const fail = (error: unknown): HcUpdateState => publish({ ...state, status: 'error', error: error instanceof Error ? error.message : String(error), canInstall: deps.isPackaged });
  const configureUpdater = (): HcUpdaterLike | null => {
    const updater = deps.getUpdater();
    if (!updater) return null;
    updater.autoDownload = deps.isAutoDownload();
    updater.autoInstallOnAppQuit = true;
    return updater;
  };
  let eventsAttached = false;
  const attachUpdaterEvents = (updater: HcUpdaterLike): void => {
    if (eventsAttached) return;
    eventsAttached = true;
    updater.on('download-progress', (...args) => {
      const info = args[0] as { percent?: number } | undefined;
      if (typeof info?.percent === 'number') publish({ ...state, status: 'downloading', progress: Math.max(0, Math.min(100, info.percent)), canInstall: true });
    });
    updater.on('update-downloaded', () => publish({ ...state, status: 'downloaded', progress: 100, canInstall: true }));
    updater.on('error', (error: unknown) => { fail(error); });
  };

  const check = async (): Promise<HcUpdateState> => {
    channel = deps.getChannel();
    publish({ ...state, status: 'checking', channel, error: undefined, canInstall: deps.isPackaged });
    try {
      const release = await (deps.fetchRelease ?? fetchHcanvasRelease)(deps.currentVersion, channel);
      latest = release;
      const checkedAt = new Date().toISOString();
      if (!release) return publish({ status: 'up-to-date', currentVersion: deps.currentVersion, channel, checkedAt, canInstall: deps.isPackaged });
      const available: HcUpdateState = { status: 'available', currentVersion: deps.currentVersion, channel, latest: publicRelease(release), checkedAt, canInstall: deps.isPackaged };
      publish(available);
      const runtime = configureUpdater();
      if (runtime) attachUpdaterEvents(runtime);
      if (!runtime || !deps.isPackaged) {
        if (!deps.isPackaged) publish({ ...available, error: undefined });
        return state;
      }
      try {
        runtime.setFeedURL({ provider: 'generic', url: release.feedBase });
        await runtime.checkForUpdates();
      } catch (error) {
        // A release without electron-updater metadata can still be downloaded manually.
        return publish({ ...available, error: error instanceof Error ? error.message : String(error), canInstall: false });
      }
      return state;
    } catch (error) {
      return fail(error);
    }
  };

  const download = async (): Promise<HcUpdateState> => {
    if (!latest) return state;
    const runtime = configureUpdater();
    if (!runtime || !deps.isPackaged) {
      return fail('Automatic download is only available in the packaged desktop app. Open the release page to download.');
    }
    publish({ ...state, status: 'downloading', progress: 0, canInstall: true });
    try {
      await runtime.downloadUpdate();
      return state;
    } catch (error) {
      return fail(error);
    }
  };

  const install = (): boolean => {
    const runtime = deps.getUpdater();
    if (!runtime || state.status !== 'downloaded') return false;
    runtime.quitAndInstall(false, true);
    return true;
  };

  return {
    state: () => state,
    check,
    download,
    install,
    setChannel: (next: HcanvasUpdateChannel) => { channel = next; },
  };
}
