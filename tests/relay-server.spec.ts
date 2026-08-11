import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  createRelayToken,
  HadamardRelayServer,
  OpaqueRelayCodec,
} from '../src/relay/index.js';

const servers: HadamardRelayServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map(server => server.stop()));
});

describe('self-hosted Hadamard relay', () => {
  it('authenticates rooms, forwards signaling and opaque frames, and rejects replay', async () => {
    const secret = 'relay-secret-that-is-long-enough-for-hmac';
    const server = new HadamardRelayServer({ authSecret: secret });
    servers.push(server);
    const address = await server.start();
    const expires = Date.now() + 60_000;
    const first = await connect(address.url, secret, 'desktop', 'room-1', expires);
    const joined = nextOfType(first, 'relay/peer-joined');
    const second = await connect(address.url, secret, 'phone', 'room-1', expires);
    await joined;

    second.send(JSON.stringify({ type: 'signal', candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host' } }));
    await expect(nextOfType(first, 'signal')).resolves.toMatchObject({ fromDeviceId: 'phone' });

    const envelope = {
      type: 'opaque',
      id: 'opaque-envelope-0001',
      sequence: 1,
      nonce: 'abcdefghijklmnop',
      ciphertext: 'abcdefghijklmnop',
    };
    second.send(JSON.stringify(envelope));
    await expect(nextOfType(first, 'opaque')).resolves.toMatchObject(envelope);
    second.send(JSON.stringify(envelope));
    await expect(nextOfType(second, 'relay/error')).resolves.toMatchObject({
      code: 'INVALID_FRAME',
      message: expect.stringContaining('replay'),
    });
    expect(server.snapshot()).toMatchObject({ rooms: 1, connections: 2 });
  });

  it('fails closed for invalid tokens, unsafe public bind, and unavailable peers', async () => {
    const secret = 'relay-secret-that-is-long-enough-for-hmac';
    expect(() => new HadamardRelayServer({ authSecret: 'short' })).toThrow('32');
    await expect(new HadamardRelayServer({ authSecret: secret, host: '8.8.8.8' }).start())
      .rejects.toThrow('allowPublic');
    const server = new HadamardRelayServer({ authSecret: secret });
    servers.push(server);
    const address = await server.start();
    const peer = await connect(address.url, secret, 'solo', 'room-2', Date.now() + 60_000);
    peer.send(JSON.stringify({ type: 'signal', description: { type: 'offer', sdp: 'v=0' } }));
    await expect(nextOfType(peer, 'relay/peer-unavailable')).resolves.toBeTruthy();

    const invalid = new WebSocket(`${address.url}?deviceId=bad&roomId=room-2&expires=${Date.now() + 60_000}&token=invalid`);
    sockets.push(invalid);
    await expect(new Promise<number>(resolve => invalid.once('close', code => resolve(code))))
      .resolves.toBe(1008);
  });
});

describe('opaque relay codec', () => {
  it('encrypts end-to-end and rejects tampering and replay', () => {
    const key = randomBytes(32);
    const sender = new OpaqueRelayCodec(key, 'room-secure');
    const receiver = new OpaqueRelayCodec(key, 'room-secure');
    const envelope = sender.seal({ method: 'artifact/status', secret: 'not visible to relay' });
    expect(envelope.ciphertext).not.toContain('artifact');
    expect(receiver.open(envelope)).toEqual({ method: 'artifact/status', secret: 'not visible to relay' });
    expect(() => receiver.open(envelope)).toThrow('replayed');

    const tamperedReceiver = new OpaqueRelayCodec(key, 'room-secure');
    const tampered = { ...envelope, ciphertext: `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}` };
    expect(() => tamperedReceiver.open(tampered)).toThrow();
  });
});

async function connect(
  baseUrl: string,
  secret: string,
  deviceId: string,
  roomId: string,
  expires: number,
): Promise<WebSocket> {
  const token = createRelayToken(secret, { deviceId, roomId, expires });
  const socket = new WebSocket(`${baseUrl}?deviceId=${deviceId}&roomId=${roomId}&expires=${expires}&token=${token}`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      const value = JSON.parse(data.toString()) as Record<string, unknown>;
      if (value.type !== 'relay/ready') return;
      socket.off('message', onMessage);
      resolve();
    };
    socket.on('message', onMessage);
    socket.once('error', reject);
  });
  return socket;
}

function nextOfType(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type}`));
    }, 2_000);
    const onMessage = (data: WebSocket.RawData) => {
      const value = JSON.parse(data.toString()) as Record<string, unknown>;
      if (value.type !== type) return;
      cleanup();
      resolve(value);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
    };
    socket.on('message', onMessage);
  });
}
