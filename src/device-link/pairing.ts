import { createPublicKey, randomBytes, randomInt } from 'node:crypto';

import QRCode from 'qrcode';

import { equalProof, hmacProof, sha256, signCanonical, verifyCanonical } from './crypto.js';
import { normalizeFingerprint } from './identity.js';
import type { PairedDeviceRegistry } from './deviceRegistry.js';
import {
  DEVICE_LINK_SCOPES,
  type DeviceIdentityCredentials,
  type DeviceLinkScope,
  type PairingCompletion,
  type PairingOffer,
  type PairingResult,
} from './types.js';

interface PendingPairing {
  offer: PairingOffer;
  attempts: number;
}

export interface BeginPairingOptions {
  address: string;
  port: number;
  offeredScopes?: DeviceLinkScope[];
  ttlMs?: number;
}

export class DevicePairingService {
  private readonly pending = new Map<string, PendingPairing>();

  constructor(
    private readonly identity: DeviceIdentityCredentials,
    private readonly registry: PairedDeviceRegistry,
  ) {}

  begin(options: BeginPairingOptions): PairingOffer {
    const address = options.address.trim();
    if (!address || /[\u0000-\u001f\s]/u.test(address)) throw new Error('Pairing address is invalid.');
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new Error('Pairing port is invalid.');
    }
    this.pruneExpired();
    const challengeId = randomBytes(18).toString('base64url');
    const challengeSecret = randomBytes(32).toString('base64url');
    const confirmationCode = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const unsigned = {
      schemaVersion: 1 as const,
      deviceId: this.identity.deviceId,
      deviceName: this.identity.name,
      address,
      port: options.port,
      protocolVersion: 2 as const,
      challengeId,
      challengeSecret,
      confirmationCode,
      identityPublicKeyPem: this.identity.publicKeyPem,
      certificateFingerprint: this.identity.certificateFingerprint,
      offeredScopes: normalizeScopes(options.offeredScopes ?? ['session:browse']),
      expiresAt: new Date(Date.now() + clampTtl(options.ttlMs)).toISOString(),
    };
    const offer: PairingOffer = {
      ...unsigned,
      signature: signCanonical(unsigned, this.identity.privateKeyPem),
    };
    this.pending.set(challengeId, { offer, attempts: 0 });
    return structuredClone(offer);
  }

  async qrDataUrl(offer: PairingOffer): Promise<string> {
    return QRCode.toDataURL(pairingUri(offer), {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
    });
  }

  async complete(completion: PairingCompletion): Promise<PairingResult> {
    this.pruneExpired();
    const pending = this.pending.get(completion.challengeId);
    if (!pending) throw new Error('Pairing challenge is missing, expired, or already used.');
    pending.attempts += 1;
    if (pending.attempts > 5) {
      this.pending.delete(completion.challengeId);
      throw new Error('Pairing challenge attempt limit exceeded.');
    }
    const offer = pending.offer;
    if (completion.confirmationCode !== offer.confirmationCode) {
      throw new Error('Pairing confirmation code does not match.');
    }
    const unsignedCompletion = completionPayload(completion);
    const expectedProof = hmacProof(offer.challengeSecret, unsignedCompletion);
    if (!equalProof(expectedProof, completion.challengeProof)) {
      throw new Error('Pairing challenge proof is invalid.');
    }
    if (!verifyCanonical(
      { ...unsignedCompletion, challengeProof: completion.challengeProof },
      completion.signature,
      completion.publicKeyPem,
    )) {
      throw new Error('Pairing device signature is invalid.');
    }
    const normalizedPublicKey = createPublicKey(completion.publicKeyPem)
      .export({ type: 'spki', format: 'pem' }).toString();
    const expectedDeviceId = `device-${sha256(normalizedPublicKey).slice(0, 32)}`;
    if (completion.deviceId !== expectedDeviceId) {
      throw new Error('Pairing device id does not match its public key.');
    }
    const now = new Date().toISOString();
    const offered = new Set(offer.offeredScopes);
    const scopes = normalizeScopes(completion.requestedScopes).filter(scope => offered.has(scope));
    this.pending.delete(completion.challengeId);
    const device = await this.registry.pair({
      deviceId: completion.deviceId,
      name: normalizeName(completion.deviceName),
      publicKeyPem: normalizedPublicKey,
      certificateFingerprint: normalizeFingerprint(completion.certificateFingerprint),
      scopes,
      pairedAt: now,
      updatedAt: now,
    });
    return {
      device,
      serverSignature: signCanonical({
        challengeId: completion.challengeId,
        serverDeviceId: this.identity.deviceId,
        pairedDeviceId: device.deviceId,
        scopes,
        pairedAt: now,
      }, this.identity.privateKeyPem),
    };
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, pending] of this.pending) {
      if (Date.parse(pending.offer.expiresAt) <= now) this.pending.delete(id);
    }
  }
}

export function createPairingCompletion(
  offer: PairingOffer,
  device: DeviceIdentityCredentials,
  requestedScopes: DeviceLinkScope[],
): PairingCompletion {
  if (!verifyPairingOffer(offer)) throw new Error('Pairing offer signature is invalid.');
  const unsigned = {
    challengeId: offer.challengeId,
    confirmationCode: offer.confirmationCode,
    deviceId: device.deviceId,
    deviceName: device.name,
    publicKeyPem: device.publicKeyPem,
    certificateFingerprint: device.certificateFingerprint,
    requestedScopes: normalizeScopes(requestedScopes),
  };
  const challengeProof = hmacProof(offer.challengeSecret, unsigned);
  return {
    ...unsigned,
    challengeProof,
    signature: signCanonical({ ...unsigned, challengeProof }, device.privateKeyPem),
  };
}

export function verifyPairingOffer(offer: PairingOffer): boolean {
  const { signature, ...unsigned } = offer;
  return Date.parse(offer.expiresAt) > Date.now()
    && verifyCanonical(unsigned, signature, offer.identityPublicKeyPem);
}

export function pairingUri(offer: PairingOffer): string {
  return `hadamard://pair?data=${Buffer.from(JSON.stringify(offer)).toString('base64url')}`;
}

function completionPayload(completion: PairingCompletion) {
  return {
    challengeId: completion.challengeId,
    confirmationCode: completion.confirmationCode,
    deviceId: completion.deviceId,
    deviceName: completion.deviceName,
    publicKeyPem: completion.publicKeyPem,
    certificateFingerprint: completion.certificateFingerprint,
    requestedScopes: normalizeScopes(completion.requestedScopes),
  };
}

function normalizeScopes(scopes: readonly DeviceLinkScope[]): DeviceLinkScope[] {
  const known = new Set<string>(DEVICE_LINK_SCOPES);
  const normalized = [...new Set(scopes)];
  if (!normalized.every(scope => known.has(scope))) throw new Error('Unknown Device Link scope.');
  return normalized.sort();
}

function normalizeName(value: string): string {
  const name = value.trim().replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 80);
  if (!name) throw new Error('Pairing device name is required.');
  return name;
}

function clampTtl(value = 5 * 60_000): number {
  return Math.max(30_000, Math.min(value, 10 * 60_000));
}
