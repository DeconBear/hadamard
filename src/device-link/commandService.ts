import { DEVICE_LINK_SCOPES, type DeviceLinkScope } from './types.js';
import type { DeviceLinkService } from './deviceLinkService.js';

export interface DeviceLinkCommandResult {
  message: string;
  lines?: string[];
}

const USAGE = '/devices [status|start [host] [port] [--advertise <ip>]|stop|pair [scope,...]|scopes <device-id> <scope,...>|revoke <device-id> --confirm|discover|audit]';

function parseScopes(value: string | undefined, fallback: DeviceLinkScope[] = []): DeviceLinkScope[] {
  if (!value?.trim()) return fallback;
  const allowed = new Set<string>(DEVICE_LINK_SCOPES);
  const scopes = [...new Set(value.split(',').map(scope => scope.trim()).filter(Boolean))];
  for (const scope of scopes) {
    if (!allowed.has(scope)) throw new Error(`Unknown Device Link scope: ${scope}`);
  }
  return scopes as DeviceLinkScope[];
}

export class DeviceLinkCommandService {
  constructor(private readonly service: DeviceLinkService) {}

  async execute(input: string): Promise<DeviceLinkCommandResult> {
    const args = input.trim().split(/\s+/u).filter(Boolean);
    const command = (args.shift() ?? 'status').toLowerCase();
    if (command === 'status' || command === 'list') {
      const snapshot = await this.service.snapshot();
      return {
        message: `Device Link ${snapshot.diagnostics.state}; ${snapshot.devices.filter(device => !device.revokedAt).length} trusted device(s).`,
        lines: [
          `This device: ${snapshot.identity.name} (${snapshot.identity.deviceId})`,
          `TLS fingerprint: ${snapshot.identity.certificateFingerprint}`,
          `Listener: ${snapshot.diagnostics.url ?? 'stopped'}; discovery: ${snapshot.diagnostics.discovery}`,
          ...snapshot.devices.map(device => `${device.revokedAt ? '[revoked]' : '[trusted]'} ${device.name} ${device.deviceId} scopes=${device.scopes.join(',') || 'none'} lastSeen=${device.lastSeenAt ?? 'never'}`),
        ],
      };
    }
    if (command === 'start') {
      const host = args.shift();
      const portToken = args[0] && /^\d+$/u.test(args[0]) ? args.shift() : undefined;
      const advertiseIndex = args.indexOf('--advertise');
      const advertiseAddress = advertiseIndex >= 0 ? args[advertiseIndex + 1] : undefined;
      if (args.length > 0 && advertiseIndex < 0) throw new Error(USAGE);
      if (advertiseIndex >= 0 && (!advertiseAddress || advertiseIndex + 2 !== args.length)) throw new Error(USAGE);
      const diagnostics = await this.service.start({
        host,
        port: portToken ? Number(portToken) : 0,
        advertise: advertiseIndex >= 0,
        advertiseAddress,
      });
      return { message: `Device Link listening at ${diagnostics.url}; discovery ${diagnostics.discovery}.` };
    }
    if (command === 'stop') {
      if (args.length) throw new Error(USAGE);
      await this.service.stop();
      return { message: 'Device Link stopped.' };
    }
    if (command === 'pair') {
      if (args.length > 1) throw new Error(USAGE);
      const pairing = await this.service.beginPairing({
        offeredScopes: parseScopes(args[0], ['session:browse']),
      });
      return {
        message: `Pairing code ${pairing.offer.confirmationCode}; expires ${pairing.offer.expiresAt}.`,
        lines: [pairing.uri],
      };
    }
    if (command === 'scopes') {
      const [deviceId, scopes, ...rest] = args;
      if (!deviceId || scopes === undefined || rest.length) throw new Error(USAGE);
      const device = await this.service.updateScopes(deviceId, parseScopes(scopes));
      return { message: `Updated ${device.name}: ${device.scopes.join(',') || 'no permissions'}.` };
    }
    if (command === 'revoke') {
      const [deviceId, confirmation, ...rest] = args;
      if (!deviceId || confirmation !== '--confirm' || rest.length) throw new Error(USAGE);
      const device = await this.service.revoke(deviceId);
      return { message: `Revoked ${device.name} (${device.deviceId}).` };
    }
    if (command === 'discover') {
      if (args.length) throw new Error(USAGE);
      const devices = await this.service.discover(1_200);
      return {
        message: `Discovered ${devices.length} Device Link endpoint(s).`,
        lines: devices.map(device => `${device.name} ${device.host}:${device.port} ${device.deviceId} ${device.certificateFingerprint}`),
      };
    }
    if (command === 'audit') {
      if (args.length) throw new Error(USAGE);
      const records = await this.service.listAudit(50);
      return {
        message: `${records.length} recent Device Link audit record(s).`,
        lines: records.map(record => `${record.timestamp} ${record.outcome} ${record.deviceId ?? 'unpaired'} ${record.method}${record.reason ? ` — ${record.reason}` : ''}`),
      };
    }
    throw new Error(USAGE);
  }
}
