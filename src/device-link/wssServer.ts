import { createServer, type Server as HttpsServer } from 'node:https';
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';

import { WebSocketServer, type WebSocket } from 'ws';

import { APP_SERVER_PROTOCOL_VERSION, parseAppServerRequest } from '../app-server/protocol.js';
import type { DeviceLinkGateway } from './gateway.js';
import { normalizeFingerprint } from './identity.js';
import type { DeviceIdentityCredentials, DeviceLinkServerLimits } from './types.js';

export interface DeviceLinkWssServerOptions {
  gateway: DeviceLinkGateway;
  identity: DeviceIdentityCredentials;
  limits: DeviceLinkServerLimits;
  host?: string;
  port?: number;
  allowPublic?: boolean;
  peerUnlocked?: (deviceId: string) => boolean | Promise<boolean>;
}

export interface DeviceLinkWssServerAddress {
  host: string;
  port: number;
  url: string;
}

export class DeviceLinkWssServer {
  private httpsServer?: HttpsServer;
  private webSocketServer?: WebSocketServer;
  private address?: DeviceLinkWssServerAddress;

  constructor(private readonly options: DeviceLinkWssServerOptions) {}

  async start(): Promise<DeviceLinkWssServerAddress> {
    if (this.address) return this.address;
    const host = this.options.host?.trim() || '127.0.0.1';
    assertSafeBind(host, this.options.allowPublic === true);
    const server = createServer({
      key: this.options.identity.tlsPrivateKeyPem,
      cert: this.options.identity.tlsCertificatePem,
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    });
    const sockets = new WebSocketServer({
      server,
      perMessageDeflate: false,
      maxPayload: this.options.limits.maxRequestBytes,
    });
    sockets.on('connection', (socket, request) => {
      const tls = request.socket as TLSSocket;
      const certificate = tls.getPeerCertificate();
      const fingerprint = certificate?.fingerprint256
        ? normalizeFingerprint(certificate.fingerprint256)
        : undefined;
      this.attach(socket, {
        ...(fingerprint ? { certificateFingerprint: fingerprint } : {}),
        peerUnlocked: false,
        remoteAddress: request.socket.remoteAddress,
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const bound = server.address();
    if (!bound || typeof bound === 'string') throw new Error('Device Link WSS address is unavailable.');
    this.httpsServer = server;
    this.webSocketServer = sockets;
    this.address = { host, port: bound.port, url: `wss://${formatHost(host)}:${bound.port}` };
    return this.address;
  }

  async stop(): Promise<void> {
    const sockets = this.webSocketServer;
    const server = this.httpsServer;
    this.webSocketServer = undefined;
    this.httpsServer = undefined;
    this.address = undefined;
    if (sockets) {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
    }
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private attach(socket: WebSocket, context: {
    certificateFingerprint?: string;
    peerUnlocked: boolean;
    remoteAddress?: string;
  }): void {
    let chain = Promise.resolve();
    socket.on('message', data => {
      chain = chain.then(async () => {
        let id = '';
        try {
          const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
          const request = parseAppServerRequest(JSON.parse(text));
          id = request.id;
          if (request.version !== APP_SERVER_PROTOCOL_VERSION) {
            throw new Error('Device Link WSS requires protocol v2.');
          }
          const deviceId = typeof request.auth?.deviceId === 'string' ? request.auth.deviceId : undefined;
          const requestContext = {
            ...context,
            peerUnlocked: deviceId && this.options.peerUnlocked
              ? await this.options.peerUnlocked(deviceId)
              : false,
          };
          const response = await this.options.gateway.handle(request, requestContext, notification => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(notification));
          });
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(response));
        } catch (error) {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({
            version: APP_SERVER_PROTOCOL_VERSION,
            id,
            error: {
              code: 'INVALID_REQUEST',
              message: error instanceof Error ? error.message : String(error),
            },
          }));
        }
      }).catch(() => undefined);
    });
  }
}

export function isPrivateBindAddress(host: string): boolean {
  const normalized = host.trim().replace(/^\[|\]$/gu, '').toLowerCase();
  if (normalized === 'localhost') return true;
  if (isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number);
    return octets[0] === 127
      || octets[0] === 10
      || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  if (isIP(normalized) === 6) {
    return normalized === '::1' || normalized.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/u.test(normalized);
  }
  return false;
}

function assertSafeBind(host: string, allowPublic: boolean): void {
  if ((host === '0.0.0.0' || host === '::') && !allowPublic) {
    throw new Error('Wildcard Device Link binding requires explicit allowPublic:true.');
  }
  if (!allowPublic && !isPrivateBindAddress(host)) {
    throw new Error('Public Device Link binding requires explicit allowPublic:true.');
  }
}

function formatHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}
