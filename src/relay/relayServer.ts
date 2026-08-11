import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { isIP } from 'node:net';

import { WebSocketServer, type WebSocket } from 'ws';

export interface HadamardRelayServerOptions {
  authSecret: string;
  host?: string;
  port?: number;
  allowPublic?: boolean;
  maxConnections?: number;
  maxFrameBytes?: number;
  maxPeersPerRoom?: number;
}

export interface HadamardRelayAddress {
  host: string;
  port: number;
  url: string;
}

interface RelayPeer {
  deviceId: string;
  roomId: string;
  socket: WebSocket;
  seenEnvelopeIds: Set<string>;
}

const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_MAX_FRAME_BYTES = 512 * 1024;
const DEFAULT_MAX_PEERS_PER_ROOM = 2;

export class HadamardRelayServer {
  private httpServer?: Server;
  private sockets?: WebSocketServer;
  private address?: HadamardRelayAddress;
  private readonly rooms = new Map<string, Map<string, RelayPeer>>();

  constructor(private readonly options: HadamardRelayServerOptions) {
    if (Buffer.byteLength(options.authSecret, 'utf8') < 32) {
      throw new Error('Relay authSecret must contain at least 32 UTF-8 bytes.');
    }
  }

  async start(): Promise<HadamardRelayAddress> {
    if (this.address) return this.address;
    const host = this.options.host?.trim() || '127.0.0.1';
    assertSafeRelayBind(host, this.options.allowPublic === true);
    const server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: true, protocol: 'hadamard-relay-v1' }));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: 'not found' }));
    });
    const sockets = new WebSocketServer({
      server,
      path: '/v1/relay',
      perMessageDeflate: false,
      maxPayload: this.options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    });
    sockets.on('connection', (socket, request) => {
      try {
        const url = new URL(request.url ?? '', 'http://relay.invalid');
        const deviceId = requireTokenSegment(url.searchParams.get('deviceId'), 'deviceId');
        const roomId = requireTokenSegment(url.searchParams.get('roomId'), 'roomId');
        const expires = requireExpiration(url.searchParams.get('expires'));
        const token = url.searchParams.get('token') ?? '';
        if (!verifyRelayToken(this.options.authSecret, { deviceId, roomId, expires, token })) {
          socket.close(1008, 'Invalid relay token');
          return;
        }
        if (sockets.clients.size > (this.options.maxConnections ?? DEFAULT_MAX_CONNECTIONS)) {
          socket.close(1013, 'Relay capacity reached');
          return;
        }
        const room = this.rooms.get(roomId) ?? new Map<string, RelayPeer>();
        if (room.has(deviceId) || room.size >= (this.options.maxPeersPerRoom ?? DEFAULT_MAX_PEERS_PER_ROOM)) {
          socket.close(1008, 'Relay room is full or device is already connected');
          return;
        }
        const peer: RelayPeer = { deviceId, roomId, socket, seenEnvelopeIds: new Set() };
        room.set(deviceId, peer);
        this.rooms.set(roomId, room);
        socket.on('message', data => this.receive(peer, data));
        socket.on('close', () => this.remove(peer));
        socket.on('error', () => this.remove(peer));
        this.send(peer.socket, { type: 'relay/ready', roomId, deviceId });
        this.broadcast(peer, { type: 'relay/peer-joined', deviceId });
      } catch (error) {
        socket.close(1008, error instanceof Error ? error.message.slice(0, 120) : 'Invalid relay request');
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const bound = server.address();
    if (!bound || typeof bound === 'string') throw new Error('Relay address is unavailable.');
    this.httpServer = server;
    this.sockets = sockets;
    this.address = { host, port: bound.port, url: `ws://${formatHost(host)}:${bound.port}/v1/relay` };
    return this.address;
  }

  async stop(): Promise<void> {
    const sockets = this.sockets;
    const server = this.httpServer;
    this.sockets = undefined;
    this.httpServer = undefined;
    this.address = undefined;
    this.rooms.clear();
    if (sockets) {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
    }
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  snapshot() {
    return {
      listening: Boolean(this.address),
      address: this.address ? { ...this.address } : undefined,
      rooms: this.rooms.size,
      connections: [...this.rooms.values()].reduce((total, room) => total + room.size, 0),
    };
  }

  private receive(peer: RelayPeer, data: unknown): void {
    let value: Record<string, unknown>;
    try {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      value = JSON.parse(text) as Record<string, unknown>;
      if (value.type === 'signal') validateSignal(value);
      else if (value.type === 'opaque') validateOpaqueEnvelope(value, peer);
      else throw new Error('Relay frame type must be signal or opaque.');
    } catch (error) {
      this.send(peer.socket, {
        type: 'relay/error',
        code: 'INVALID_FRAME',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const delivered = this.broadcast(peer, { ...value, fromDeviceId: peer.deviceId });
    if (delivered === 0) this.send(peer.socket, { type: 'relay/peer-unavailable' });
  }

  private broadcast(peer: RelayPeer, value: Record<string, unknown>): number {
    const room = this.rooms.get(peer.roomId);
    if (!room) return 0;
    let delivered = 0;
    for (const candidate of room.values()) {
      if (candidate.deviceId === peer.deviceId || candidate.socket.readyState !== candidate.socket.OPEN) continue;
      this.send(candidate.socket, value);
      delivered += 1;
    }
    return delivered;
  }

  private send(socket: WebSocket, value: Record<string, unknown>): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value));
  }

  private remove(peer: RelayPeer): void {
    const room = this.rooms.get(peer.roomId);
    if (!room || room.get(peer.deviceId) !== peer) return;
    room.delete(peer.deviceId);
    if (room.size === 0) this.rooms.delete(peer.roomId);
    else this.broadcast(peer, { type: 'relay/peer-left', deviceId: peer.deviceId });
  }
}

export function createRelayToken(
  authSecret: string,
  input: { deviceId: string; roomId: string; expires: number },
): string {
  requireTokenSegment(input.deviceId, 'deviceId');
  requireTokenSegment(input.roomId, 'roomId');
  return createHmac('sha256', authSecret).update(relayTokenPayload(input)).digest('base64url');
}

export function verifyRelayToken(
  authSecret: string,
  input: { deviceId: string; roomId: string; expires: number; token: string },
): boolean {
  if (!Number.isSafeInteger(input.expires) || input.expires < Date.now() || input.expires > Date.now() + 10 * 60_000) {
    return false;
  }
  const expected = Buffer.from(createRelayToken(authSecret, input));
  const actual = Buffer.from(input.token);
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

function relayTokenPayload(input: { deviceId: string; roomId: string; expires: number }): string {
  return `hadamard-relay-v1\n${input.deviceId}\n${input.roomId}\n${input.expires}`;
}

function validateSignal(value: Record<string, unknown>): void {
  if (value.description !== undefined) {
    const description = value.description as Record<string, unknown>;
    if (!description || typeof description !== 'object'
      || (description.type !== 'offer' && description.type !== 'answer')
      || typeof description.sdp !== 'string'
      || description.sdp.length > 256_000) throw new Error('Invalid WebRTC session description.');
  } else if (value.candidate !== null && value.candidate !== undefined) {
    const candidate = value.candidate as Record<string, unknown>;
    if (!candidate || typeof candidate !== 'object'
      || typeof candidate.candidate !== 'string'
      || candidate.candidate.length > 8_192) throw new Error('Invalid WebRTC ICE candidate.');
  } else {
    throw new Error('Signal frame requires description or candidate.');
  }
}

function validateOpaqueEnvelope(value: Record<string, unknown>, peer: RelayPeer): void {
  const id = value.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(id)) throw new Error('Invalid opaque envelope ID.');
  if (peer.seenEnvelopeIds.has(id)) throw new Error('Opaque envelope replay detected.');
  if (typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence <= 0) {
    throw new Error('Invalid opaque envelope sequence.');
  }
  if (typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.nonce)) {
    throw new Error('Invalid opaque envelope nonce.');
  }
  if (typeof value.ciphertext !== 'string' || !/^[A-Za-z0-9_-]{16,700000}$/u.test(value.ciphertext)) {
    throw new Error('Invalid opaque ciphertext.');
  }
  peer.seenEnvelopeIds.add(id);
  while (peer.seenEnvelopeIds.size > 4_096) {
    const oldest = peer.seenEnvelopeIds.values().next().value;
    if (typeof oldest === 'string') peer.seenEnvelopeIds.delete(oldest);
  }
}

function requireTokenSegment(value: string | null, name: string): string {
  if (!value || !/^[A-Za-z0-9._-]{1,128}$/u.test(value)) throw new Error(`Invalid relay ${name}.`);
  return value;
}

function requireExpiration(value: string | null): number {
  const expires = Number(value);
  if (!Number.isSafeInteger(expires)) throw new Error('Invalid relay expiration.');
  return expires;
}

function assertSafeRelayBind(host: string, allowPublic: boolean): void {
  const normalized = host.replace(/^\[|\]$/gu, '').toLowerCase();
  const privateAddress = normalized === 'localhost'
    || normalized === '::1'
    || normalized.startsWith('127.')
    || normalized.startsWith('10.')
    || normalized.startsWith('192.168.')
    || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(normalized)
    || normalized.startsWith('fe80:')
    || /^f[cd][0-9a-f]{2}:/u.test(normalized);
  if (!allowPublic && !privateAddress) throw new Error('Public relay binding requires explicit allowPublic:true.');
}

function formatHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}
