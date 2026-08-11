import type { AppServerRequestV2 } from '../app-server/protocol.js';

export const DEVICE_LINK_SERVICE_TYPE = '_hadamard._tcp.local' as const;

export const DEVICE_LINK_SCOPES = [
  'session:browse',
  'session:send',
  'approval:respond',
  'file:transfer',
  'microphone',
  'audio:live',
] as const;

export type DeviceLinkScope = typeof DEVICE_LINK_SCOPES[number];

export interface DeviceIdentity {
  deviceId: string;
  name: string;
  publicKeyPem: string;
  certificateFingerprint: string;
  createdAt: string;
}

export interface DeviceIdentityCredentials extends DeviceIdentity {
  privateKeyPem: string;
  tlsPrivateKeyPem: string;
  tlsCertificatePem: string;
}

export interface PairedDevice {
  deviceId: string;
  name: string;
  publicKeyPem: string;
  certificateFingerprint: string;
  scopes: DeviceLinkScope[];
  pairedAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  lastSequence: number;
  recentNonces: Array<{ digest: string; expiresAt: string }>;
}

export interface PairingOffer {
  schemaVersion: 1;
  deviceId: string;
  deviceName: string;
  address: string;
  port: number;
  protocolVersion: 2;
  challengeId: string;
  challengeSecret: string;
  confirmationCode: string;
  identityPublicKeyPem: string;
  certificateFingerprint: string;
  offeredScopes: DeviceLinkScope[];
  expiresAt: string;
  signature: string;
}

export interface PairingCompletion {
  challengeId: string;
  challengeProof: string;
  confirmationCode: string;
  deviceId: string;
  deviceName: string;
  publicKeyPem: string;
  certificateFingerprint: string;
  requestedScopes: DeviceLinkScope[];
  signature: string;
}

export interface PairingResult {
  device: PairedDevice;
  serverSignature: string;
}

export interface DeviceLinkRequestAuth {
  [key: string]: unknown;
  deviceId: string;
  sequence: number;
  nonce: string;
  issuedAt: string;
  signature: string;
}

export interface SignedDeviceLinkRequest extends AppServerRequestV2 {
  auth: DeviceLinkRequestAuth;
}

export interface DeviceLinkConnectionContext {
  certificateFingerprint?: string;
  peerUnlocked: boolean;
  remoteAddress?: string;
}

export interface DeviceLinkAuditRecord {
  auditId: string;
  timestamp: string;
  deviceId?: string;
  remoteAddress?: string;
  requestId: string;
  method: string;
  outcome: 'allowed' | 'denied' | 'error';
  reason?: string;
  requestSha256: string;
}

export interface DeviceLinkDiagnostics {
  state: 'stopped' | 'starting' | 'listening' | 'error';
  url?: string;
  bindAddress?: string;
  port?: number;
  discovery: 'stopped' | 'advertising' | 'error';
  pairedDevices: number;
  lastError?: string;
}

export interface DiscoveredDevice {
  deviceId: string;
  name: string;
  host: string;
  port: number;
  certificateFingerprint: string;
  protocolVersion: 2;
  lastSeenAt: string;
}

export interface DeviceLinkServerLimits {
  maxClockSkewMs: number;
  maxRequestsPerMinute: number;
  maxRequestBytes: number;
}

export const DEFAULT_DEVICE_LINK_LIMITS: DeviceLinkServerLimits = {
  maxClockSkewMs: 120_000,
  maxRequestsPerMinute: 120,
  maxRequestBytes: 1_048_576,
};
