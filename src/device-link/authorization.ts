import { randomBytes, randomUUID } from 'node:crypto';

import type { AppServerRequestV2 } from '../app-server/protocol.js';
import { canonicalJson, sha256, signCanonical, verifyCanonical } from './crypto.js';
import type { DeviceLinkAuditStore } from './auditStore.js';
import type { PairedDeviceRegistry } from './deviceRegistry.js';
import { normalizeFingerprint } from './identity.js';
import type {
  DeviceIdentityCredentials,
  DeviceLinkConnectionContext,
  DeviceLinkRequestAuth,
  DeviceLinkScope,
  DeviceLinkServerLimits,
  PairedDevice,
  SignedDeviceLinkRequest,
} from './types.js';
import { DEFAULT_DEVICE_LINK_LIMITS } from './types.js';

const PUBLIC_METHODS = new Set(['initialize', 'pair/complete']);

const METHOD_SCOPES: ReadonlyArray<[RegExp, DeviceLinkScope]> = [
  [/^(capability\/list|session\/(list|tree|open|snapshot|items|close))$/u, 'session:browse'],
  [/^(session\/(create|send|copy)|diff\/|checkpoint\/|goal\/)/u, 'session:send'],
  [/^approval\//u, 'approval:respond'],
  [/^(artifact\/|workspace\/inbox\/)/u, 'file:transfer'],
  [/^audio\/note\//u, 'microphone'],
  [/^audio\/live\//u, 'audio:live'],
];

export class DeviceLinkAuthorizationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DeviceLinkAuthorizationError';
  }
}

export class DeviceLinkAuthorizationService {
  private readonly rateLimiter: SlidingWindowRateLimiter;

  constructor(
    private readonly localIdentity: DeviceIdentityCredentials,
    private readonly registry: PairedDeviceRegistry,
    private readonly audit: DeviceLinkAuditStore,
    private readonly limits: DeviceLinkServerLimits = DEFAULT_DEVICE_LINK_LIMITS,
  ) {
    this.rateLimiter = new SlidingWindowRateLimiter(limits.maxRequestsPerMinute);
  }

  isPublic(method: string): boolean {
    return PUBLIC_METHODS.has(method);
  }

  async authorize(
    request: AppServerRequestV2,
    context: DeviceLinkConnectionContext,
  ): Promise<PairedDevice | undefined> {
    const requestSha256 = sha256(canonicalJson(request));
    if (this.isPublic(request.method)) return undefined;
    let deviceId: string | undefined;
    try {
      const signed = requireSignedRequest(request);
      deviceId = signed.auth.deviceId;
      if (Buffer.byteLength(canonicalJson(request), 'utf8') > this.limits.maxRequestBytes) {
        throw new DeviceLinkAuthorizationError('REQUEST_TOO_LARGE', 'Device Link request is too large.');
      }
      const device = await this.registry.get(deviceId);
      if (!device || device.revokedAt) {
        throw new DeviceLinkAuthorizationError('DEVICE_NOT_PAIRED', 'Device is not paired or has been revoked.');
      }
      const peerFingerprint = context.certificateFingerprint
        ? normalizeFingerprint(context.certificateFingerprint)
        : undefined;
      if (!peerFingerprint || peerFingerprint !== device.certificateFingerprint) {
        throw new DeviceLinkAuthorizationError('CERTIFICATE_MISMATCH', 'Pinned device certificate does not match.');
      }
      const issuedAt = Date.parse(signed.auth.issuedAt);
      if (!Number.isFinite(issuedAt)
        || Math.abs(Date.now() - issuedAt) > this.limits.maxClockSkewMs) {
        throw new DeviceLinkAuthorizationError('CLOCK_SKEW', 'Device request is outside the allowed clock window.');
      }
      if (!Number.isSafeInteger(signed.auth.sequence) || signed.auth.sequence <= 0) {
        throw new DeviceLinkAuthorizationError('INVALID_SEQUENCE', 'Device request sequence is invalid.');
      }
      if (!/^[A-Za-z0-9_-]{22,128}$/u.test(signed.auth.nonce)) {
        throw new DeviceLinkAuthorizationError('INVALID_NONCE', 'Device request nonce is invalid.');
      }
      const requiredScope = scopeForMethod(request.method);
      if (!requiredScope || !device.scopes.includes(requiredScope)) {
        throw new DeviceLinkAuthorizationError('SCOPE_DENIED', `Device lacks scope for ${request.method}.`);
      }
      if (!verifyCanonical(signaturePayload(signed), signed.auth.signature, device.publicKeyPem)) {
        throw new DeviceLinkAuthorizationError('INVALID_SIGNATURE', 'Device request signature is invalid.');
      }
      if (!this.rateLimiter.take(deviceId, Date.now())) {
        throw new DeviceLinkAuthorizationError('RATE_LIMITED', 'Device request rate limit exceeded.');
      }
      if (request.method === 'approval/remember') {
        validateRemoteApproval(request, context, this.localIdentity.deviceId, deviceId);
      }
      const seenAt = new Date().toISOString();
      const authorized = await this.registry.authorizeReplay(
        deviceId,
        signed.auth.sequence,
        sha256(signed.auth.nonce),
        new Date(Date.now() + this.limits.maxClockSkewMs * 2).toISOString(),
        seenAt,
      );
      await this.audit.append({
        auditId: randomUUID(),
        timestamp: seenAt,
        deviceId,
        remoteAddress: context.remoteAddress,
        requestId: request.id,
        method: request.method,
        outcome: 'allowed',
        requestSha256,
      });
      return authorized;
    } catch (error) {
      await this.audit.append({
        auditId: randomUUID(),
        timestamp: new Date().toISOString(),
        ...(deviceId ? { deviceId } : {}),
        remoteAddress: context.remoteAddress,
        requestId: request.id,
        method: request.method,
        outcome: 'denied',
        reason: error instanceof Error ? error.message : String(error),
        requestSha256,
      });
      throw error;
    }
  }
}

export function createSignedDeviceLinkRequest(
  request: Omit<AppServerRequestV2, 'auth'>,
  identity: DeviceIdentityCredentials,
  sequence: number,
  issuedAt = new Date().toISOString(),
): SignedDeviceLinkRequest {
  const authWithoutSignature = {
    deviceId: identity.deviceId,
    sequence,
    nonce: randomBytes(24).toString('base64url'),
    issuedAt,
  };
  return {
    ...request,
    auth: {
      ...authWithoutSignature,
      signature: signCanonical({ ...request, auth: authWithoutSignature }, identity.privateKeyPem),
    },
  };
}

function requireSignedRequest(request: AppServerRequestV2): SignedDeviceLinkRequest {
  const auth = request.auth as Partial<DeviceLinkRequestAuth> | undefined;
  if (!auth
    || typeof auth.deviceId !== 'string'
    || typeof auth.sequence !== 'number'
    || typeof auth.nonce !== 'string'
    || typeof auth.issuedAt !== 'string'
    || typeof auth.signature !== 'string') {
    throw new DeviceLinkAuthorizationError('AUTH_REQUIRED', 'Signed Device Link authentication is required.');
  }
  return request as SignedDeviceLinkRequest;
}

function signaturePayload(request: SignedDeviceLinkRequest): unknown {
  const { signature: _signature, ...auth } = request.auth;
  return {
    version: request.version,
    id: request.id,
    method: request.method,
    params: request.params,
    auth,
  };
}

function scopeForMethod(method: string): DeviceLinkScope | undefined {
  return METHOD_SCOPES.find(([pattern]) => pattern.test(method))?.[1];
}

function validateRemoteApproval(
  request: AppServerRequestV2,
  context: DeviceLinkConnectionContext,
  targetDeviceId: string,
  requestingDeviceId: string,
): void {
  if (!context.peerUnlocked) {
    throw new DeviceLinkAuthorizationError('DEVICE_LOCKED', 'Remote approval requires an unlocked peer.');
  }
  const params = request.params ?? {};
  const remote = asRecord(params.remoteContext, 'remoteContext');
  const approval = asRecord(params.approval, 'approval');
  if (remote.targetDeviceId !== targetDeviceId
    || remote.requestingDeviceId !== requestingDeviceId
    || remote.foregroundConfirmed !== true
    || typeof remote.workspaceId !== 'string'
    || !remote.workspaceId.trim()
    || typeof remote.tool !== 'string'
    || remote.tool !== approval.tool
    || typeof remote.parametersSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(remote.parametersSha256)
    || remote.parametersSha256 !== sha256(canonicalJson(approval))) {
    throw new DeviceLinkAuthorizationError(
      'APPROVAL_CONTEXT_INVALID',
      'Remote approval is not bound to the target device, workspace, tool, and parameters.',
    );
  }
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeviceLinkAuthorizationError('APPROVAL_CONTEXT_INVALID', `${name} is required.`);
  }
  return value as Record<string, unknown>;
}

class SlidingWindowRateLimiter {
  private readonly requests = new Map<string, number[]>();

  constructor(private readonly limit: number) {}

  take(key: string, now: number): boolean {
    const start = now - 60_000;
    const recent = (this.requests.get(key) ?? []).filter(timestamp => timestamp > start);
    if (recent.length >= this.limit) {
      this.requests.set(key, recent);
      return false;
    }
    recent.push(now);
    this.requests.set(key, recent);
    return true;
  }
}
