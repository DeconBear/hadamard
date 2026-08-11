import { isIP } from 'node:net';

import WebSocket from 'ws';

import type { OpaqueRelayEnvelope } from '../../relay/opaqueRelay.js';
import type { WebRtcSignalFrame, WebRtcSignalingPort } from './webRtcTransport.js';

export interface RelaySignalingClientOptions {
  url: string;
  deviceId: string;
  roomId: string;
  expires: number;
  token: string;
  connectTimeoutMs?: number;
}

export class RelaySignalingClient implements WebRtcSignalingPort {
  private socket?: WebSocket;
  private readonly signalListeners = new Set<(frame: WebRtcSignalFrame) => void>();
  private readonly opaqueListeners = new Set<(frame: OpaqueRelayEnvelope) => void>();

  constructor(private readonly options: RelaySignalingClientOptions) {}

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const url = relayUrl(this.options);
    const socket = new WebSocket(url, { perMessageDeflate: false });
    this.socket = socket;
    const timeoutMs = this.options.connectTimeoutMs ?? 10_000;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error(`Relay connection timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off('open', onOpen);
        socket.off('error', onError);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });
    socket.on('message', data => this.receive(data.toString()));
  }

  send(frame: WebRtcSignalFrame): void {
    this.sendFrame(frame);
  }

  sendOpaque(frame: OpaqueRelayEnvelope): void {
    this.sendFrame(frame);
  }

  subscribe(listener: (frame: WebRtcSignalFrame) => void): () => void {
    this.signalListeners.add(listener);
    return () => this.signalListeners.delete(listener);
  }

  onOpaque(listener: (frame: OpaqueRelayEnvelope) => void): () => void {
    this.opaqueListeners.add(listener);
    return () => this.opaqueListeners.delete(listener);
  }

  close(): void {
    this.socket?.close(1000, 'Complete');
    this.socket = undefined;
  }

  private sendFrame(frame: WebRtcSignalFrame | OpaqueRelayEnvelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Relay connection is not open.');
    this.socket.send(JSON.stringify(frame));
  }

  private receive(text: string): void {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.type === 'signal') {
      for (const listener of this.signalListeners) listener(value as unknown as WebRtcSignalFrame);
    } else if (value.type === 'opaque') {
      for (const listener of this.opaqueListeners) listener(value as unknown as OpaqueRelayEnvelope);
    }
  }
}

function relayUrl(options: RelaySignalingClientOptions): URL {
  const url = new URL(options.url);
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new Error('Relay URL must use WSS or WS.');
  if (url.protocol === 'ws:' && !isPrivateRelayHost(url.hostname)) {
    throw new Error('Plain WS relay is allowed only for loopback or private-network hosts.');
  }
  url.searchParams.set('deviceId', options.deviceId);
  url.searchParams.set('roomId', options.roomId);
  url.searchParams.set('expires', String(options.expires));
  url.searchParams.set('token', options.token);
  return url;
}

function isPrivateRelayHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/gu, '').toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (isIP(normalized) === 4) {
    const [first, second] = normalized.split('.').map(Number);
    return first === 127 || first === 10 || (first === 192 && second === 168)
      || (first === 172 && second !== undefined && second >= 16 && second <= 31);
  }
  return isIP(normalized) === 6 && (normalized.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/u.test(normalized));
}
