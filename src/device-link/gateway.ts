import type { AppServer, AppServerEmit } from '../app-server/appServer.js';
import {
  APP_SERVER_PROTOCOL_VERSION,
  type AppServerRequestV2,
  type AppServerResponse,
} from '../app-server/protocol.js';
import type { DeviceLinkAuthorizationService } from './authorization.js';
import { DeviceLinkAuthorizationError } from './authorization.js';
import type {
  DeviceLinkArtifactManifest,
  DeviceLinkArtifactTransferService,
} from './artifactTransferService.js';
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
  artifacts?: DeviceLinkArtifactTransferService;
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
      if (request.method === 'artifact/begin') {
        return this.response(request, await this.requireArtifacts().begin(
          requireDeviceId(device),
          recordParam(request.params, 'manifest') as unknown as DeviceLinkArtifactManifest,
        ));
      }
      if (request.method === 'artifact/chunk') {
        const content = strictBase64Param(request.params, 'contentBase64');
        return this.response(request, await this.requireArtifacts().receiveChunk(
          requireDeviceId(device),
          stringParam(request.params, 'transferId'),
          numberParam(request.params, 'index'),
          content,
          stringParam(request.params, 'sha256'),
        ));
      }
      if (request.method === 'artifact/status') {
        const deviceId = requireDeviceId(device);
        const transferId = stringParam(request.params, 'transferId');
        return this.response(request, {
          state: await this.requireArtifacts().status(deviceId, transferId),
          missingChunks: await this.requireArtifacts().missingChunks(deviceId, transferId),
        });
      }
      if (request.method === 'artifact/finalize') {
        return this.response(request, await this.requireArtifacts().finalize(
          requireDeviceId(device),
          stringParam(request.params, 'transferId'),
        ));
      }
      if (request.method === 'artifact/chunk/read') {
        const content = await this.requireArtifacts().readVerifiedChunk(
          requireDeviceId(device),
          stringParam(request.params, 'transferId'),
          numberParam(request.params, 'index'),
        );
        return this.response(request, {
          contentBase64: content.toString('base64'),
          sha256: (await import('node:crypto')).createHash('sha256').update(content).digest('hex'),
        });
      }
      if (request.method === 'artifact/outbox/list') {
        return this.response(request, await this.requireArtifacts().listOutbox(requireDeviceId(device)));
      }
      if (request.method === 'artifact/outbox/chunk') {
        const content = await this.requireArtifacts().readOutgoingChunk(
          requireDeviceId(device),
          stringParam(request.params, 'transferId'),
          numberParam(request.params, 'index'),
        );
        return this.response(request, {
          contentBase64: content.toString('base64'),
          sha256: (await import('node:crypto')).createHash('sha256').update(content).digest('hex'),
        });
      }
      if (request.method === 'artifact/outbox/ack') {
        await this.requireArtifacts().acknowledgeOutgoing(
          requireDeviceId(device),
          stringParam(request.params, 'transferId'),
          request.params?.confirm === true,
        );
        return this.response(request, { acknowledged: true });
      }
      if (request.method === 'workspace/inbox/list') {
        return this.response(request, await this.requireArtifacts().listInbox(requireDeviceId(device)));
      }
      if (request.method === 'workspace/inbox/commit') {
        return this.response(request, await this.requireArtifacts().commit(
          requireDeviceId(device),
          stringParam(request.params, 'transferId'),
          stringParam(request.params, 'targetRelativePath'),
          request.params?.confirm === true,
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
        'artifact-transfer',
        'artifact-resume',
        'workspace-inbox',
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

  private requireArtifacts(): DeviceLinkArtifactTransferService {
    if (!this.options.artifacts) throw new Error('Device Link artifact transfer is not configured.');
    return this.options.artifacts;
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

function recordParam(
  params: Record<string, unknown> | undefined,
  name: string,
): Record<string, unknown> {
  const value = params?.[name];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is required.`);
  return value as Record<string, unknown>;
}

function strictBase64Param(params: Record<string, unknown> | undefined, name: string): Buffer {
  const value = stringParam(params, name);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`${name} must be canonical base64.`);
  }
  return Buffer.from(value, 'base64');
}

function requireDeviceId(device: { deviceId: string } | undefined): string {
  if (!device) throw new DeviceLinkAuthorizationError('AUTH_REQUIRED', 'Authenticated device is required.');
  return device.deviceId;
}
