import { generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { generate } from 'selfsigned';

import { writeJsonAtomic } from '../storage/atomicJsonWrite.js';
import { sha256 } from './crypto.js';
import type { DeviceIdentity, DeviceIdentityCredentials } from './types.js';

const IDENTITY_SCHEMA_VERSION = 1;

interface StoredIdentity extends DeviceIdentityCredentials {
  schemaVersion: 1;
}

export class DeviceIdentityStore {
  private readonly file: string;

  constructor(private readonly directory: string) {
    this.file = path.join(directory, 'identity.json');
  }

  async loadOrCreate(name = defaultDeviceName()): Promise<DeviceIdentityCredentials> {
    try {
      return parseIdentity(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return this.create(name);
  }

  async publicIdentity(name?: string): Promise<DeviceIdentity> {
    const credentials = await this.loadOrCreate(name);
    return withoutSecrets(credentials);
  }

  private async create(name: string): Promise<DeviceIdentityCredentials> {
    const signing = generateKeyPairSync('ed25519');
    const publicKeyPem = signing.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = signing.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const deviceId = `device-${sha256(publicKeyPem).slice(0, 32)}`;
    const tls = await generate([{ name: 'commonName', value: deviceId }], {
      algorithm: 'sha256',
      keySize: 2048,
      notAfterDate: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
            { type: 7, ip: '::1' },
          ],
        },
      ],
    });
    const stored: StoredIdentity = {
      schemaVersion: IDENTITY_SCHEMA_VERSION,
      deviceId,
      name: normalizeDeviceName(name),
      publicKeyPem,
      privateKeyPem,
      tlsPrivateKeyPem: tls.private,
      tlsCertificatePem: tls.cert,
      certificateFingerprint: normalizeFingerprint(new X509Certificate(tls.cert).fingerprint256),
      createdAt: new Date().toISOString(),
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(this.file, stored);
    await chmod(this.file, 0o600).catch(() => undefined);
    return parseIdentity(stored);
  }
}

export function withoutSecrets(credentials: DeviceIdentityCredentials): DeviceIdentity {
  return {
    deviceId: credentials.deviceId,
    name: credentials.name,
    publicKeyPem: credentials.publicKeyPem,
    certificateFingerprint: credentials.certificateFingerprint,
    createdAt: credentials.createdAt,
  };
}

export function normalizeFingerprint(value: string): string {
  const fingerprint = value.replace(/:/gu, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) {
    throw new Error('Device certificate fingerprint must be SHA-256.');
  }
  return fingerprint;
}

function parseIdentity(value: unknown): DeviceIdentityCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Device identity file is invalid.');
  }
  const record = value as Partial<StoredIdentity>;
  if (record.schemaVersion !== IDENTITY_SCHEMA_VERSION
    || typeof record.deviceId !== 'string'
    || typeof record.name !== 'string'
    || typeof record.publicKeyPem !== 'string'
    || typeof record.privateKeyPem !== 'string'
    || typeof record.tlsPrivateKeyPem !== 'string'
    || typeof record.tlsCertificatePem !== 'string'
    || typeof record.certificateFingerprint !== 'string'
    || typeof record.createdAt !== 'string') {
    throw new Error('Device identity file is invalid.');
  }
  const expectedDeviceId = `device-${sha256(record.publicKeyPem).slice(0, 32)}`;
  if (record.deviceId !== expectedDeviceId) throw new Error('Device identity public key changed.');
  const certificateFingerprint = normalizeFingerprint(
    new X509Certificate(record.tlsCertificatePem).fingerprint256,
  );
  if (certificateFingerprint !== normalizeFingerprint(record.certificateFingerprint)) {
    throw new Error('Device identity certificate changed.');
  }
  return {
    deviceId: record.deviceId,
    name: normalizeDeviceName(record.name),
    publicKeyPem: record.publicKeyPem,
    privateKeyPem: record.privateKeyPem,
    tlsPrivateKeyPem: record.tlsPrivateKeyPem,
    tlsCertificatePem: record.tlsCertificatePem,
    certificateFingerprint,
    createdAt: record.createdAt,
  };
}

function normalizeDeviceName(value: string): string {
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 80);
  if (!normalized) throw new Error('Device name is required.');
  return normalized;
}

function defaultDeviceName(): string {
  return `${process.platform}-${randomBytes(3).toString('hex')}`;
}
