import { describe, expect, it } from 'vitest';

import { compareVersions, fetchHcanvasRelease, parseVersion, releaseInfoFromGithub, selectHcanvasRelease, type GithubRelease } from '../src/hcanvas/updateRelease.js';

const release = (tag: string, options: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: tag,
  name: 'Hcanvas ' + tag,
  body: 'notes',
  html_url: 'https://github.com/DeconBear/hadamard/releases/tag/' + tag,
  published_at: '2026-11-24T00:00:00Z',
  prerelease: false,
  draft: false,
  assets: [],
  ...options,
});

describe('Hcanvas release updates', () => {
  it('parses and compares versions', () => {
    expect(parseVersion('v0.1.4')).toEqual([0, 1, 4]);
    expect(parseVersion('0.1')).toEqual([0, 1, 0]);
    expect(compareVersions('0.1.10', '0.1.4')).toBeGreaterThan(0);
    expect(compareVersions('0.1.4', '0.1.4')).toBe(0);
    expect(compareVersions('0.0.9', '0.1.4')).toBeLessThan(0);
  });

  it('ignores non-Hcanvas, draft and older releases', () => {
    const selected = selectHcanvasRelease([
      release('hcanvas-v0.1.3'),
      release('hcanvas-v0.1.4'),
      release('hcanvas-v0.1.5', { draft: true }),
      release('v9.9.9'),
    ], '0.1.3', 'stable');
    expect(selected?.tag).toBe('hcanvas-v0.1.4');
    expect(selected?.feedBase).toContain('/hcanvas-v0.1.4');
  });

  it('excludes prereleases on stable but includes them on preview', () => {
    const releases = [release('hcanvas-v0.1.5', { prerelease: true })];
    expect(selectHcanvasRelease(releases, '0.1.4', 'stable')).toBeNull();
    expect(selectHcanvasRelease(releases, '0.1.4', 'preview')?.version).toBe('0.1.5');
  });

  it('returns null when current is latest', () => {
    expect(selectHcanvasRelease([release('hcanvas-v0.1.4')], '0.1.4', 'stable')).toBeNull();
  });

  it('fetches and filters GitHub releases', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify([
      release('hcanvas-v0.1.4'),
      release('hcanvas-v0.1.5'),
    ]), { status: 200 })) as unknown as typeof fetch;
    const info = await fetchHcanvasRelease('0.1.4', 'stable', fakeFetch);
    expect(info?.version).toBe('0.1.5');
  });

  it('returns null for an empty release body', () => {
    expect(releaseInfoFromGithub({ tag_name: 'other' })).toBeNull();
    expect(releaseInfoFromGithub({ tag_name: 'hcanvas-v0.1.4', body: undefined })?.notes).toBe('');
  });
});
