import { describe, expect, it } from 'vitest';

import { CredentialPool, type CredentialHealth, type ManagedCredential } from '../src/keyway/vendor/core/index.js';

const now = '2026-08-25T00:00:00.000Z';

function credential(id: string, priority: number, createdAt = now): ManagedCredential {
  return {
    id,
    providerId: 'ark',
    secretRef: `secret:${id}`,
    label: id,
    priority,
    weight: 1,
    enabled: true,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('CredentialPool', () => {
  it('round-robins only inside the lowest healthy priority band', () => {
    const pool = new CredentialPool();
    const values = [
      credential('later-priority', 1),
      credential('primary-a', 0, '2026-08-24T00:00:00.000Z'),
      credential('primary-b', 0, '2026-08-25T00:00:00.000Z'),
    ];
    const health = new Map<string, CredentialHealth>();
    expect(pool.select('ark', values, health)?.id).toBe('primary-a');
    expect(pool.select('ark', values, health)?.id).toBe('primary-b');
    expect(pool.select('ark', values, health)?.id).toBe('primary-a');
  });

  it('skips disabled and open-circuit credentials', () => {
    const pool = new CredentialPool();
    const disabled = { ...credential('disabled', 0), enabled: false };
    const open = credential('open', 0);
    const fallback = credential('fallback', 1);
    const health = new Map<string, CredentialHealth>([[open.id, {
      credentialId: open.id,
      state: 'circuit-open',
      consecutiveFailures: 3,
      circuitOpenUntil: '2026-08-25T00:01:00.000Z',
    }]]);
    expect(pool.select('ark', [disabled, open, fallback], health, new Date(now))?.id).toBe('fallback');
  });

  it('allows a credential after its circuit-open interval expires', () => {
    const pool = new CredentialPool();
    const value = credential('half-open', 0);
    const health = new Map<string, CredentialHealth>([[value.id, {
      credentialId: value.id,
      state: 'circuit-open',
      consecutiveFailures: 3,
      circuitOpenUntil: '2026-08-24T23:59:59.000Z',
    }]]);
    expect(pool.select('ark', [value], health, new Date(now))?.id).toBe(value.id);
  });
});
