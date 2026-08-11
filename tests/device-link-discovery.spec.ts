import { describe, expect, it } from 'vitest';

import {
  advertisementAnswers,
  discoveredDevicesFromRecords,
  type DeviceIdentity,
} from '../src/device-link/index.js';

describe('Device Link DNS-SD discovery', () => {
  it('advertises and parses interoperable PTR, SRV, TXT, and address records', () => {
    const identity: DeviceIdentity = {
      deviceId: 'device-0123456789abcdef0123456789abcdef',
      name: 'Lab Desktop',
      publicKeyPem: 'public',
      certificateFingerprint: 'a'.repeat(64),
      createdAt: '2026-08-12T00:00:00.000Z',
    };
    const records = advertisementAnswers({
      identity,
      host: identity.deviceId,
      address: '192.168.1.25',
      port: 43100,
    });
    expect(records.map(record => record.type)).toEqual(['PTR', 'SRV', 'TXT', 'A']);
    expect(discoveredDevicesFromRecords(records)).toEqual([{
      deviceId: identity.deviceId,
      name: identity.name,
      host: '192.168.1.25',
      port: 43100,
      certificateFingerprint: identity.certificateFingerprint,
      protocolVersion: 2,
      lastSeenAt: expect.any(String),
    }]);
  });
});
