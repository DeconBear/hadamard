import { randomBytes } from 'node:crypto';

import type { KeywayCorePort, KeywayGatewayModulePort, KeywayStorePort } from './keywayPorts.js';

export interface KeywayLoopbackStatus {
  running: boolean;
  host?: string;
  port?: number;
  url?: string;
  authentication: 'client-key' | 'none';
}

export interface KeywayLoopbackStartResult extends KeywayLoopbackStatus {
  /** Returned exactly once when a new gateway starts; never persisted or exposed by status(). */
  clientKey?: string;
  newlyStarted: boolean;
}

export interface KeywayLoopbackGatewayControllerOptions {
  core: KeywayCorePort;
  store: KeywayStorePort;
  gatewayModule?: KeywayGatewayModulePort;
}

export class KeywayLoopbackGatewayController {
  private gateway?: Awaited<ReturnType<KeywayGatewayModulePort['LoopbackGateway']['start']>>;
  private starting?: Promise<{
    gateway: Awaited<ReturnType<KeywayGatewayModulePort['LoopbackGateway']['start']>>;
    clientKey: string;
  }>;

  constructor(private readonly options: KeywayLoopbackGatewayControllerOptions) {}

  status(): KeywayLoopbackStatus {
    return this.gateway?.status() ?? { running: false, authentication: 'client-key' };
  }

  async start(port = 0): Promise<KeywayLoopbackStartResult> {
    if (this.gateway) return { ...this.gateway.status(), newlyStarted: false };
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new TypeError('Gateway port must be an integer from 0 to 65535.');
    }
    if (this.starting) {
      await this.starting;
      return { ...this.gateway!.status(), newlyStarted: false };
    }
    const starting = this.startNew(port);
    this.starting = starting;
    try {
      const { gateway, clientKey } = await starting;
      this.gateway = gateway;
      return { ...gateway.status(), clientKey, newlyStarted: true };
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  async stop(): Promise<KeywayLoopbackStatus> {
    if (this.starting) {
      try { await this.starting; } catch { /* start() reports the original failure */ }
    }
    await this.gateway?.close();
    this.gateway = undefined;
    return this.status();
  }

  private async startNew(port: number) {
    const module = this.options.gatewayModule ?? await loadKeywayGatewayModule();
    const clientKey = `db_sk_${randomBytes(24).toString('base64url')}`;
    const gateway = await module.LoopbackGateway.start({
      core: this.options.core,
      store: this.options.store,
      clientKeys: [clientKey],
      host: '127.0.0.1',
      port,
    });
    return { gateway, clientKey };
  }
}

export async function loadKeywayGatewayModule(): Promise<KeywayGatewayModulePort> {
  const packageName = '@keyway-router/gateway';
  try {
    const module = await import(packageName) as unknown as KeywayGatewayModulePort;
    if (module.KEYWAY_GATEWAY_VERSION !== 1) {
      throw new Error(`Unsupported Keyway gateway version: ${String(module.KEYWAY_GATEWAY_VERSION)}`);
    }
    return module;
  } catch (error) {
    throw new Error(
      'Keyway loopback gateway is unavailable. Install matching @keyway-router/gateway version.',
      { cause: error },
    );
  }
}
