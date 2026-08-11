import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function signCanonical(value: unknown, privateKeyPem: string): string {
  return sign(null, Buffer.from(canonicalJson(value)), createPrivateKey(privateKeyPem))
    .toString('base64url');
}

export function verifyCanonical(
  value: unknown,
  signature: string,
  publicKeyPem: string,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonicalJson(value)),
      createPublicKey(publicKeyPem),
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

export function hmacProof(secret: string, value: unknown): string {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(canonicalJson(value))
    .digest('base64url');
}

export function equalProof(left: string, right: string): boolean {
  try {
    const leftBytes = Buffer.from(left, 'base64url');
    const rightBytes = Buffer.from(right, 'base64url');
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } catch {
    return false;
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Canonical JSON does not support non-finite numbers.');
  }
  return value;
}
