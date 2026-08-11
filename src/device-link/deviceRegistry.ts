import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonAtomic } from '../storage/atomicJsonWrite.js';
import { normalizeFingerprint } from './identity.js';
import type { DeviceLinkScope, PairedDevice } from './types.js';
import { DEVICE_LINK_SCOPES } from './types.js';

interface RegistryDocument {
  schemaVersion: 1;
  devices: PairedDevice[];
}

export class PairedDeviceRegistry {
  private queue = Promise.resolve();

  constructor(private readonly file: string) {}

  async list(): Promise<PairedDevice[]> {
    return (await this.read()).devices.map(cloneDevice);
  }

  async get(deviceId: string): Promise<PairedDevice | undefined> {
    return (await this.read()).devices.find(device => device.deviceId === deviceId);
  }

  async pair(device: Omit<PairedDevice, 'lastSequence' | 'recentNonces'>): Promise<PairedDevice> {
    return this.serial(async () => {
      const document = await this.read();
      const existing = document.devices.find(item => item.deviceId === device.deviceId);
      if (existing && existing.publicKeyPem !== device.publicKeyPem) {
        throw new Error('Paired device identity key changed. Revoke it before pairing again.');
      }
      const normalized: PairedDevice = {
        ...device,
        certificateFingerprint: normalizeFingerprint(device.certificateFingerprint),
        scopes: normalizeScopes(device.scopes),
        lastSequence: existing?.lastSequence ?? 0,
        recentNonces: existing?.recentNonces ?? [],
      };
      document.devices = document.devices.filter(item => item.deviceId !== device.deviceId);
      document.devices.push(normalized);
      await this.write(document);
      return cloneDevice(normalized);
    });
  }

  async authorizeReplay(
    deviceId: string,
    sequence: number,
    nonceDigest: string,
    nonceExpiresAt: string,
    seenAt: string,
  ): Promise<PairedDevice> {
    return this.serial(async () => {
      const document = await this.read();
      const device = document.devices.find(item => item.deviceId === deviceId);
      if (!device || device.revokedAt) throw new Error('Device is not paired or has been revoked.');
      const now = Date.parse(seenAt);
      device.recentNonces = device.recentNonces.filter(item => Date.parse(item.expiresAt) > now);
      if (sequence <= device.lastSequence) throw new Error('Device request sequence was replayed.');
      if (device.recentNonces.some(item => item.digest === nonceDigest)) {
        throw new Error('Device request nonce was replayed.');
      }
      device.lastSequence = sequence;
      device.lastSeenAt = seenAt;
      device.updatedAt = seenAt;
      device.recentNonces.push({ digest: nonceDigest, expiresAt: nonceExpiresAt });
      await this.write(document);
      return cloneDevice(device);
    });
  }

  async updateScopes(deviceId: string, scopes: DeviceLinkScope[]): Promise<PairedDevice> {
    return this.mutate(deviceId, device => {
      device.scopes = normalizeScopes(scopes);
      device.updatedAt = new Date().toISOString();
    });
  }

  async revoke(deviceId: string): Promise<PairedDevice> {
    return this.mutate(deviceId, device => {
      device.revokedAt = new Date().toISOString();
      device.updatedAt = device.revokedAt;
    });
  }

  private async mutate(
    deviceId: string,
    mutate: (device: PairedDevice) => void,
  ): Promise<PairedDevice> {
    return this.serial(async () => {
      const document = await this.read();
      const device = document.devices.find(item => item.deviceId === deviceId);
      if (!device) throw new Error(`Paired device not found: ${deviceId}`);
      mutate(device);
      await this.write(document);
      return cloneDevice(device);
    });
  }

  private async read(): Promise<RegistryDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as RegistryDocument;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.devices)) {
        throw new Error('Paired device registry is invalid.');
      }
      return {
        schemaVersion: 1,
        devices: parsed.devices.map(parseDevice),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, devices: [] };
      }
      throw error;
    }
  }

  private async write(document: RegistryDocument): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(this.file, document);
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function parseDevice(value: unknown): PairedDevice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Paired device record is invalid.');
  }
  const record = value as Partial<PairedDevice>;
  if (typeof record.deviceId !== 'string'
    || typeof record.name !== 'string'
    || typeof record.publicKeyPem !== 'string'
    || typeof record.certificateFingerprint !== 'string'
    || !Array.isArray(record.scopes)
    || typeof record.pairedAt !== 'string'
    || typeof record.updatedAt !== 'string'
    || typeof record.lastSequence !== 'number'
    || !Array.isArray(record.recentNonces)) {
    throw new Error('Paired device record is invalid.');
  }
  return {
    ...record as PairedDevice,
    certificateFingerprint: normalizeFingerprint(record.certificateFingerprint),
    scopes: normalizeScopes(record.scopes as DeviceLinkScope[]),
    recentNonces: record.recentNonces.filter(item => item
      && typeof item.digest === 'string'
      && typeof item.expiresAt === 'string'),
  };
}

function normalizeScopes(scopes: readonly DeviceLinkScope[]): DeviceLinkScope[] {
  const allowed = new Set<string>(DEVICE_LINK_SCOPES);
  const normalized = [...new Set(scopes)];
  if (!normalized.every(scope => allowed.has(scope))) throw new Error('Unknown Device Link scope.');
  return normalized.sort();
}

function cloneDevice(device: PairedDevice): PairedDevice {
  return structuredClone(device);
}
