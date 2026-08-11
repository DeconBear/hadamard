import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';

import { AppServer } from '../app-server/appServer.js';
import {
  DEVICE_LINK_SCOPES,
  DeviceLinkCommandService,
  DeviceLinkService,
  type DeviceLinkScope,
} from '../device-link/index.js';
import type { HadamardAgentClient } from '../runtime/agentClient.js';
import { json, readJson } from './guiHttpRouter.js';

export interface GuiDeviceLinkHttpControllerOptions {
  rootDirectory: string;
  deviceName?: string;
  workspaceRoot?: string;
}

export class GuiDeviceLinkHttpController {
  private sdk: HadamardAgentClient | null = null;
  private service: DeviceLinkService | null = null;

  constructor(private readonly options: GuiDeviceLinkHttpControllerOptions) {}

  async setSdk(sdk: HadamardAgentClient | null): Promise<void> {
    if (sdk === this.sdk) return;
    await this.closeService();
    this.sdk = sdk;
  }

  async close(): Promise<void> {
    await this.closeService();
    this.sdk = null;
  }

  async command(input: string) {
    return new DeviceLinkCommandService(await this.getService()).execute(input);
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/api/devices')) return false;
    try {
      if (req.method === 'GET' && url.pathname === '/api/devices') {
        if (!this.sdk) {
          json(res, 200, { available: false, reason: 'Configure a Hadamard provider before enabling Device Link.' });
        } else {
          json(res, 200, { available: true, ...(await (await this.getService()).snapshot()) });
        }
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/devices/start') {
        const body = await readJson(req);
        const diagnostics = await (await this.getService()).start({
          host: optionalString(body, 'host'),
          port: optionalInteger(body, 'port'),
          allowPublic: body.allowPublic === true,
          advertise: body.advertise === true,
          advertiseAddress: optionalString(body, 'advertiseAddress'),
        });
        json(res, 200, { ok: true, diagnostics });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/devices/stop') {
        const service = await this.getService();
        await service.stop();
        json(res, 200, { ok: true, diagnostics: (await service.snapshot()).diagnostics });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/devices/pairing') {
        const body = await readJson(req);
        const scopes = parseScopes(body.scopes);
        json(res, 200, await (await this.getService()).beginPairing({
          address: optionalString(body, 'address'),
          offeredScopes: scopes.length ? scopes : ['session:browse'],
        }));
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/devices/scopes') {
        const body = await readJson(req);
        json(res, 200, {
          device: await (await this.getService()).updateScopes(
            requiredString(body, 'deviceId'),
            parseScopes(body.scopes),
          ),
        });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/devices/revoke') {
        const body = await readJson(req);
        json(res, 200, {
          device: await (await this.getService()).revoke(requiredString(body, 'deviceId')),
        });
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/api/devices/discover') {
        const timeout = Number(url.searchParams.get('timeoutMs') ?? 1_200);
        if (!Number.isFinite(timeout) || timeout < 100 || timeout > 10_000) {
          throw new Error('timeoutMs must be between 100 and 10000.');
        }
        json(res, 200, { devices: await (await this.getService()).discover(timeout) });
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/api/devices/audit') {
        json(res, 200, { records: await (await this.getService()).listAudit(200) });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/devices/transfers/outbox') {
        const body = await readJson(req);
        json(res, 200, {
          transfer: await (await this.getService()).stageOutgoingArtifact(
            requiredString(body, 'deviceId'),
            requiredString(body, 'sourceRelativePath'),
            {
              name: optionalString(body, 'name'),
              mediaType: optionalString(body, 'mediaType'),
              chunkSize: optionalInteger(body, 'chunkSize'),
            },
          ),
        });
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/api/devices/transfers/outbox') {
        const deviceId = url.searchParams.get('deviceId')?.trim();
        if (!deviceId) throw new Error('deviceId is required.');
        json(res, 200, { transfers: await (await this.getService()).listOutgoingArtifacts(deviceId) });
        return true;
      }
      json(res, 404, { error: 'Device Link endpoint not found.' });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  private async getService(): Promise<DeviceLinkService> {
    if (!this.sdk) throw new Error('Device Link requires a configured Hadamard provider credential.');
    this.service ??= await DeviceLinkService.open({
      rootDirectory: this.options.rootDirectory,
      appServer: new AppServer(this.sdk),
      sdk: this.sdk,
      deviceName: this.options.deviceName ?? os.hostname(),
      workspaceRoot: this.options.workspaceRoot,
    });
    return this.service;
  }

  private async closeService(): Promise<void> {
    await this.service?.close().catch(() => undefined);
    this.service = null;
  }
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  return value;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = optionalString(body, field)?.trim();
  if (!value) throw new Error(`${field} is required.`);
  return value;
}

function optionalInteger(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${field} must be an integer.`);
  return value;
}

function parseScopes(value: unknown): DeviceLinkScope[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('scopes must be an array.');
  const allowed = new Set<string>(DEVICE_LINK_SCOPES);
  const scopes = new Set<DeviceLinkScope>();
  for (const scope of value) {
    if (typeof scope !== 'string' || !allowed.has(scope)) {
      throw new Error(`Unknown Device Link scope: ${String(scope)}`);
    }
    scopes.add(scope as DeviceLinkScope);
  }
  return [...scopes];
}
