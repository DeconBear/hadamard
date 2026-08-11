import { isIP } from 'node:net';

import createMdns from 'multicast-dns';
import type { Answer } from 'dns-packet';

import { normalizeFingerprint } from './identity.js';
import {
  DEVICE_LINK_SERVICE_TYPE,
  type DeviceIdentity,
  type DiscoveredDevice,
} from './types.js';

export interface MdnsAdvertisement {
  identity: DeviceIdentity;
  host: string;
  address: string;
  port: number;
}

export interface MdnsAnswer {
  name: string;
  type: string;
  ttl?: number;
  data?: unknown;
}

export interface DeviceDiscoveryPort {
  startAdvertising(advertisement: MdnsAdvertisement): Promise<void>;
  discover(timeoutMs?: number): Promise<DiscoveredDevice[]>;
  stop(): Promise<void>;
}

export class MdnsDeviceDiscovery implements DeviceDiscoveryPort {
  private instance?: ReturnType<typeof createMdns>;
  private queryListener?: (packet: { questions?: Array<{ name: string; type: string }> }) => void;

  constructor(private readonly networkInterface?: string) {}

  async startAdvertising(advertisement: MdnsAdvertisement): Promise<void> {
    validateAdvertisement(advertisement);
    const mdns = this.getInstance();
    this.queryListener = packet => {
      if (packet.questions?.some(question => shouldAnswer(question, advertisement))) {
        mdns.respond({ answers: advertisementAnswers(advertisement) as Answer[] });
      }
    };
    mdns.on('query', this.queryListener);
    mdns.respond({ answers: advertisementAnswers(advertisement) as Answer[] });
  }

  async discover(timeoutMs = 1_200): Promise<DiscoveredDevice[]> {
    const mdns = this.getInstance();
    const collector = new DiscoveryCollector();
    const listener = (packet: { answers?: Answer[]; additionals?: Answer[] }) => {
      collector.accept([...(packet.answers ?? []), ...(packet.additionals ?? [])] as MdnsAnswer[]);
    };
    mdns.on('response', listener);
    mdns.query({ questions: [{ name: DEVICE_LINK_SERVICE_TYPE, type: 'PTR' }] });
    await new Promise(resolve => setTimeout(resolve, Math.max(100, Math.min(timeoutMs, 5_000))));
    mdns.off('response', listener);
    return collector.results();
  }

  async stop(): Promise<void> {
    if (!this.instance) return;
    if (this.queryListener) this.instance.off('query', this.queryListener);
    await new Promise<void>(resolve => this.instance!.destroy(() => resolve()));
    this.instance = undefined;
    this.queryListener = undefined;
  }

  private getInstance(): ReturnType<typeof createMdns> {
    this.instance ??= createMdns({
      ...(this.networkInterface ? { interface: this.networkInterface } : {}),
      reuseAddr: true,
      loopback: false,
    });
    return this.instance;
  }
}

export function advertisementAnswers(advertisement: MdnsAdvertisement): MdnsAnswer[] {
  validateAdvertisement(advertisement);
  const serviceName = serviceInstanceName(advertisement.identity);
  const hostname = normalizeHostname(advertisement.host);
  const records: MdnsAnswer[] = [
    { name: DEVICE_LINK_SERVICE_TYPE, type: 'PTR', ttl: 120, data: serviceName },
    {
      name: serviceName,
      type: 'SRV',
      ttl: 120,
      data: { priority: 0, weight: 0, port: advertisement.port, target: hostname },
    },
    {
      name: serviceName,
      type: 'TXT',
      ttl: 120,
      data: [
        Buffer.from(`id=${advertisement.identity.deviceId}`),
        Buffer.from(`name=${encodeURIComponent(advertisement.identity.name)}`),
        Buffer.from('pv=2'),
        Buffer.from(`fp=${advertisement.identity.certificateFingerprint}`),
      ],
    },
  ];
  if (isIP(advertisement.address) === 4) {
    records.push({ name: hostname, type: 'A', ttl: 120, data: advertisement.address });
  } else if (isIP(advertisement.address) === 6) {
    records.push({ name: hostname, type: 'AAAA', ttl: 120, data: advertisement.address });
  }
  return records;
}

export function discoveredDevicesFromRecords(records: MdnsAnswer[]): DiscoveredDevice[] {
  const collector = new DiscoveryCollector();
  collector.accept(records);
  return collector.results();
}

class DiscoveryCollector {
  private readonly serviceNames = new Set<string>();
  private readonly services = new Map<string, { host: string; port: number }>();
  private readonly text = new Map<string, Record<string, string>>();
  private readonly addresses = new Map<string, string>();

  accept(records: MdnsAnswer[]): void {
    for (const record of records) {
      if (record.type === 'PTR' && record.name === DEVICE_LINK_SERVICE_TYPE
        && typeof record.data === 'string') {
        this.serviceNames.add(record.data);
      } else if (record.type === 'SRV' && isSrvData(record.data)) {
        this.services.set(record.name, { host: record.data.target, port: record.data.port });
      } else if (record.type === 'TXT') {
        this.text.set(record.name, parseTxt(record.data));
      } else if ((record.type === 'A' || record.type === 'AAAA') && typeof record.data === 'string') {
        this.addresses.set(record.name, record.data);
      }
    }
  }

  results(): DiscoveredDevice[] {
    const now = new Date().toISOString();
    return [...this.serviceNames].flatMap(serviceName => {
      const service = this.services.get(serviceName);
      const text = this.text.get(serviceName);
      const host = service ? this.addresses.get(service.host) ?? service.host : undefined;
      if (!service || !text || !host || text.pv !== '2' || !text.id || !text.fp) return [];
      try {
        return [{
          deviceId: text.id,
          name: text.name ? decodeURIComponent(text.name) : text.id,
          host,
          port: service.port,
          certificateFingerprint: normalizeFingerprint(text.fp),
          protocolVersion: 2 as const,
          lastSeenAt: now,
        }];
      } catch {
        return [];
      }
    }).sort((left, right) => left.name.localeCompare(right.name));
  }
}

function validateAdvertisement(advertisement: MdnsAdvertisement): void {
  if (!advertisement.identity.deviceId.trim()
    || !advertisement.host.trim()
    || isIP(advertisement.address) === 0
    || !Number.isInteger(advertisement.port)
    || advertisement.port < 1
    || advertisement.port > 65_535) {
    throw new Error('mDNS advertisement is invalid.');
  }
  normalizeFingerprint(advertisement.identity.certificateFingerprint);
}

function shouldAnswer(
  question: { name: string; type: string },
  advertisement: MdnsAdvertisement,
): boolean {
  const serviceName = serviceInstanceName(advertisement.identity);
  const hostname = normalizeHostname(advertisement.host);
  return question.name === DEVICE_LINK_SERVICE_TYPE
    || question.name === serviceName
    || question.name === hostname;
}

function serviceInstanceName(identity: DeviceIdentity): string {
  const safeName = identity.name.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-|-$/gu, '');
  return `${safeName || 'hadamard'}-${identity.deviceId.slice(-8)}.${DEVICE_LINK_SERVICE_TYPE}`;
}

function normalizeHostname(value: string): string {
  const host = value.trim().replace(/\.$/u, '');
  return host.endsWith('.local') ? host : `${host}.local`;
}

function parseTxt(value: unknown): Record<string, string> {
  const buffers = Array.isArray(value) ? value : [value];
  return Object.fromEntries(buffers.flatMap(item => {
    const text = Buffer.isBuffer(item) ? item.toString('utf8') : String(item);
    const index = text.indexOf('=');
    return index > 0 ? [[text.slice(0, index), text.slice(index + 1)]] : [];
  }));
}

function isSrvData(value: unknown): value is { target: string; port: number } {
  return Boolean(value && typeof value === 'object'
    && typeof (value as { target?: unknown }).target === 'string'
    && typeof (value as { port?: unknown }).port === 'number');
}
