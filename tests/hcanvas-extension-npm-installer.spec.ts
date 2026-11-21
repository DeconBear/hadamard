import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HcExtensionError } from '../src/hcanvas/extensions/manifest.js';
import {
  NPM_INSTALL_PROVENANCE_FILE,
  installNpmExtension,
  type HcNpmExtensionInstallRequest,
  type HcNpmExtensionInstallResult,
} from '../src/hcanvas/extensions/npmInstaller.js';
import { handleExtensionRoute } from '../src/hcanvas/extensions/routes.js';
import type { HcExtensionLoaderOptions } from '../src/hcanvas/extensions/loader.js';

const EXTENSION_SCHEMA = 'hcanvas-extension/1';
const ENV_KEYS = ['HCANVAS_NPM_REGISTRY', 'HCANVAS_NPM_TOKEN', 'NPM_TOKEN', 'HCANVAS_NPM_OFFLINE'] as const;

let temp = '';
let workspace = '';
let home = '';
let bundled = '';
let registry: FakeRegistry;
let envBackup: Record<string, string | undefined> = {};
const closers: Array<() => Promise<void> | void> = [];

function defaultManifest(version: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: EXTENSION_SCHEMA,
    id: 'com.example.demo',
    name: 'Demo Extension',
    version,
    engines: { hcanvas: '>=0.1.0' },
    capabilities: {},
    contributes: {},
    ...overrides,
  };
}

function defaultPackageJson(name: string, version: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    version,
    description: 'Test extension package',
    keywords: ['hcanvas-extension'],
    license: 'MIT',
    ...overrides,
  };
}

interface TarEntrySpec {
  name: string;
  content?: string | Buffer;
  type?: 'file' | 'directory' | 'symlink' | 'hardlink' | 'fifo';
  linkname?: string;
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(value.toString(8).padStart(length - 1, '0'), offset, 'ascii');
  header.writeUInt8(0, offset + length - 1);
}

const TAR_TYPEFLAGS: Record<string, number> = {
  file: 0x30,
  directory: 0x35,
  symlink: 0x32,
  hardlink: 0x31,
  fifo: 0x36,
};

function buildTar(entries: TarEntrySpec[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? 'file';
    const content = entry.content === undefined
      ? Buffer.alloc(0)
      : typeof entry.content === 'string'
        ? Buffer.from(entry.content, 'utf8')
        : entry.content;
    const size = type === 'file' ? content.length : 0;
    const header = Buffer.alloc(512);
    const nameBytes = Buffer.from(entry.name, 'utf8');
    if (nameBytes.length > 100) throw new Error('test tar builder: entry name longer than 100 bytes: ' + entry.name);
    nameBytes.copy(header, 0);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, size);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.writeUInt8(TAR_TYPEFLAGS[type] ?? 0x30, 156);
    if (entry.linkname) Buffer.from(entry.linkname, 'utf8').copy(header, 157);
    Buffer.from('ustar\0', 'binary').copy(header, 257);
    Buffer.from('00', 'binary').copy(header, 263);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, '0'), 148, 'ascii');
    header.writeUInt8(0, 154);
    header.writeUInt8(0x20, 155);
    blocks.push(header);
    if (size > 0) {
      blocks.push(content);
      const padding = (512 - (size % 512)) % 512;
      if (padding) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function contentLength(content: string | Buffer | undefined): number {
  if (content === undefined) return 0;
  return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length;
}

interface FakePackageOptions {
  name: string;
  version: string;
  manifest?: Record<string, unknown>;
  packageJson?: Record<string, unknown>;
  extraEntries?: TarEntrySpec[];
  omit?: Array<'package.json' | 'manifest.json' | 'README.md'>;
  integrity?: string;
  unpackedSize?: number;
}

interface FakePackage {
  name: string;
  version: string;
  tarball: Buffer;
  integrity: string;
  unpackedSize: number;
}

function fakePackage(options: FakePackageOptions): FakePackage {
  const manifest = options.manifest ?? defaultManifest(options.version);
  const packageJson = options.packageJson ?? defaultPackageJson(options.name, options.version);
  const omitted = new Set(options.omit ?? []);
  const entries: TarEntrySpec[] = [];
  if (!omitted.has('package.json')) entries.push({ name: 'package/package.json', content: JSON.stringify(packageJson) });
  if (!omitted.has('manifest.json')) entries.push({ name: 'package/manifest.json', content: JSON.stringify(manifest) });
  if (!omitted.has('README.md')) entries.push({ name: 'package/README.md', content: '# Demo extension\n' });
  entries.push({ name: 'package/dist/index.js', content: 'export {};\n' });
  entries.push(...(options.extraEntries ?? []));
  const tarball = gzipSync(buildTar(entries), { level: 9 });
  const unpackedSize = entries
    .filter(entry => (entry.type ?? 'file') === 'file')
    .reduce((total, entry) => total + contentLength(entry.content), 0);
  return {
    name: options.name,
    version: options.version,
    tarball,
    integrity: options.integrity ?? 'sha512-' + createHash('sha512').update(tarball).digest('base64'),
    unpackedSize: options.unpackedSize ?? unpackedSize,
  };
}

class FakeRegistry {
  readonly packages = new Map<string, FakePackage[]>();
  readonly requests: Array<{ url: string; authorization?: string }> = [];
  requireToken: string | undefined;
  private server: Server | undefined;
  url = '';

  addPackage(pkg: FakePackage): FakePackage {
    const list = this.packages.get(pkg.name) ?? [];
    list.push(pkg);
    this.packages.set(pkg.name, list);
    return pkg;
  }

  private findPackage(name: string, version?: string): FakePackage | undefined {
    const list = this.packages.get(name);
    if (!list) return undefined;
    if (version) return list.find(pkg => pkg.version === version);
    return list[0];
  }

  private buildPackument(name: string, list: FakePackage[]): Record<string, unknown> {
    const versions: Record<string, unknown> = {};
    for (const pkg of list) {
      versions[pkg.version] = {
        name,
        version: pkg.version,
        dist: {
          tarball: this.url + '/tarballs/' + encodeURIComponent(name) + '/' + pkg.version + '.tgz',
          integrity: pkg.integrity,
          unpackedSize: pkg.unpackedSize,
        },
      };
    }
    const latest = list[list.length - 1];
    return { name, 'dist-tags': latest ? { latest: latest.version } : {}, versions };
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const rawUrl = req.url ?? '/';
    const authorization = req.headers.authorization;
    this.requests.push({ url: rawUrl, ...(authorization ? { authorization } : {}) });
    if (this.requireToken && authorization !== 'Bearer ' + this.requireToken) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const rawPath = rawUrl.split('?')[0] ?? '/';
    let pathname: string;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      pathname = rawPath;
    }
    if (pathname.startsWith('/tarballs/')) {
      const rest = pathname.slice('/tarballs/'.length);
      const separator = rest.lastIndexOf('/');
      const name = rest.slice(0, separator);
      const version = rest.slice(separator + 1).replace(/\.tgz$/, '');
      const pkg = this.findPackage(name, version);
      if (!pkg) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(pkg.tarball);
      return;
    }
    const name = pathname.replace(/^\/+/, '');
    const list = this.packages.get(name);
    const first = list ? list[0] : undefined;
    if (!list || !first) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(this.buildPackument(name, list)));
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    this.url = 'http://127.0.0.1:' + port;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function loaderOptions(): HcExtensionLoaderOptions {
  return { homeDir: home, bundledDir: bundled };
}

async function installNpm(request: Omit<HcNpmExtensionInstallRequest, 'source'>): Promise<HcNpmExtensionInstallResult> {
  return installNpmExtension(workspace, { source: 'npm', ...request }, loaderOptions());
}

async function captureError(promise: Promise<unknown>): Promise<HcExtensionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HcExtensionError);
    return error as HcExtensionError;
  }
  throw new Error('expected the install to fail');
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(target: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
}

function extensionRoot(): string {
  return path.join(workspace, 'extensions');
}

async function hiddenInstallDirs(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(entry => entry.name.startsWith('.')).map(entry => entry.name);
}

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-npm-installer-'));
  workspace = path.join(temp, 'project', '.hcanvas');
  home = path.join(temp, 'home');
  bundled = path.join(temp, 'bundled');
  await mkdir(workspace, { recursive: true });
  await mkdir(bundled, { recursive: true });
  envBackup = {};
  for (const key of ENV_KEYS) {
    envBackup[key] = process.env[key];
    delete process.env[key];
  }
  registry = new FakeRegistry();
  await registry.start();
});

afterEach(async () => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(closers.splice(0).map(close => Promise.resolve(close()).catch(() => undefined)));
  await registry.close().catch(() => undefined);
  await rm(temp, { recursive: true, force: true });
});

describe('npm extension installer', () => {
  it('installs an exact scoped package version with verified provenance', async () => {
    const pkg = fakePackage({
      name: '@acme/demo-ext',
      version: '1.2.3',
      manifest: defaultManifest('1.2.3', { id: 'com.acme.demo', name: 'Acme Demo' }),
      extraEntries: [{ name: 'package/dist/helper.js', content: 'export const answer = 42;\n' }],
    });
    registry.addPackage(pkg);
    process.env.HCANVAS_NPM_TOKEN = 'test-token';

    const result = await installNpm({ packageName: '@acme/demo-ext', version: '1.2.3', registry: registry.url });

    expect(result.id).toBe('com.acme.demo');
    const target = path.join(extensionRoot(), 'com.acme.demo');
    expect(result.path).toBe(path.join(target, 'manifest.json'));
    expect(await exists(path.join(target, 'package.json'))).toBe(true);
    expect(await exists(path.join(target, 'dist', 'helper.js'))).toBe(true);
    expect(await exists(path.join(target, 'dist', 'index.js'))).toBe(true);
    expect(await readdir(target)).toContain(NPM_INSTALL_PROVENANCE_FILE);

    const provenance = await readJson(path.join(target, NPM_INSTALL_PROVENANCE_FILE));
    expect(provenance).toMatchObject({
      source: 'npm',
      packageName: '@acme/demo-ext',
      version: '1.2.3',
      registry: registry.url,
      integrity: pkg.integrity,
    });
    expect(String(provenance.resolved)).toContain('/tarballs/');
    expect(Number.isNaN(Date.parse(String(provenance.installedAt)))).toBe(false);
    expect(result.provenance).toEqual(provenance);
    expect(result.extension?.source).toBe('workspace');
    expect(result.extension?.version).toBe('1.2.3');
    expect(result.extension?.provenance).toEqual(provenance);
    expect(result.discovery.extensions.some(entry => entry.id === 'com.acme.demo')).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);

    const metadataRequest = registry.requests.find(request => !request.url.startsWith('/tarballs/'));
    expect(metadataRequest?.url).toContain('%2F');
    expect(registry.requests.length).toBeGreaterThanOrEqual(2);
    expect(registry.requests.every(request => request.authorization === 'Bearer test-token')).toBe(true);
    expect(await hiddenInstallDirs(extensionRoot())).toEqual([]);
  });

  it('rejects ranges, dist-tags and malformed package names before any network call', async () => {
    registry.addPackage(fakePackage({ name: '@acme/demo-ext', version: '1.2.3' }));
    for (const version of ['latest', '^1.2.3', '~1.2.3', '1.2.x', '*', '>=1.2.3', '1.2', '']) {
      const error = await captureError(installNpm({ packageName: '@acme/demo-ext', version, registry: registry.url }));
      expect(error.code).toBe('invalid_params');
      expect(error.message).toMatch(/exact semver version/);
    }
    for (const packageName of ['@acme', '@acme/demo/extra', '../escape', 'Acme Demo', '']) {
      const error = await captureError(installNpm({ packageName, version: '1.2.3', registry: registry.url }));
      expect(error.code).toBe('invalid_params');
    }
    expect(registry.requests).toEqual([]);
  });

  it('rejects an unknown exact version', async () => {
    registry.addPackage(fakePackage({ name: 'acme-versioned', version: '1.0.0' }));
    registry.addPackage(fakePackage({ name: 'acme-versioned', version: '1.1.0' }));
    const error = await captureError(installNpm({ packageName: 'acme-versioned', version: '9.9.9', registry: registry.url }));
    expect(error.code).toBe('not_found');
    expect(error.message).toContain('9.9.9');
    expect(await hiddenInstallDirs(extensionRoot())).toEqual([]);
  });

  it('rejects a tarball that does not match dist.integrity', async () => {
    const pkg = fakePackage({
      name: 'acme-bad-integrity',
      version: '1.0.0',
      integrity: 'sha512-' + createHash('sha512').update('some other bytes').digest('base64'),
    });
    registry.addPackage(pkg);
    const error = await captureError(installNpm({ packageName: 'acme-bad-integrity', version: '1.0.0', registry: registry.url }));
    expect(error.code).toBe('invalid_manifest');
    expect(error.message).toMatch(/integrity check failed/i);
    expect(await hiddenInstallDirs(extensionRoot())).toEqual([]);
  });

  it('rejects package.json/manifest/requested version mismatches', async () => {
    registry.addPackage(fakePackage({
      name: 'acme-manifest-mismatch',
      version: '1.0.0',
      packageJson: defaultPackageJson('acme-manifest-mismatch', '0.9.0'),
    }));
    const manifestError = await captureError(installNpm({ packageName: 'acme-manifest-mismatch', version: '1.0.0', registry: registry.url }));
    expect(manifestError.code).toBe('invalid_manifest');
    expect(manifestError.message).toContain('manifest.version');

    registry.addPackage(fakePackage({
      name: 'acme-request-mismatch',
      version: '1.0.0',
      manifest: defaultManifest('1.0.1', { id: 'com.acme.request-mismatch' }),
      packageJson: defaultPackageJson('acme-request-mismatch', '1.0.1'),
    }));
    const requestError = await captureError(installNpm({ packageName: 'acme-request-mismatch', version: '1.0.0', registry: registry.url }));
    expect(requestError.code).toBe('invalid_manifest');
    expect(requestError.message).toContain('requested version');
    expect(await hiddenInstallDirs(extensionRoot())).toEqual([]);
  });

  it('requires manifest schema, the hcanvas-extension keyword and a non-builtin manifest', async () => {
    registry.addPackage(fakePackage({
      name: 'acme-no-keyword',
      version: '1.0.0',
      packageJson: defaultPackageJson('acme-no-keyword', '1.0.0', { keywords: ['other'] }),
    }));
    const keywordError = await captureError(installNpm({ packageName: 'acme-no-keyword', version: '1.0.0', registry: registry.url }));
    expect(keywordError.code).toBe('invalid_manifest');
    expect(keywordError.message).toContain('hcanvas-extension');

    registry.addPackage(fakePackage({
      name: 'acme-builtin',
      version: '1.0.0',
      manifest: defaultManifest('1.0.0', { id: 'com.acme.builtin', builtin: true }),
    }));
    const builtinError = await captureError(installNpm({ packageName: 'acme-builtin', version: '1.0.0', registry: registry.url }));
    expect(builtinError.code).toBe('invalid_manifest');
    expect(builtinError.message).toMatch(/builtin/i);

    registry.addPackage(fakePackage({
      name: 'acme-wrong-schema',
      version: '1.0.0',
      manifest: { ...defaultManifest('1.0.0', { id: 'com.acme.wrong-schema' }), schema: 'hcanvas-extension/2' },
    }));
    const schemaError = await captureError(installNpm({ packageName: 'acme-wrong-schema', version: '1.0.0', registry: registry.url }));
    expect(schemaError.code).toBe('invalid_manifest');
    expect(await hiddenInstallDirs(extensionRoot())).toEqual([]);
  });

  it('rejects path traversal, absolute paths, drive paths and backslash escapes', async () => {
    const malicious: Array<{ name: string; entry: string }> = [
      { name: 'acme-traversal', entry: '../escape.txt' },
      { name: 'acme-nested-traversal', entry: 'package/../escape.txt' },
      { name: 'acme-absolute', entry: '/etc/escape.txt' },
      { name: 'acme-drive', entry: 'package/C:/escape.txt' },
      { name: 'acme-backslash', entry: 'package/..\\..\\escape.txt' },
    ];
    for (const item of malicious) {
      registry.addPackage(fakePackage({
        name: item.name,
        version: '1.0.0',
        extraEntries: [{ name: item.entry, content: 'escaped' }],
      }));
    }
    for (const item of malicious) {
      const error = await captureError(installNpm({ packageName: item.name, version: '1.0.0', registry: registry.url }));
      expect(error.code).toBe('path_forbidden');
    }
    expect(await exists(path.join(temp, 'escape.txt'))).toBe(false);
    expect(await exists(path.join(workspace, 'escape.txt'))).toBe(false);
    expect(await exists(path.join(workspace, '..', 'escape.txt'))).toBe(false);
    expect(await exists(path.join(extensionRoot(), 'escape.txt'))).toBe(false);
    expect(await hiddenInstallDirs(extensionRoot())).toEqual([]);
  });

  it('rejects symlink, hardlink and device tarball entries', async () => {
    const malicious: Array<{ name: string; entry: TarEntrySpec }> = [
      { name: 'acme-symlink', entry: { name: 'package/link.js', type: 'symlink', linkname: '../outside.js' } },
      { name: 'acme-hardlink', entry: { name: 'package/hard.js', type: 'hardlink', linkname: 'package/package.json' } },
      { name: 'acme-fifo', entry: { name: 'package/pipe', type: 'fifo' } },
    ];
    for (const item of malicious) {
      registry.addPackage(fakePackage({ name: item.name, version: '1.0.0', extraEntries: [item.entry] }));
      const error = await captureError(installNpm({ packageName: item.name, version: '1.0.0', registry: registry.url }));
      expect(error.code).toBe('path_forbidden');
    }
    expect(await hiddenInstallDirs(extensionRoot())).toEqual([]);
  });

  it('rejects incompatible engines.hcanvas with a readable error', async () => {
    registry.addPackage(fakePackage({
      name: 'acme-incompatible',
      version: '1.0.0',
      manifest: defaultManifest('1.0.0', { id: 'com.acme.incompatible', engines: { hcanvas: '>=99.0.0' } }),
    }));
    const error = await captureError(installNpm({ packageName: 'acme-incompatible', version: '1.0.0', registry: registry.url }));
    expect(error.code).toBe('incompatible');
    expect(error.message).toContain('>=99.0.0');
    expect(await hiddenInstallDirs(extensionRoot())).toEqual([]);
  });

  it('rejects reserved extension ids unless the package lives under @hcanvas/', async () => {
    registry.addPackage(fakePackage({
      name: 'acme-reserved',
      version: '1.0.0',
      manifest: defaultManifest('1.0.0', { id: 'com.hadamard.reserved' }),
    }));
    const reservedError = await captureError(installNpm({ packageName: 'acme-reserved', version: '1.0.0', registry: registry.url }));
    expect(reservedError.code).toBe('invalid_manifest');
    expect(reservedError.message).toMatch(/reserved/i);

    registry.addPackage(fakePackage({
      name: '@hcanvas/kernel-demo',
      version: '1.0.0',
      manifest: defaultManifest('1.0.0', { id: 'hcanvas.kernel-demo', name: 'Official demo kernel' }),
    }));
    const official = await installNpm({ packageName: '@hcanvas/kernel-demo', version: '1.0.0', registry: registry.url });
    expect(official.id).toBe('hcanvas.kernel-demo');
    expect(await exists(path.join(extensionRoot(), 'hcanvas.kernel-demo', 'manifest.json'))).toBe(true);
  });

  it('installs user-scope extensions into the discovery user root', async () => {
    registry.addPackage(fakePackage({
      name: 'acme-user-scope',
      version: '1.0.0',
      manifest: defaultManifest('1.0.0', { id: 'com.acme.user-scope' }),
    }));
    const result = await installNpm({ packageName: 'acme-user-scope', version: '1.0.0', scope: 'user', registry: registry.url });
    const userRoot = path.join(home, 'hcanvas', 'extensions');
    expect(result.discovery.paths.userExtensions).toBe(userRoot);
    expect(await exists(path.join(userRoot, 'com.acme.user-scope', 'manifest.json'))).toBe(true);
    expect(result.extension?.source).toBe('user');
    expect(await hiddenInstallDirs(userRoot)).toEqual([]);
    expect(await hiddenInstallDirs(extensionRoot())).toEqual([]);
  });

  it('reports a conflict without overwrite and replaces cleanly with overwrite', async () => {
    registry.addPackage(fakePackage({
      name: 'acme-overwrite',
      version: '1.0.0',
      manifest: defaultManifest('1.0.0', { id: 'com.acme.overwrite' }),
    }));
    registry.addPackage(fakePackage({
      name: 'acme-overwrite',
      version: '2.0.0',
      manifest: defaultManifest('2.0.0', { id: 'com.acme.overwrite' }),
    }));
    const first = await installNpm({ packageName: 'acme-overwrite', version: '1.0.0', registry: registry.url });
    expect(first.id).toBe('com.acme.overwrite');
    const target = path.join(extensionRoot(), 'com.acme.overwrite');

    const conflict = await captureError(installNpm({ packageName: 'acme-overwrite', version: '2.0.0', registry: registry.url }));
    expect(conflict.code).toBe('conflict');
    expect((await readJson(path.join(target, 'manifest.json'))).version).toBe('1.0.0');

    const replaced = await installNpm({ packageName: 'acme-overwrite', version: '2.0.0', overwrite: true, registry: registry.url });
    expect(replaced.provenance.version).toBe('2.0.0');
    expect((await readJson(path.join(target, 'manifest.json'))).version).toBe('2.0.0');
    const provenance = await readJson(path.join(target, NPM_INSTALL_PROVENANCE_FILE));
    expect(provenance.version).toBe('2.0.0');
    expect(await hiddenInstallDirs(extensionRoot())).toEqual([]);
  });

  it('restores the previous version when a post-backup install step fails', async () => {
    registry.addPackage(fakePackage({
      name: 'acme-rollback',
      version: '1.0.0',
      manifest: defaultManifest('1.0.0', { id: 'com.acme.rollback' }),
    }));
    registry.addPackage(fakePackage({
      name: 'acme-rollback',
      version: '2.0.0',
      manifest: defaultManifest('2.0.0', { id: 'com.acme.rollback' }),
      // A directory at the provenance file path makes the provenance write fail
      // after the existing version has been moved to the backup folder.
      extraEntries: [{ name: 'package/' + NPM_INSTALL_PROVENANCE_FILE, type: 'directory' }],
    }));
    await installNpm({ packageName: 'acme-rollback', version: '1.0.0', registry: registry.url });
    const target = path.join(extensionRoot(), 'com.acme.rollback');

    const error = await captureError(installNpm({ packageName: 'acme-rollback', version: '2.0.0', overwrite: true, registry: registry.url }));
    expect(error.code).toBe('internal_error');
    expect((await readJson(path.join(target, 'manifest.json'))).version).toBe('1.0.0');
    const provenance = await readJson(path.join(target, NPM_INSTALL_PROVENANCE_FILE));
    expect(provenance.version).toBe('1.0.0');
    expect(await hiddenInstallDirs(extensionRoot())).toEqual([]);
  });

  it('honours registry/token env configuration and sends no auth header without a token', async () => {
    const options = { name: 'acme-env', version: '1.0.0', manifest: defaultManifest('1.0.0', { id: 'com.acme.env' }) };
    registry.addPackage(fakePackage(options));
    registry.addPackage(fakePackage({ ...options, name: 'acme-env-fallback', manifest: defaultManifest('1.0.0', { id: 'com.acme.env-fallback' }) }));
    registry.addPackage(fakePackage({ ...options, name: 'acme-env-anonymous', manifest: defaultManifest('1.0.0', { id: 'com.acme.env-anonymous' }) }));

    process.env.HCANVAS_NPM_REGISTRY = registry.url;
    process.env.HCANVAS_NPM_TOKEN = 'primary-token';
    process.env.NPM_TOKEN = 'secondary-token';
    await installNpm({ packageName: 'acme-env', version: '1.0.0' });
    expect(registry.requests.every(request => request.authorization === 'Bearer primary-token')).toBe(true);

    delete process.env.HCANVAS_NPM_TOKEN;
    const fallbackMarker = registry.requests.length;
    await installNpm({ packageName: 'acme-env-fallback', version: '1.0.0' });
    expect(registry.requests.length).toBeGreaterThan(fallbackMarker);
    expect(registry.requests.slice(fallbackMarker).every(request => request.authorization === 'Bearer secondary-token')).toBe(true);

    delete process.env.NPM_TOKEN;
    const anonymousMarker = registry.requests.length;
    await installNpm({ packageName: 'acme-env-anonymous', version: '1.0.0' });
    expect(registry.requests.length).toBeGreaterThan(anonymousMarker);
    expect(registry.requests.slice(anonymousMarker).every(request => request.authorization === undefined)).toBe(true);
  });

  it('reports a readable error in offline mode without contacting the registry', async () => {
    registry.addPackage(fakePackage({ name: 'acme-offline', version: '1.0.0' }));
    process.env.HCANVAS_NPM_OFFLINE = '1';
    const error = await captureError(installNpm({ packageName: 'acme-offline', version: '1.0.0', registry: registry.url }));
    expect(error.code).toBe('unsupported');
    expect(error.message).toMatch(/offline/i);
    expect(registry.requests).toEqual([]);
  });

  it('reports registry authentication failures and succeeds with the expected token', async () => {
    registry.requireToken = 'expected-secret';
    registry.addPackage(fakePackage({
      name: 'acme-auth',
      version: '1.0.0',
      manifest: defaultManifest('1.0.0', { id: 'com.acme.auth' }),
    }));
    const denied = await captureError(installNpm({ packageName: 'acme-auth', version: '1.0.0', registry: registry.url }));
    expect(denied.code).toBe('unsupported');
    expect(denied.message).toMatch(/401|authentication|access/i);
    expect(await hiddenInstallDirs(extensionRoot())).toEqual([]);

    process.env.HCANVAS_NPM_TOKEN = 'expected-secret';
    const authorizedMarker = registry.requests.length;
    const installed = await installNpm({ packageName: 'acme-auth', version: '1.0.0', registry: registry.url });
    expect(installed.id).toBe('com.acme.auth');
    expect(registry.requests.length).toBeGreaterThan(authorizedMarker);
    expect(registry.requests.slice(authorizedMarker).every(request => request.authorization === 'Bearer expected-secret')).toBe(true);
  });

  it('keeps folder/json installs unchanged and exposes npm installs over the HTTP route', async () => {
    const route = async (pathname: string, body: Record<string, unknown>): Promise<{ status: number; payload: Record<string, unknown> }> => {
      let captured: { status: number; payload: Record<string, unknown> } | undefined;
      const handled = await handleExtensionRoute(
        { method: 'POST' } as unknown as IncomingMessage,
        {} as unknown as ServerResponse,
        new URL('http://127.0.0.1' + pathname),
        {
          workspace,
          homeDir: home,
          bundledDir: bundled,
          json: (_res, status, payload) => {
            captured = { status, payload: payload as Record<string, unknown> };
          },
          readBody: async () => body,
        },
      );
      expect(handled).toBe(true);
      if (!captured) throw new Error('extension route did not respond');
      return captured;
    };

    registry.addPackage(fakePackage({
      name: '@acme/http-ext',
      version: '1.0.0',
      manifest: defaultManifest('1.0.0', { id: 'com.acme.http' }),
    }));
    const npmResponse = await route('/api/extensions/install', {
      source: 'npm',
      packageName: '@acme/http-ext',
      version: '1.0.0',
      registry: registry.url,
    });
    expect(npmResponse.status).toBe(201);
    expect(npmResponse.payload.ok).toBe(true);
    expect(npmResponse.payload.id).toBe('com.acme.http');
    expect(typeof npmResponse.payload.path).toBe('string');
    expect((npmResponse.payload.extension as Record<string, unknown>).source).toBe('user');
    expect((npmResponse.payload.provenance as Record<string, unknown>).version).toBe('1.0.0');
    expect(Array.isArray(npmResponse.payload.extensions)).toBe(true);

    registry.addPackage(fakePackage({
      name: 'acme-http-incompatible',
      version: '1.0.0',
      manifest: defaultManifest('1.0.0', { id: 'com.acme.http-incompatible', engines: { hcanvas: '>=99.0.0' } }),
    }));
    const incompatibleResponse = await route('/api/extensions/install', {
      source: 'npm',
      packageName: 'acme-http-incompatible',
      version: '1.0.0',
      registry: registry.url,
    });
    expect(incompatibleResponse.status).toBe(409);
    expect(incompatibleResponse.payload.code).toBe('incompatible');

    const folderDir = path.join(temp, 'folder-extension');
    await mkdir(folderDir, { recursive: true });
    await writeFile(path.join(folderDir, 'manifest.json'), JSON.stringify(defaultManifest('0.1.0', { id: 'com.example.folder' })), 'utf8');
    const folderResponse = await route('/api/extensions/install', { source: 'folder', path: folderDir, scope: 'workspace' });
    expect(folderResponse.status).toBe(201);
    expect(folderResponse.payload.ok).toBe(true);
    expect(folderResponse.payload.id).toBe('com.example.folder');
    expect('provenance' in folderResponse.payload).toBe(false);

    const jsonResponse = await route('/api/extensions/install', {
      source: 'json',
      manifest: defaultManifest('0.1.0', { id: 'com.example.json' }),
    });
    expect(jsonResponse.status).toBe(201);
    expect(jsonResponse.payload.ok).toBe(true);
    expect(jsonResponse.payload.id).toBe('com.example.json');
    expect('provenance' in jsonResponse.payload).toBe(false);

    const invalidSource = await route('/api/extensions/install', { source: 'tarball', path: folderDir });
    expect(invalidSource.status).toBe(400);
    expect(invalidSource.payload.code).toBe('invalid_install_source');
  });
});
