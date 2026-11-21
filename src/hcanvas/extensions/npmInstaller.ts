/**
 * Self-contained NPM extension installer.
 *
 * Downloads an exact package version from an NPM registry, verifies the
 * tarball integrity, extracts it with an in-file tar reader (no external
 * tar/npm dependency), enforces the Hcanvas package contract, and hands the
 * validated folder to the shared extension loader. Package lifecycle scripts
 * and nested `npm install` runs are never executed.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { ProxyAgent } from 'undici';

import {
  HCANVAS_EXTENSION_TARGET_VERSION,
  HcExtensionError,
  checkExtensionManifest,
  engineRangeSatisfies,
  type HcExtensionManifest,
} from './manifest.js';
import {
  extensionDiscoveryPaths,
  installExtension,
  type HcExtensionInstallResult,
  type HcExtensionLoaderOptions,
} from './loader.js';

/** Provenance file written into the staged extension folder before it is installed. */
export const NPM_INSTALL_PROVENANCE_FILE = '.hcanvas-install.json';

/** Find an installed extension id whose npm provenance matches a package name. */
export async function findInstalledNpmExtension(workspace: string, packageName: string, scope: 'workspace' | 'user', options: HcExtensionLoaderOptions = {}): Promise<string | undefined> {
  const paths = extensionDiscoveryPaths(workspace, options);
  const root = scope === 'user' ? paths.userExtensions : paths.workspaceExtensions;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return undefined; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      const provenance = JSON.parse(await readFile(path.join(root, entry.name, NPM_INSTALL_PROVENANCE_FILE), 'utf8')) as unknown;
      if (isObject(provenance) && provenance.packageName === packageName) {
        const manifest = JSON.parse(await readFile(path.join(root, entry.name, 'manifest.json'), 'utf8')) as unknown;
        if (isObject(manifest) && typeof manifest.id === 'string') return manifest.id;
      }
    } catch { /* not an installed npm extension */ }
  }
  return undefined;
}

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
/** Registry packument size limit. */
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
/** Downloaded gzip tarball size limit. */
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
/** Total uncompressed/extracted size limit. */
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
/** Per-file uncompressed size limit. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Maximum number of entries in a tarball. */
const MAX_ENTRY_COUNT = 8192;
/** Every npm tarball wraps the package contents in a single top-level folder. */
const PACKAGE_ROOT = 'package';
const TAR_BLOCK_SIZE = 512;
const USER_AGENT = 'hcanvas-extension-installer/1';
const HASH_LENGTHS: Record<string, number> = { sha256: 32, sha384: 48, sha512: 64 };
/** Exact semver only: ranges, dist-tags and wildcards are rejected before any network call. */
const EXACT_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const README_PATTERN = /^readme(?:\.[a-z0-9]+)?$/iu;
const LICENSE_PATTERN = /^(?:licen[cs]e|copying)(?:\.[a-z0-9]+)?$/iu;

/** Install request for the npm tarball installer (HTTP route and CLI share it). */
export interface HcNpmExtensionInstallRequest {
  source: 'npm';
  packageName: string;
  version: string;
  scope?: 'workspace' | 'user';
  overwrite?: boolean;
  registry?: string;
  timeoutMs?: number;
}

/** Verified provenance for an npm-installed extension. */
export interface HcExtensionInstallProvenance {
  source: 'npm' | 'tarball';
  packageName: string;
  version: string;
  resolved: string;
  integrity: string;
  registry: string;
  installedAt: string;
}

/** Install request for a local .tgz package (development path, no registry). */
export interface HcLocalTarballInstallRequest {
  source: 'tarball';
  path: string;
  scope?: 'workspace' | 'user';
  overwrite?: boolean;
  timeoutMs?: number;
}

/** Same result shape as folder/json installs, plus npm provenance and warnings. */
export interface HcNpmExtensionInstallResult extends HcExtensionInstallResult {
  provenance: HcExtensionInstallProvenance;
  warnings: string[];
}

interface NormalizedNpmRequest {
  packageName: string;
  version: string;
  scope: 'workspace' | 'user';
  overwrite: boolean;
  registry: string;
  timeoutMs: number;
}

interface DistributionMetadata {
  tarballUrl: string;
  integrity: string;
  unpackedSize?: number;
}

interface PackageContract {
  manifest: HcExtensionManifest;
  warnings: string[];
}

interface PackageTarEntry {
  relPath: string;
  kind: 'file' | 'directory';
  size: number;
  data?: Buffer;
}

interface RegistryFetchRequest {
  url: string;
  token?: string;
  timeoutMs: number;
  accept: string;
  limit: number;
  limitCode: 'invalid_manifest' | 'internal_error';
  label: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget !== resolvedRoot && resolvedTarget.startsWith(resolvedRoot + path.sep);
}

function packageLabel(request: { packageName: string; version: string }): string {
  return request.packageName + '@' + request.version;
}

function isValidPackageName(packageName: string): boolean {
  if (!packageName || packageName.length > 214) return false;
  if (packageName.startsWith('@')) {
    const parts = packageName.split('/');
    if (parts.length !== 2) return false;
    const scope = parts[0] ?? '';
    const name = parts[1] ?? '';
    return /^@[a-z0-9][a-z0-9._-]*$/iu.test(scope) && /^[a-z0-9][a-z0-9._-]*$/u.test(name);
  }
  return /^[a-z0-9][a-z0-9._-]*$/u.test(packageName);
}

function encodeRegistryName(packageName: string): string {
  // The registry expects the scope separator encoded in metadata URLs.
  return packageName.startsWith('@') ? packageName.replace('/', '%2F') : packageName;
}

function normalizeRegistry(value: string | undefined): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_REGISTRY;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HcExtensionError('invalid_params', 'registry must be an absolute http(s) URL (received "' + raw + '")');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HcExtensionError('invalid_params', 'registry must use http or https (received "' + raw + '")');
  }
  if (parsed.username || parsed.password) {
    throw new HcExtensionError('invalid_params', 'registry URL must not embed credentials; set HCANVAS_NPM_TOKEN or NPM_TOKEN instead');
  }
  const pathname = parsed.pathname.replace(/\/+$/u, '');
  return parsed.origin + pathname;
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new HcExtensionError('invalid_params', 'timeoutMs must be a positive number of milliseconds');
  }
  return Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS);
}

function normalizeNpmRequest(request: HcNpmExtensionInstallRequest): NormalizedNpmRequest {
  if (!isObject(request) || request.source !== 'npm') {
    throw new HcExtensionError('invalid_install_source', 'source must be "npm"');
  }
  const packageName = typeof request.packageName === 'string' ? request.packageName.trim() : '';
  if (!isValidPackageName(packageName)) {
    throw new HcExtensionError('invalid_params', 'packageName must be an exact package name such as "some-extension" or "@scope/some-extension"');
  }
  const version = request.version;
  if (typeof version !== 'string' || !EXACT_VERSION_PATTERN.test(version)) {
    throw new HcExtensionError(
      'invalid_params',
      'version must be an exact semver version such as "1.2.3" (received ' + JSON.stringify(version) + '); ranges, dist-tags and wildcards are not allowed',
    );
  }
  const scope = request.scope;
  if (scope !== undefined && scope !== 'workspace' && scope !== 'user') {
    throw new HcExtensionError('invalid_params', 'scope must be "workspace" or "user"');
  }
  const requestedRegistry = typeof request.registry === 'string' && request.registry.trim() ? request.registry : undefined;
  return {
    packageName,
    version,
    scope: scope === 'user' ? 'user' : 'workspace',
    overwrite: request.overwrite === true,
    registry: normalizeRegistry(requestedRegistry ?? process.env.HCANVAS_NPM_REGISTRY),
    timeoutMs: normalizeTimeout(request.timeoutMs),
  };
}

function assertOnline(): void {
  const offline = process.env.HCANVAS_NPM_OFFLINE?.trim().toLowerCase();
  if (offline === '1' || offline === 'true' || offline === 'yes') {
    throw new HcExtensionError(
      'unsupported',
      'NPM installation is unavailable because HCANVAS_NPM_OFFLINE is enabled; already installed extensions can still be managed locally',
    );
  }
}

let registryProxyAgent: { url: string; agent: ProxyAgent } | undefined;

/** Fetch through HTTPS_PROXY/HTTP_PROXY when configured, without changing the registry URL. */
function registryFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const proxy = (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
  if (!proxy) return fetch(url, init);
  let parsed: URL;
  try { parsed = new URL(proxy); } catch {
    throw new HcExtensionError('invalid_params', 'Proxy URL is invalid: ' + JSON.stringify(proxy));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HcExtensionError('invalid_params', 'Proxy URL must use http or https');
  }
  if (!registryProxyAgent || registryProxyAgent.url !== proxy) {
    try {
      registryProxyAgent = { url: proxy, agent: new ProxyAgent(proxy) };
    } catch (error) {
      throw networkError(url, error, timeoutMs);
    }
  }
  return fetch(url, { ...init, dispatcher: registryProxyAgent.agent } as RequestInit);
}

function readAuthToken(): string | undefined {
  const primary = process.env.HCANVAS_NPM_TOKEN?.trim();
  if (primary) return primary;
  return process.env.NPM_TOKEN?.trim() || undefined;
}

function networkError(url: string, error: unknown, timeoutMs: number): HcExtensionError {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new HcExtensionError('internal_error', 'NPM registry request timed out after ' + timeoutMs + ' ms: ' + url);
  }
  return new HcExtensionError('internal_error', 'NPM registry request failed for ' + url + ': ' + toErrorMessage(error));
}

function registryStatusError(url: string, status: number): HcExtensionError {
  if (status === 404) return new HcExtensionError('not_found', 'NPM registry has no such package or version: ' + url);
  if (status === 401 || status === 403) {
    return new HcExtensionError(
      'unsupported',
      'NPM registry denied access (HTTP ' + status + ') for ' + url + '; configure HCANVAS_NPM_TOKEN or NPM_TOKEN with read access',
    );
  }
  return new HcExtensionError('internal_error', 'NPM registry request failed with HTTP ' + status + ': ' + url);
}

async function readLimitedResponse(response: Awaited<ReturnType<typeof fetch>>, request: RegistryFetchRequest): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > request.limit) {
    throw new HcExtensionError(request.limitCode, request.label + ' exceeds the ' + request.limit + '-byte install limit');
  }
  const body = response.body;
  if (!body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > request.limit) {
      throw new HcExtensionError(request.limitCode, request.label + ' exceeds the ' + request.limit + '-byte install limit');
    }
    return buffer;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > request.limit) {
        await reader.cancel().catch(() => undefined);
        throw new HcExtensionError(request.limitCode, request.label + ' exceeds the ' + request.limit + '-byte install limit');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function fetchRegistryBytes(request: RegistryFetchRequest): Promise<Buffer> {
  const headers: Record<string, string> = { accept: request.accept, 'user-agent': USER_AGENT };
  if (request.token) headers.authorization = 'Bearer ' + request.token;
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await registryFetch(request.url, {
      method: 'GET',
      redirect: 'follow',
      headers,
      signal: AbortSignal.timeout(request.timeoutMs),
    }, request.timeoutMs);
  } catch (error) {
    throw networkError(request.url, error, request.timeoutMs);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw registryStatusError(request.url, response.status);
  }
  return readLimitedResponse(response, request);
}

async function fetchPackument(spec: NormalizedNpmRequest, token: string | undefined): Promise<Record<string, unknown>> {
  const url = spec.registry + '/' + encodeRegistryName(spec.packageName);
  const bytes = await fetchRegistryBytes({
    url,
    ...(token ? { token } : {}),
    timeoutMs: spec.timeoutMs,
    accept: 'application/json',
    limit: MAX_METADATA_BYTES,
    limitCode: 'internal_error',
    label: 'NPM package metadata for ' + spec.packageName,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new HcExtensionError('internal_error', 'NPM registry returned invalid JSON metadata for "' + spec.packageName + '"');
  }
  if (!isObject(parsed)) {
    throw new HcExtensionError('internal_error', 'NPM registry returned unexpected metadata for "' + spec.packageName + '"');
  }
  return parsed;
}

function selectVersionMetadata(packument: Record<string, unknown>, spec: NormalizedNpmRequest): Record<string, unknown> {
  if (typeof packument.name === 'string' && packument.name !== spec.packageName) {
    throw new HcExtensionError('internal_error', 'NPM registry returned metadata for "' + packument.name + '" while resolving "' + spec.packageName + '"');
  }
  const versions = packument.versions;
  if (!isObject(versions)) {
    throw new HcExtensionError('invalid_manifest', 'NPM metadata for "' + spec.packageName + '" has no versions table');
  }
  const metadata = versions[spec.version];
  if (!isObject(metadata)) {
    const available = Object.keys(versions);
    const suffix = available.length ? ' (available versions: ' + available.slice(-5).join(', ') + ')' : '';
    throw new HcExtensionError('not_found', 'Extension package "' + packageLabel(spec) + '" is not available in ' + spec.registry + suffix);
  }
  if (typeof metadata.version === 'string' && metadata.version !== spec.version) {
    throw new HcExtensionError('internal_error', 'NPM registry metadata version mismatch while resolving ' + packageLabel(spec));
  }
  return metadata;
}

function readDistributionMetadata(versionMetadata: Record<string, unknown>, spec: NormalizedNpmRequest): DistributionMetadata {
  const dist = versionMetadata.dist;
  if (!isObject(dist)) {
    throw new HcExtensionError('invalid_manifest', 'NPM metadata for ' + packageLabel(spec) + ' has no dist object');
  }
  const tarballUrl = typeof dist.tarball === 'string' ? dist.tarball.trim() : '';
  if (!tarballUrl) throw new HcExtensionError('invalid_manifest', 'NPM metadata for ' + packageLabel(spec) + ' has no dist.tarball URL');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(tarballUrl);
  } catch {
    throw new HcExtensionError('invalid_manifest', 'NPM metadata for ' + packageLabel(spec) + ' declares an invalid dist.tarball URL');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new HcExtensionError('invalid_manifest', 'NPM metadata for ' + packageLabel(spec) + ' declares a non-http(s) dist.tarball URL');
  }
  const integrity = typeof dist.integrity === 'string' ? dist.integrity.trim() : '';
  if (!integrity) {
    throw new HcExtensionError('invalid_manifest', 'NPM metadata for ' + packageLabel(spec) + ' has no dist.integrity; refusing to install an unverifiable package');
  }
  let unpackedSize: number | undefined;
  if (dist.unpackedSize !== undefined) {
    if (typeof dist.unpackedSize !== 'number' || !Number.isInteger(dist.unpackedSize) || dist.unpackedSize < 0) {
      throw new HcExtensionError('invalid_manifest', 'NPM metadata for ' + packageLabel(spec) + ' declares a non-integer dist.unpackedSize');
    }
    if (dist.unpackedSize > MAX_EXTRACTED_BYTES) {
      throw new HcExtensionError('invalid_manifest', packageLabel(spec) + ' declares an unpacked size of ' + dist.unpackedSize + ' bytes, above the ' + MAX_EXTRACTED_BYTES + '-byte limit');
    }
    unpackedSize = dist.unpackedSize;
  }
  return { tarballUrl: parsedUrl.toString(), integrity, ...(unpackedSize !== undefined ? { unpackedSize } : {}) };
}

async function downloadTarball(dist: DistributionMetadata, spec: NormalizedNpmRequest, token: string | undefined): Promise<Buffer> {
  return fetchRegistryBytes({
    url: dist.tarballUrl,
    ...(token ? { token } : {}),
    timeoutMs: spec.timeoutMs,
    accept: 'application/octet-stream',
    limit: MAX_TARBALL_BYTES,
    limitCode: 'invalid_manifest',
    label: 'NPM tarball for ' + packageLabel(spec),
  });
}

function parseIntegrityHashes(integrity: string): Array<{ algorithm: string; digest: Buffer }> {
  const hashes: Array<{ algorithm: string; digest: Buffer }> = [];
  for (const token of integrity.split(/\s+/u)) {
    if (!token) continue;
    const separator = token.indexOf('-');
    if (separator <= 0) continue;
    const algorithm = token.slice(0, separator).toLowerCase();
    const hashLength = HASH_LENGTHS[algorithm];
    if (!hashLength) continue;
    const digest = Buffer.from(token.slice(separator + 1).replace(/=+$/u, ''), 'base64');
    if (digest.length !== hashLength) continue;
    hashes.push({ algorithm, digest });
  }
  return hashes;
}

function verifyTarballIntegrity(tarball: Buffer, dist: DistributionMetadata, spec: NormalizedNpmRequest): void {
  const expected = parseIntegrityHashes(dist.integrity);
  if (!expected.length) {
    throw new HcExtensionError('invalid_manifest', 'dist.integrity for ' + packageLabel(spec) + ' is malformed or uses an unsupported hash algorithm (expected sha512)');
  }
  for (const { algorithm, digest } of expected) {
    const actual = createHash(algorithm).update(tarball).digest();
    if (actual.length === digest.length && timingSafeEqual(actual, digest)) return;
  }
  throw new HcExtensionError('invalid_manifest', 'integrity check failed for ' + packageLabel(spec) + ': the downloaded tarball does not match dist.integrity');
}

function decompressTarball(tarball: Buffer, spec: NormalizedNpmRequest): Buffer {
  try {
    return gunzipSync(tarball, { maxOutputLength: MAX_EXTRACTED_BYTES });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const detail = code === 'ERR_BUFFER_TOO_LARGE'
      ? 'tarball expands beyond the ' + MAX_EXTRACTED_BYTES + '-byte limit'
      : toErrorMessage(error);
    throw new HcExtensionError('invalid_manifest', 'Cannot decompress the npm tarball for ' + packageLabel(spec) + ': ' + detail);
  }
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function readTarNumber(block: Buffer, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length);
  const first = field.readUInt8(0);
  if ((first & 0x80) !== 0) {
    const negative = (first & 0x40) !== 0;
    let value = first & 0x3f;
    for (let index = 1; index < field.length; index += 1) value = value * 256 + field.readUInt8(index);
    if (negative) throw new HcExtensionError('invalid_manifest', 'npm tarball contains a negative numeric header field');
    return value;
  }
  const zero = field.indexOf(0);
  const text = field.subarray(0, zero === -1 ? field.length : zero).toString('ascii').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/u.test(text)) throw new HcExtensionError('invalid_manifest', 'npm tarball contains an invalid numeric header field');
  return Number.parseInt(text, 8);
}

function readTarString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  return field.subarray(0, zero === -1 ? field.length : zero).toString('utf8');
}

function readNullTerminated(payload: Buffer): string {
  const zero = payload.indexOf(0);
  return payload.subarray(0, zero === -1 ? payload.length : zero).toString('utf8');
}

function tarChecksumMatches(header: Buffer): boolean {
  let stored: number;
  try {
    stored = readTarNumber(header, 148, 8);
  } catch {
    return false;
  }
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header.readUInt8(index);
  }
  return sum === stored;
}

function alignTarSize(size: number): number {
  return Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
}

function parsePaxRecords(payload: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < payload.length) {
    if (payload.readUInt8(offset) === 0) {
      offset += 1;
      continue;
    }
    const space = payload.indexOf(0x20, offset);
    if (space < 0) throw new HcExtensionError('invalid_manifest', 'npm tarball contains a malformed PAX header');
    const recordLength = Number.parseInt(payload.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isInteger(recordLength) || recordLength <= 0 || offset + recordLength > payload.length) {
      throw new HcExtensionError('invalid_manifest', 'npm tarball contains a malformed PAX header');
    }
    const recordEnd = offset + recordLength;
    const text = payload.subarray(space + 1, recordEnd - 1).toString('utf8');
    const separator = text.indexOf('=');
    if (separator <= 0) throw new HcExtensionError('invalid_manifest', 'npm tarball contains a malformed PAX header');
    records[text.slice(0, separator)] = text.slice(separator + 1);
    offset = recordEnd;
  }
  return records;
}

function validateRelativeEntryPath(relativePath: string, originalName: string): string {
  if (!relativePath) throw new HcExtensionError('path_forbidden', 'npm tarball entry "' + originalName + '" has an empty path');
  if (relativePath.includes('\0')) throw new HcExtensionError('path_forbidden', 'npm tarball entry "' + originalName + '" contains a null byte');
  if (relativePath.includes('\\')) throw new HcExtensionError('path_forbidden', 'npm tarball entry "' + originalName + '" uses a Windows path separator');
  if (relativePath.startsWith('/')) throw new HcExtensionError('path_forbidden', 'npm tarball entry "' + originalName + '" is an absolute path');
  if (/^[A-Za-z]:/u.test(relativePath)) throw new HcExtensionError('path_forbidden', 'npm tarball entry "' + originalName + '" uses a Windows drive path');
  for (const segment of relativePath.split('/')) {
    if (!segment || segment === '.' || segment === '..') {
      throw new HcExtensionError('path_forbidden', 'npm tarball entry "' + originalName + '" contains an unsafe path segment');
    }
  }
  return relativePath;
}

function parsePackageTarball(tar: Buffer): PackageTarEntry[] {
  const entries: PackageTarEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let entryCount = 0;
  let totalFileBytes = 0;
  let pendingName: string | undefined;
  let paxOverrides: Record<string, string> = {};
  let globalOverrides: Record<string, string> = {};
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (isZeroBlock(header)) break;
    if (!tarChecksumMatches(header)) throw new HcExtensionError('invalid_manifest', 'npm tarball contains a corrupt tar header');
    const typeByte = header.readUInt8(156);
    const type = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    const headerSize = readTarNumber(header, 124, 12);
    if (!Number.isInteger(headerSize) || headerSize < 0) throw new HcExtensionError('invalid_manifest', 'npm tarball contains an invalid entry size');
    const dataStart = offset + TAR_BLOCK_SIZE;
    const headerDataEnd = dataStart + headerSize;
    if (headerDataEnd > tar.length) throw new HcExtensionError('invalid_manifest', 'npm tarball is truncated');
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      const payload = tar.subarray(dataStart, headerDataEnd);
      if (type === 'x') paxOverrides = parsePaxRecords(payload);
      else if (type === 'g') globalOverrides = { ...globalOverrides, ...parsePaxRecords(payload) };
      else if (type === 'L') pendingName = readNullTerminated(payload);
      offset = dataStart + alignTarSize(headerSize);
      continue;
    }
    let name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    if (prefix) name = prefix + '/' + name;
    if (pendingName !== undefined) name = pendingName;
    const overrides = { ...globalOverrides, ...paxOverrides };
    pendingName = undefined;
    paxOverrides = {};
    if (typeof overrides.path === 'string') name = overrides.path;
    let size = headerSize;
    if (typeof overrides.size === 'string') {
      const parsed = Number.parseInt(overrides.size, 10);
      if (!Number.isInteger(parsed) || parsed < 0) throw new HcExtensionError('invalid_manifest', 'npm tarball contains an invalid PAX size');
      size = parsed;
    }
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new HcExtensionError('invalid_manifest', 'npm tarball is truncated');
    entryCount += 1;
    if (entryCount > MAX_ENTRY_COUNT) {
      throw new HcExtensionError('invalid_manifest', 'npm package contains more than ' + MAX_ENTRY_COUNT + ' archive entries');
    }
    if (type === '1' || type === '2') {
      throw new HcExtensionError('path_forbidden', 'npm package contains a link entry ("' + name + '"); links are not allowed');
    }
    if (type === '3' || type === '4' || type === '6') {
      throw new HcExtensionError('path_forbidden', 'npm package contains a device entry ("' + name + '"); device entries are not allowed');
    }
    if (type !== '0' && type !== '5') {
      throw new HcExtensionError('invalid_manifest', 'npm package contains an unsupported archive entry type "' + type + '" ("' + name + '")');
    }
    const normalizedName = name.replace(/\/+$/u, '');
    if (normalizedName === PACKAGE_ROOT) {
      if (type !== '5') throw new HcExtensionError('invalid_manifest', 'npm tarball package root entry is not a directory');
      offset = dataStart + alignTarSize(size);
      continue;
    }
    if (!normalizedName.startsWith(PACKAGE_ROOT + '/')) {
      throw new HcExtensionError('path_forbidden', 'npm tarball entry "' + name + '" is outside the package/ root');
    }
    const relativePath = validateRelativeEntryPath(normalizedName.slice(PACKAGE_ROOT.length + 1), name);
    const duplicateKey = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
    if (seen.has(duplicateKey)) throw new HcExtensionError('invalid_manifest', 'npm package contains duplicate archive entry "' + name + '"');
    seen.add(duplicateKey);
    if (type === '5') {
      entries.push({ relPath: relativePath, kind: 'directory', size: 0 });
      offset = dataStart + alignTarSize(size);
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      throw new HcExtensionError('invalid_manifest', 'npm package file "' + relativePath + '" is larger than the ' + MAX_FILE_BYTES + '-byte per-file limit');
    }
    totalFileBytes += size;
    if (totalFileBytes > MAX_EXTRACTED_BYTES) {
      throw new HcExtensionError('invalid_manifest', 'npm package extracts to more than the ' + MAX_EXTRACTED_BYTES + '-byte install limit');
    }
    entries.push({ relPath: relativePath, kind: 'file', size, data: tar.subarray(dataStart, dataEnd) });
    offset = dataStart + alignTarSize(size);
  }
  if (!entries.length) throw new HcExtensionError('invalid_manifest', 'npm tarball contains no package files');
  return entries;
}

async function extractPackageTarball(tar: Buffer, stageDir: string): Promise<{ fileCount: number; totalFileBytes: number }> {
  const entries = parsePackageTarball(tar);
  const stageRoot = path.resolve(stageDir);
  let fileCount = 0;
  let totalFileBytes = 0;
  for (const entry of entries) {
    const destination = path.resolve(stageRoot, entry.relPath);
    if (destination === stageRoot || !destination.startsWith(stageRoot + path.sep)) {
      throw new HcExtensionError('path_forbidden', 'Refusing to extract npm tarball entry outside the staging folder: ' + entry.relPath);
    }
    if (entry.kind === 'directory') {
      await mkdir(destination, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.data ?? Buffer.alloc(0));
    fileCount += 1;
    totalFileBytes += entry.size;
  }
  return { fileCount, totalFileBytes };
}

async function readPackageRootJson(stageDir: string, fileName: 'package.json' | 'manifest.json'): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path.join(stageDir, fileName), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HcExtensionError('invalid_manifest', fileName + ' is required at the package root', fileName);
    }
    throw new HcExtensionError('internal_error', 'Cannot read ' + fileName + ': ' + toErrorMessage(error));
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
    throw new HcExtensionError('invalid_manifest', fileName + ' is larger than the ' + MAX_FILE_BYTES + '-byte install limit', fileName);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HcExtensionError('invalid_manifest', fileName + ' is not valid JSON', fileName);
  }
}

function isReservedExtensionId(id: string): boolean {
  return id.startsWith('hcanvas.') || id.startsWith('com.hadamard.');
}

async function readPackageContract(stageDir: string, spec: NormalizedNpmRequest): Promise<PackageContract> {
  const packageJson = await readPackageRootJson(stageDir, 'package.json');
  const rawManifest = await readPackageRootJson(stageDir, 'manifest.json');
  if (!isObject(packageJson)) throw new HcExtensionError('invalid_manifest', 'package.json must be a JSON object', 'package.json');
  if (!isObject(rawManifest)) throw new HcExtensionError('invalid_manifest', 'manifest.json must be a JSON object', 'manifest.json');
  const check = checkExtensionManifest(rawManifest);
  if (!check.ok || !check.manifest) {
    const messages = check.errors.map(issue => issue.message);
    throw new HcExtensionError('invalid_manifest', messages.join('; ') || 'invalid extension manifest', check.errors[0]?.path ?? 'manifest.json', messages);
  }
  const manifest = check.manifest;
  if (typeof packageJson.name !== 'string' || packageJson.name !== spec.packageName) {
    throw new HcExtensionError('invalid_manifest', 'package.json name ' + JSON.stringify(packageJson.name) + ' does not match the requested package "' + spec.packageName + '"', 'package.json');
  }
  if (typeof packageJson.version !== 'string') throw new HcExtensionError('invalid_manifest', 'package.json version must be a string', 'version');
  if (packageJson.version !== manifest.version) {
    throw new HcExtensionError('invalid_manifest', 'package.json version "' + packageJson.version + '" does not match manifest.version "' + manifest.version + '"', 'version');
  }
  if (packageJson.version !== spec.version) {
    throw new HcExtensionError('invalid_manifest', 'package.json version "' + packageJson.version + '" does not match the requested version "' + spec.version + '"', 'version');
  }
  const keywords = Array.isArray(packageJson.keywords) ? packageJson.keywords : [];
  if (!keywords.includes('hcanvas-extension')) {
    throw new HcExtensionError('invalid_manifest', 'package.json keywords must include "hcanvas-extension"', 'package.json.keywords');
  }
  if (manifest.builtin) throw new HcExtensionError('invalid_manifest', 'builtin extensions cannot be installed from npm', 'builtin');
  const compatible = engineRangeSatisfies(manifest.engines.hcanvas, HCANVAS_EXTENSION_TARGET_VERSION);
  if (compatible === false) {
    throw new HcExtensionError('incompatible', 'Extension "' + manifest.id + '" requires engines.hcanvas ' + manifest.engines.hcanvas + ', but this host is ' + HCANVAS_EXTENSION_TARGET_VERSION);
  }
  if (isReservedExtensionId(manifest.id) && !spec.packageName.startsWith('@hcanvas/')) {
    throw new HcExtensionError('invalid_manifest', 'extension id "' + manifest.id + '" uses a reserved Hcanvas namespace; only @hcanvas/* packages may publish it', 'id');
  }
  const warnings = check.warnings.map(issue => (issue.path ? issue.path + ': ' : '') + issue.message);
  let rootNames: string[] = [];
  try {
    rootNames = await readdir(stageDir);
  } catch {
    // The folder was just extracted; optional-file warnings are best effort.
  }
  if (!rootNames.some(name => README_PATTERN.test(name))) warnings.push('package has no README file at its root');
  const license = packageJson.license;
  const hasLicenseFile = rootNames.some(name => LICENSE_PATTERN.test(name));
  if (!hasLicenseFile && typeof license !== 'string' && !isObject(license)) {
    warnings.push('package has no LICENSE file or package.json license field');
  }
  return { manifest, warnings };
}

async function writeInstallProvenance(stageDir: string, provenance: HcExtensionInstallProvenance, spec: NormalizedNpmRequest): Promise<void> {
  try {
    await writeFile(path.join(stageDir, NPM_INSTALL_PROVENANCE_FILE), JSON.stringify(provenance, null, 2) + '\n', 'utf8');
  } catch (error) {
    throw new HcExtensionError('internal_error', 'Cannot write npm install provenance for ' + packageLabel(spec) + ': ' + toErrorMessage(error));
  }
}

async function restorePreviousVersion(target: string, backup: string): Promise<Error | undefined> {
  try {
    await rm(target, { recursive: true, force: true });
    await rename(backup, target);
    return undefined;
  } catch (error) {
    return new HcExtensionError(
      'internal_error',
      'failed to restore the previous extension version from ' + backup + '; the backup folder was kept: ' + toErrorMessage(error),
    );
  }
}

function combineInstallFailure(error: unknown, restoreFailure: Error | undefined): unknown {
  if (!restoreFailure) return error;
  const suffix = '; additionally the previous version could not be restored: ' + restoreFailure.message;
  if (error instanceof HcExtensionError) {
    return new HcExtensionError(error.code, error.message + suffix, error.path, [...error.details, restoreFailure.message]);
  }
  return new HcExtensionError('internal_error', toErrorMessage(error) + suffix);
}

/**
 * Install an exact NPM package version as an Hcanvas v2 extension.
 *
 * The package is downloaded, integrity-checked and extracted into a staging
 * folder inside the selected extension root. Only verified, self-contained
 * packages are handed to the shared loader; lifecycle scripts are never run.
 */

/**
 * Install a local .tgz package as an Hcanvas v2 extension.
 *
 * Development path only: no registry is contacted and no npm lifecycle scripts
 * run. The tarball is verified with the same safe parser/contract checks as the
 * registry installer, then installed through the shared loader.
 */
export async function installLocalTarballExtension(
  workspace: string,
  request: HcLocalTarballInstallRequest,
  options: HcExtensionLoaderOptions = {},
): Promise<HcNpmExtensionInstallResult> {
  if (!isObject(request) || request.source !== 'tarball') {
    throw new HcExtensionError('invalid_install_source', 'source must be "tarball"');
  }
  const rawPath = typeof request.path === 'string' ? request.path.trim() : '';
  if (!rawPath) throw new HcExtensionError('invalid_params', 'tarball path is required');
  const filePath = path.resolve(rawPath);
  const scope: 'workspace' | 'user' = request.scope === 'user' ? 'user' : 'workspace';
  const overwrite = request.overwrite === true;
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    throw new HcExtensionError('not_found', 'Cannot read local tarball ' + filePath + ': ' + toErrorMessage(error), filePath);
  }
  if (!info.isFile()) throw new HcExtensionError('invalid_params', 'local tarball path is not a file: ' + filePath, filePath);
  if (info.size > MAX_TARBALL_BYTES) throw new HcExtensionError('invalid_params', 'local tarball exceeds the ' + MAX_TARBALL_BYTES + '-byte limit', filePath);
  let tarball: Buffer;
  try {
    tarball = await readFile(filePath);
  } catch (error) {
    throw new HcExtensionError('not_found', 'Cannot read local tarball ' + filePath + ': ' + toErrorMessage(error), filePath);
  }
  const provisionalSpec: NormalizedNpmRequest = {
    packageName: 'local-package',
    version: '0.0.0',
    scope,
    overwrite,
    registry: pathToFileURL(path.dirname(filePath)).href,
    timeoutMs: normalizeTimeout(request.timeoutMs),
  };
  const tar = decompressTarball(tarball, provisionalSpec);
  const discoveryPaths = extensionDiscoveryPaths(workspace, options);
  const targetRoot = path.resolve(scope === 'user' ? discoveryPaths.userExtensions : discoveryPaths.workspaceExtensions);
  await mkdir(targetRoot, { recursive: true });
  const stageDir = path.resolve(targetRoot, '.install-' + randomUUID());
  if (!isInside(targetRoot, stageDir)) throw new HcExtensionError('path_forbidden', 'Refusing to stage the local package outside the extension root');
  let backupDir: string | undefined;
  try {
    await mkdir(stageDir, { recursive: true });
    const extracted = await extractPackageTarball(tar, stageDir);
    const packageJson = await readPackageRootJson(stageDir, 'package.json');
    if (!isObject(packageJson) || typeof packageJson.name !== 'string' || typeof packageJson.version !== 'string') {
      throw new HcExtensionError('invalid_manifest', 'package.json must declare a string name and version', 'package.json');
    }
    if (!isValidPackageName(packageJson.name)) throw new HcExtensionError('invalid_manifest', 'package.json name is not a valid npm package name', 'package.json');
    if (!EXACT_VERSION_PATTERN.test(packageJson.version)) throw new HcExtensionError('invalid_manifest', 'package.json version must be an exact semver version', 'package.json');
    const spec: NormalizedNpmRequest = { ...provisionalSpec, packageName: packageJson.name, version: packageJson.version };
    const contract = await readPackageContract(stageDir, spec);
    const target = path.resolve(targetRoot, contract.manifest.id);
    if (!isInside(targetRoot, target)) throw new HcExtensionError('path_forbidden', 'Unsafe extension id in local package: ' + contract.manifest.id);
    const targetExists = await exists(target);
    if (targetExists && !overwrite) {
      throw new HcExtensionError('conflict', 'Extension already installed: ' + contract.manifest.id + ' (pass overwrite:true to replace it)');
    }
    const provenance: HcExtensionInstallProvenance = {
      source: 'tarball',
      packageName: spec.packageName,
      version: spec.version,
      resolved: pathToFileURL(filePath).href,
      integrity: 'sha512-' + createHash('sha512').update(tarball).digest('base64'),
      registry: provisionalSpec.registry,
      installedAt: new Date().toISOString(),
    };
    if (targetExists) {
      backupDir = path.resolve(targetRoot, '.backup-' + randomUUID());
      await rename(target, backupDir);
    }
    try {
      await writeInstallProvenance(stageDir, provenance, spec);
      const result = await installExtension(workspace, { source: 'folder', path: stageDir, scope, overwrite: false }, options);
      const warnings = [...contract.warnings];
      if (extracted.fileCount === 0) warnings.push('local tarball contains no files');
      if (backupDir) {
        const previousVersion = backupDir;
        backupDir = undefined;
        await rm(previousVersion, { recursive: true, force: true }).catch(() => { warnings.push('could not remove the previous version backup: ' + previousVersion); });
      }
      return { ...result, provenance, warnings };
    } catch (error) {
      const restoreFailure = backupDir ? await restorePreviousVersion(target, backupDir) : undefined;
      throw combineInstallFailure(error, restoreFailure);
    }
  } catch (error) {
    if (error instanceof HcExtensionError) throw error;
    throw new HcExtensionError('internal_error', 'Cannot install local tarball ' + filePath + ': ' + toErrorMessage(error));
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function installNpmExtension(
  workspace: string,
  request: HcNpmExtensionInstallRequest,
  options: HcExtensionLoaderOptions = {},
): Promise<HcNpmExtensionInstallResult> {
  const spec = normalizeNpmRequest(request);
  assertOnline();
  const token = readAuthToken();
  const packument = await fetchPackument(spec, token);
  const versionMetadata = selectVersionMetadata(packument, spec);
  const dist = readDistributionMetadata(versionMetadata, spec);
  const tarball = await downloadTarball(dist, spec, token);
  verifyTarballIntegrity(tarball, dist, spec);
  const tar = decompressTarball(tarball, spec);

  const discoveryPaths = extensionDiscoveryPaths(workspace, options);
  const targetRoot = path.resolve(spec.scope === 'user' ? discoveryPaths.userExtensions : discoveryPaths.workspaceExtensions);
  await mkdir(targetRoot, { recursive: true });
  const stageDir = path.resolve(targetRoot, '.install-' + randomUUID());
  if (!isInside(targetRoot, stageDir)) throw new HcExtensionError('path_forbidden', 'Refusing to stage the npm package outside the extension root');

  let backupDir: string | undefined;
  try {
    await mkdir(stageDir, { recursive: true });
    const extracted = await extractPackageTarball(tar, stageDir);
    if (dist.unpackedSize !== undefined && extracted.totalFileBytes !== dist.unpackedSize) {
      throw new HcExtensionError(
        'invalid_manifest',
        'npm package ' + packageLabel(spec) + ' extracted ' + extracted.totalFileBytes + ' bytes but registry metadata declares unpackedSize ' + dist.unpackedSize,
      );
    }
    const contract = await readPackageContract(stageDir, spec);
    const target = path.resolve(targetRoot, contract.manifest.id);
    if (!isInside(targetRoot, target)) throw new HcExtensionError('path_forbidden', 'Unsafe extension id in npm package: ' + contract.manifest.id);
    const targetExists = await exists(target);
    if (targetExists && !spec.overwrite) {
      throw new HcExtensionError('conflict', 'Extension already installed: ' + contract.manifest.id + ' (pass overwrite:true to replace it)');
    }
    const provenance: HcExtensionInstallProvenance = {
      source: 'npm',
      packageName: spec.packageName,
      version: spec.version,
      resolved: dist.tarballUrl,
      integrity: dist.integrity,
      registry: spec.registry,
      installedAt: new Date().toISOString(),
    };
    if (targetExists) {
      backupDir = path.resolve(targetRoot, '.backup-' + randomUUID());
      await rename(target, backupDir);
    }
    try {
      await writeInstallProvenance(stageDir, provenance, spec);
      const result = await installExtension(workspace, { source: 'folder', path: stageDir, scope: spec.scope, overwrite: false }, options);
      const warnings = [...contract.warnings];
      if (backupDir) {
        const previousVersion = backupDir;
        backupDir = undefined;
        await rm(previousVersion, { recursive: true, force: true }).catch(() => {
          warnings.push('could not remove the previous version backup: ' + previousVersion);
        });
      }
      return { ...result, provenance, warnings };
    } catch (error) {
      const restoreFailure = backupDir ? await restorePreviousVersion(target, backupDir) : undefined;
      throw combineInstallFailure(error, restoreFailure);
    }
  } catch (error) {
    if (error instanceof HcExtensionError) throw error;
    throw new HcExtensionError('internal_error', 'Cannot install npm extension ' + packageLabel(spec) + ': ' + toErrorMessage(error));
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
