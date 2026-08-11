import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer, type Server } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SshTunnelTransport,
  validateIceServers,
  WebRtcDeviceLinkTransport,
  WebRtcTransportError,
  type SshProcessPort,
  type WebRtcSignalFrame,
  type WebRtcSignalingPort,
} from '../src/device-link/index.js';

const listeners: Server[] = [];

afterEach(async () => {
  await Promise.all(listeners.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('advanced Device Link transports', () => {
  it('validates self-hosted STUN/TURN configuration and reports truthful WebRTC timeout', async () => {
    expect(() => validateIceServers([{ urls: 'https://not-ice.example' }], false)).toThrow('Unsupported');
    expect(() => validateIceServers([{ urls: 'turn:turn.example' }], true)).toThrow('credential');
    expect(() => validateIceServers([{ urls: 'stun:stun.example' }], true)).toThrow('TURN');

    const signaling = new MemorySignaling();
    const transport = new WebRtcDeviceLinkTransport({
      signaling,
      role: 'initiator',
      connectTimeoutMs: 20,
      peerConnectionFactory: () => fakePeerConnection(),
    });
    await expect(transport.connect()).rejects.toBeInstanceOf(WebRtcTransportError);
    await expect(transport.connect()).rejects.toThrow('no TURN relay');
  });

  it('starts SSH with fixed forwarding and no shell interpolation', async () => {
    let command = '';
    let args: string[] = [];
    let tunnelListener: Server | undefined;
    const processFactory = (nextCommand: string, nextArgs: string[]): SshProcessPort => {
      command = nextCommand;
      args = nextArgs;
      const forward = nextArgs[nextArgs.indexOf('-L') + 1]!;
      const localPort = Number(forward.split(':')[1]);
      tunnelListener = createServer();
      listeners.push(tunnelListener);
      tunnelListener.listen(localPort, '127.0.0.1');
      return new FakeSshProcess(() => tunnelListener?.close());
    };
    const tunnel = new SshTunnelTransport({
      host: 'example.internal',
      user: 'hadamard',
      remotePort: 43100,
      knownHostsFile: 'known_hosts',
    }, processFactory);
    const started = await tunnel.start();
    expect(started.url).toMatch(/^wss:\/\/127\.0\.0\.1:\d+$/u);
    expect(command).toBe('ssh');
    expect(args).toEqual(expect.arrayContaining([
      '-N',
      '-T',
      'BatchMode=yes',
      'ExitOnForwardFailure=yes',
      'UserKnownHostsFile=known_hosts',
      'hadamard@example.internal',
    ]));
    expect(args.join(' ')).not.toContain('sh -c');
    tunnel.stop();
  });
});

class MemorySignaling implements WebRtcSignalingPort {
  private listeners = new Set<(frame: WebRtcSignalFrame) => void>();
  send(): void {}
  subscribe(listener: (frame: WebRtcSignalFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

class FakeSshProcess extends EventEmitter implements SshProcessPort {
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  constructor(private readonly onKill: () => void) { super(); }
  kill(): boolean {
    this.onKill();
    this.exitCode = 0;
    this.emit('exit', 0);
    return true;
  }
}

function fakePeerConnection(): RTCPeerConnection {
  const channel = {
    readyState: 'connecting',
    close() {},
    send() {},
    onopen: null,
    onerror: null,
    onmessage: null,
  } as unknown as RTCDataChannel;
  return {
    connectionState: 'connecting',
    iceConnectionState: 'checking',
    signalingState: 'stable',
    onicecandidate: null,
    onconnectionstatechange: null,
    ondatachannel: null,
    createDataChannel: () => channel,
    createOffer: async () => ({ type: 'offer', sdp: 'v=0' }),
    setLocalDescription: async () => undefined,
    setRemoteDescription: async () => undefined,
    createAnswer: async () => ({ type: 'answer', sdp: 'v=0' }),
    addIceCandidate: async () => undefined,
    addTrack: () => ({}) as RTCRtpSender,
    close() {},
  } as unknown as RTCPeerConnection;
}
