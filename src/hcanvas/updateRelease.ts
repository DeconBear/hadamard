/** Hcanvas release discovery and update comparison. */
export interface GithubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

export interface GithubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: GithubReleaseAsset[];
}

export interface HcanvasReleaseInfo {
  version: string;
  tag: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string;
  prerelease: boolean;
  feedBase: string;
}

export type HcanvasUpdateChannel = 'stable' | 'preview';

export function parseVersion(value: string): number[] | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! < right[index]! ? -1 : 1;
  }
  return 0;
}

export function releaseInfoFromGithub(release: GithubRelease): HcanvasReleaseInfo | null {
  const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
  if (!tag.startsWith('hcanvas-v')) return null;
  const version = tag.slice('hcanvas-v'.length);
  if (!parseVersion(version)) return null;
  return {
    version,
    tag,
    name: typeof release.name === 'string' && release.name.trim() ? release.name.trim() : tag,
    notes: typeof release.body === 'string' ? release.body.slice(0, 8000) : '',
    url: typeof release.html_url === 'string' ? release.html_url : 'https://github.com/DeconBear/hadamard/releases/tag/' + encodeURIComponent(tag),
    publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
    prerelease: release.prerelease === true,
    feedBase: 'https://github.com/DeconBear/hadamard/releases/download/' + encodeURIComponent(tag),
  };
}

/** Pick the newest non-draft Hcanvas release newer than current. */
export function selectHcanvasRelease(releases: readonly GithubRelease[], currentVersion: string, channel: HcanvasUpdateChannel): HcanvasReleaseInfo | null {
  let best: HcanvasReleaseInfo | null = null;
  for (const release of releases) {
    if (release.draft === true) continue;
    const info = releaseInfoFromGithub(release);
    if (!info) continue;
    if (channel === 'stable' && info.prerelease) continue;
    if (compareVersions(info.version, currentVersion) <= 0) continue;
    if (!best || compareVersions(info.version, best.version) > 0) best = info;
  }
  return best;
}

export async function fetchHcanvasRelease(currentVersion: string, channel: HcanvasUpdateChannel, fetchImpl: typeof fetch = fetch): Promise<HcanvasReleaseInfo | null> {
  const response = await fetchImpl('https://api.github.com/repos/DeconBear/hadamard/releases?per_page=30', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'hcanvas-updater' },
  });
  if (!response.ok) throw new Error('GitHub Releases request failed: HTTP ' + response.status);
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new Error('GitHub Releases response was not an array');
  return selectHcanvasRelease(payload as GithubRelease[], currentVersion, channel);
}
