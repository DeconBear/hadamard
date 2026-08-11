import type { AppServer, AppServerEmit } from '../app-server/appServer.js';
import {
  APP_SERVER_PROTOCOL_VERSION,
  type AppServerRequestV2,
  type AppServerResponse,
} from '../app-server/protocol.js';
import type { DeviceLinkAuthorizationService } from './authorization.js';
import { DeviceLinkAuthorizationError } from './authorization.js';
import type { DevicePairingService } from './pairing.js';
import type { DeviceLinkSessionPacket, DeviceLinkSessionReplicaService } from './sessionReplica.js';
import type {
  DeviceIdentity,
  DeviceLinkConnectionContext,
  DeviceLinkServerLimits,
  PairingCompletion,
} from './types.js';

export interface DeviceLinkGatewayOptions {
  appServer: AppServer;
  identity: DeviceIdentity;
  pairing: DevicePairingService;
  authorization: DeviceLinkAuthorizationService;
  limits: DeviceLinkServerLimits;
  sessions?: DeviceLinkSessionReplicaService;
}

export class DeviceLinkGateway {
  constructor(private readonly options: DeviceLinkGatewayOptions) {}

  async handle(
    request: AppServerRequestV2,
    context: DeviceLinkConnectionContext,
    emit?: AppServerEmit,
  ): Promise<AppServerResponse> {
    try {
      if (request.version !== APP_SERVER_PROTOCOL_VERSION) {
        throw new DeviceLinkAuthorizationError(
          'PROTOCOL_VERSION_REQUIRED',
          'Device Link network connections require App Server protocol v2.',
        );
      }
      const device = await this.options.authorization.authorize(request, context);
      if (request.method === 'initialize') return this.response(request, this.initializeResult());
      if (request.method === 'pair/complete') {
        return this.response(request, await this.options.pairing.complete(
          request.params as unknown as PairingCompletion,
        ));
      }
      if (request.method === 'session/snapshot') {
        return this.response(request, await this.requireSessions().snapshot(
          stringParam(request.params, 'sessionId'),
        ));
      }
      if (request.method === 'session/items') {
        return this.response(request, await this.requireSessions().items(
          stringParam(request.params, 'sessionId'),
          numberParam(request.params, 'afterSequence'),
        ));
      }
      if (request.method === 'session/copy') {
        if (request.params?.confirm !== true) throw new Error('session/copy requires confirm:true.');
        const packet = request.params.packet as unknown as DeviceLinkSessionPacket;
        if (!device || packet?.originDeviceId !== device.deviceId) {
          throw new DeviceLinkAuthorizationError(
            'SESSION_ORIGIN_MISMATCH',
            'Session copy origin must match the authenticated device.',
          );
        }
        return this.response(request, await this.requireSessions().copy(
          packet,
          optionalStringParam(request.params, 'targetSessionId'),
        ));
      }
      return this.options.appServer.handle(request, emit);
    } catch (error) {
      return {
        version: APP_SERVER_PROTOCOL_VERSION,
        id: request.id,
        error: {
          code: error instanceof DeviceLinkAuthorizationError ? error.code : 'DEVICE_LINK_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private initializeResult() {
    return {
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      supportedProtocolVersions: [1, 2],
      device: this.options.identity,
      capabilities: [
        'device-link',
        'pairing',
        'session-snapshot',
        'session-items',
        'session-copy',
      ],
      limits: this.options.limits,
      serverTime: new Date().toISOString(),
    };
  }

  private response(request: AppServerRequestV2, result: unknown): AppServerResponse {
    return { version: APP_SERVER_PROTOCOL_VERSION, id: request.id, result };
  }

  private requireSessions(): DeviceLinkSessionReplicaService {
    if (!this.options.sessions) throw new Error('Device Link session replication is not configured.');
    return this.options.sessions;
  }
}

function stringParam(params: Record<string, unknown> | undefined, name: string): string {
  const value = params?.[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function optionalStringParam(
  params: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const value = params?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberParam(params: Record<string, unknown> | undefined, name: string): number {
  const value = params?.[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${name} is required.`);
  return value;
}
