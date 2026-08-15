import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { activateRuntimeContribution, isRuntimeContributionManifest } from '../src/contrib/contributionLoader.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function packageDir(entryBody: string, entryName = 'contribution.mjs'): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hadamard-contrib-loader-'));
  tempDirs.push(directory);
  await writeFile(path.join(directory, entryName), entryBody, 'utf8');
  return directory;
}

const manifest = (overrides: Partial<{ id: string; version: string; entry: string }> = {}) => ({
  id: 'pkg.probe',
  version: '1.0.0',
  kind: 'runtime-contribution' as const,
  entry: 'contribution.mjs',
  ...overrides,
});

describe('isRuntimeContributionManifest', () => {
  it('recognizes only well-formed runtime-contribution manifests', () => {
    expect(isRuntimeContributionManifest(manifest())).toBe(true);
    expect(isRuntimeContributionManifest({ ...manifest(), kind: 'skill-mcp-bundle' })).toBe(false);
    expect(isRuntimeContributionManifest(null)).toBe(false);
    expect(isRuntimeContributionManifest({ id: 'x', version: '1', entry: 'e' })).toBe(false);
  });
});

describe('activateRuntimeContribution', () => {
  it('rejects invalid manifests before touching the package', async () => {
    await expect(activateRuntimeContribution('/none', {
      id: 'x', version: '1', kind: 'wrong', entry: 'e.mjs',
    } as never)).rejects.toMatchObject({ code: 'CONTRIBUTION_MANIFEST_INVALID' });
  });

  it('gates on trust before importing the entry', async () => {
    const directory = await packageDir("throw new Error('must not import');");
    const imported: string[] = [];
    await expect(activateRuntimeContribution(directory, manifest(), {
      isTrusted: async () => { imported.push('trust-checked'); return false; },
    })).rejects.toMatchObject({ code: 'CONTRIBUTION_UNTRUSTED' });
    expect(imported).toEqual(['trust-checked']);
  });

  it('confines the entry to the package root', async () => {
    const directory = await packageDir('export default {}');
    await expect(activateRuntimeContribution(directory, manifest({ entry: '../escape.mjs' }))).rejects.toMatchObject({
      code: 'CONTRIBUTION_ENTRY_ESCAPE',
    });
  });

  it('requires the entry id to match the manifest id', async () => {
    const directory = await packageDir("export default { id: 'pkg.other', apply() {} };");
    await expect(activateRuntimeContribution(directory, manifest())).rejects.toMatchObject({
      code: 'CONTRIBUTION_INVALID_DEFINITION',
    });
  });

  it('requires an apply function', async () => {
    const directory = await packageDir("export default { id: 'pkg.probe' };");
    await expect(activateRuntimeContribution(directory, manifest())).rejects.toMatchObject({
      code: 'CONTRIBUTION_INVALID_DEFINITION',
    });
  });

  it('activates a well-formed default export', async () => {
    const directory = await packageDir([
      'export default {',
      "  id: 'pkg.probe',",
      "  requires: ['pkg.base'],",
      "  apply(ctx) { return () => undefined; },",
      '};',
    ].join('\n'));
    const contribution = await activateRuntimeContribution(directory, manifest());
    expect(contribution.id).toBe('pkg.probe');
    expect(contribution.requires).toEqual(['pkg.base']);
    expect(typeof contribution.apply).toBe('function');
  });

  it('prefers an explicit createContribution export', async () => {
    const directory = await packageDir([
      "export const createContribution = () => ({ id: 'pkg.probe', apply() {} });",
    ].join('\n'));
    const contribution = await activateRuntimeContribution(directory, manifest());
    expect(contribution.id).toBe('pkg.probe');
  });

  it('rejects non-array requires', async () => {
    const directory = await packageDir("export default { id: 'pkg.probe', requires: 'base', apply() {} };");
    await expect(activateRuntimeContribution(directory, manifest())).rejects.toMatchObject({
      code: 'CONTRIBUTION_INVALID_DEFINITION',
    });
  });
});

