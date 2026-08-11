import { isIP } from 'node:net';
import path from 'node:path';

import type { AppServer } from '../app-server/appServer.js';
import type { HadamardAgentClient } from '../runtime/agentClient.js';
import { SqliteStorageV2, type DurableStorageV2 } from '../storage-v2/index.js';
import { DeviceLinkAuditStore } from './auditStore.js';
import { DeviceLinkArtifactTransferService } from './artifactTransferService.js';
import { DeviceLinkAuthorizationService } from './authorization.js';
import { PairedDeviceRegistry } from './deviceRegistry.js';
import { DeviceLinkGateway } from './gateway.js';
import { DeviceIdentityStore, withoutSecrets } from './identity.js';
import { MdnsDeviceDiscovery, type DeviceDiscoveryPort } from './mdnsDiscovery.js';
import { DevicePairingService, type BeginPairingOptions } from './pairing.js';
import { RuntimeSessionV2Mirror } from './runtimeSessionMirror.js';
import { DeviceLinkSessionReplicaService } from './sessionReplica.js';
import {
  DEFAULT_DEVICE_LINK_LIMITS,
  type DeviceIdentityCredentials,
  type DeviceLinkDiagnostics,
  type DeviceLinkScope,
  type DeviceLinkServerLimits,
  type DiscoveredDevice,
  type PairedDevice,
  type PairingCompletion,
  type PairingOffer,
  type PairingResult,
} from './types.js';
import { DeviceLinkWssServer } from './wssServer.js';

export interface DeviceLinkServiceOptions {
  rootDirectory: string;
  appServer: AppServer;
  sdk: HadamardAgentClient;
  deviceName?: string;
  limits?: DeviceLinkServerLimits;
  discovery?: DeviceDiscoveryPort;
  storage?: DurableStorageV2;
  workspaceRoot?: string;
}

export interface StartDeviceLinkOptions {
  host?: string;
  port?: number;
  allowPublic?: boolean;
  advertise?: boolean;
  advertiseAddress?: string;
  networkInterface?: string;
}

export interface DeviceLinkSnapshot {
  identity: ReturnType<typeof withoutSecrets>;
  diagnostics: DeviceLinkDiagnostics;
  devices: PairedDevice[];
}

export class DeviceLinkService {
  private wss?: DeviceLinkWssServer;
  private readonly discovery: DeviceDiscoveryPort;
  private readonly pairing: DevicePairingService;
  private readonly registry: PairedDeviceRegistry;
  private readonly audit: DeviceLinkAuditStore;
  private readonly storage: DurableStorageV2;
  private readonly ownsStorage: boolean;
  private readonly limits: DeviceLinkServerLimits;
  private readonly artifacts: DeviceLinkArtifactTransferService;
  private diagnostics: DeviceLinkDiagnostics = {
    state: 'stopped',
    discovery: 'stopped',
    pairedDevices: 0,
  };

  private constructor(
    private readonly options: DeviceLinkServiceOptions,
    private readonly identity: DeviceIdentityCredentials,
    storage: DurableStorageV2,
  ) {
    this.storage = storage;
    this.ownsStorage = options.storage === undefined;
    this.limits = options.limits ?? DEFAULT_DEVICE_LINK_LIMITS;
    this.artifacts = new DeviceLinkArtifactTransferService({
      rootDirectory: path.join(options.rootDirectory, 'transfers'),
      workspaceRoot: options.workspaceRoot,
    });
    this.registry = new PairedDeviceRegistry(path.join(options.rootDirectory, 'paired-devices.json'));
    this.audit = new DeviceLinkAuditStore(path.join(options.rootDirectory, 'audit.jsonl'));
    this.pairing = new DevicePairingService(identity, this.registry);
    this.discovery = options.discovery ?? new MdnsDeviceDiscovery();
  }

  static async open(options: DeviceLinkServiceOptions): Promise<DeviceLinkService> {
    const identity = await new DeviceIdentityStore(path.join(options.rootDirectory, 'identity'))
      .loadOrCreate(options.deviceName);
    const storage = options.storage ?? await SqliteStorageV2.open({
      filename: path.join(options.rootDirectory, 'sessions.sqlite'),
    });
    return new DeviceLinkService(options, identity, storage);
  }

  async start(options: StartDeviceLinkOptions = {}): Promise<DeviceLinkDiagnostics> {
    if (this.wss) return this.refreshDiagnostics();
    this.diagnostics = { ...this.diagnostics, state: 'starting', lastError: undefined };
    try {
      const tenantId = `device-link:${this.identity.deviceId}`;
      const mirror = new RuntimeSessionV2Mirror(this.options.sdk, this.storage.sessions, tenantId);
      const sessions = new DeviceLinkSessionReplicaService(
        this.storage.sessions,
        this.identity.deviceId,
        tenantId,
        sessionId => mirror.sync(sessionId).then(() => undefined),
      );
      const authorization = new DeviceLinkAuthorizationService(
        this.identity,
        this.registry,
        this.audit,
        this.limits,
      );
      const gateway = new DeviceLinkGateway({
        appServer: this.options.appServer,
        identity: withoutSecrets(this.identity),
        pairing: this.pairing,
        authorization,
        limits: this.limits,
        sessions,
        artifacts: this.artifacts,
      });
      this.wss = new DeviceLinkWssServer({
        gateway,
        identity: this.identity,
        limits: this.limits,
        host: options.host,
        port: options.port,
        allowPublic: options.allowPublic,
      });
      const address = await this.wss.start();
      this.diagnostics = {
        ...this.diagnostics,
        state: 'listening',
        url: address.url,
        bindAddress: address.host,
        port: address.port,
      };
      if (options.advertise !== false) {
        const advertisedAddress = options.advertiseAddress ?? address.host;
        if (isIP(advertisedAddress) === 0) {
          throw new Error('mDNS advertisement requires an explicit IP address.');
        }
        await this.discovery.startAdvertising({
          identity: withoutSecrets(this.identity),
          host: this.identity.deviceId,
          address: advertisedAddress,
          port: address.port,
        });
        this.diagnostics = { ...this.diagnostics, discovery: 'advertising' };
      }
      return this.refreshDiagnostics();
    } catch (error) {
      await this.wss?.stop().catch(() => undefined);
      this.wss = undefined;
      this.diagnostics = {
        ...this.diagnostics,
        state: 'error',
        discovery: 'error',
        lastError: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.discovery.stop();
    await this.wss?.stop();
    this.wss = undefined;
    this.diagnostics = {
      state: 'stopped',
      discovery: 'stopped',
      pairedDevices: (await this.registry.list()).filter(device => !device.revokedAt).length,
    };
  }

  async close(): Promise<void> {
    await this.stop();
    if (this.ownsStorage) await this.storage.close();
  }

  async snapshot(): Promise<DeviceLinkSnapshot> {
    return {
      identity: withoutSecrets(this.identity),
      diagnostics: await this.refreshDiagnostics(),
      devices: await this.registry.list(),
    };
  }

  async beginPairing(options?: Partial<BeginPairingOptions>): Promise<{
    offer: PairingOffer;
    uri: string;
    qrDataUrl: string;
  }> {
    if (this.diagnostics.state !== 'listening'
      || !this.diagnostics.bindAddress
      || !this.diagnostics.port) {
      throw new Error('Start Device Link before creating a pairing offer.');
    }
    const offer = this.pairing.begin({
      address: options?.address ?? this.diagnostics.bindAddress,
      port: options?.port ?? this.diagnostics.port,
      offeredScopes: options?.offeredScopes ?? ['session:browse'],
      ttlMs: options?.ttlMs,
    });
    const { pairingUri } = await import('./pairing.js');
    return { offer, uri: pairingUri(offer), qrDataUrl: await this.pairing.qrDataUrl(offer) };
  }

  completePairing(completion: PairingCompletion): Promise<PairingResult> {
    return this.pairing.complete(completion);
  }

  updateScopes(deviceId: string, scopes: DeviceLinkScope[]): Promise<PairedDevice> {
    return this.registry.updateScopes(deviceId, scopes);
  }

  revoke(deviceId: string): Promise<PairedDevice> {
    return this.registry.revoke(deviceId);
  }

  discover(timeoutMs?: number): Promise<DiscoveredDevice[]> {
    return this.discovery.discover(timeoutMs);
  }

  listAudit(limit?: number) {
    return this.audit.list(limit);
  }

  stageOutgoingArtifact(
    deviceId: string,
    sourceRelativePath: string,
    options?: { name?: string; mediaType?: string; chunkSize?: number },
  ) {
    return this.artifacts.stageOutgoing(deviceId, sourceRelativePath, options);
  }

  listOutgoingArtifacts(deviceId: string) {
    return this.artifacts.listOutbox(deviceId);
  }

  private async refreshDiagnostics(): Promise<DeviceLinkDiagnostics> {
    const pairedDevices = (await this.registry.list()).filter(device => !device.revokedAt).length;
    this.diagnostics = { ...this.diagnostics, pairedDevices };
    return structuredClone(this.diagnostics);
  }
}
