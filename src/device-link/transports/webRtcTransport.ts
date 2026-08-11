export interface WebRtcSignalFrame {
  type: 'signal';
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export interface WebRtcSignalingPort {
  send(frame: WebRtcSignalFrame): void | Promise<void>;
  subscribe(listener: (frame: WebRtcSignalFrame) => void): () => void;
}

export interface WebRtcDataTransportOptions {
  signaling: WebRtcSignalingPort;
  role: 'initiator' | 'responder';
  iceServers?: RTCIceServer[];
  requireRelay?: boolean;
  connectTimeoutMs?: number;
  channelLabel?: string;
  peerConnectionFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
}

export interface WebRtcTransportDiagnostics {
  state: RTCPeerConnectionState | 'new' | 'timed-out';
  iceConnectionState: RTCIceConnectionState;
  signalingState: RTCSignalingState;
  hasTurnServer: boolean;
  reason?: string;
}

export class WebRtcDeviceLinkTransport {
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private unsubscribe?: () => void;
  private readonly listeners = new Set<(data: string) => void>();
  private diagnosticsValue?: WebRtcTransportDiagnostics;

  constructor(private readonly options: WebRtcDataTransportOptions) {
    validateIceServers(options.iceServers ?? [], options.requireRelay === true);
  }

  async connect(): Promise<void> {
    if (this.channel?.readyState === 'open') return;
    if (this.peer) throw new Error('WebRTC Device Link connection is already starting.');
    const factory = this.options.peerConnectionFactory ?? defaultPeerConnectionFactory;
    const peer = factory({ iceServers: this.options.iceServers ?? [] });
    this.peer = peer;
    const opened = deferred<void>();
    const failed = deferred<never>();
    peer.onicecandidate = event => {
      if (event.candidate) void this.options.signaling.send({
        type: 'signal',
        candidate: event.candidate.toJSON(),
      });
    };
    peer.onconnectionstatechange = () => {
      this.captureDiagnostics();
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        failed.reject(new WebRtcTransportError(this.failureMessage(), this.diagnostics()));
      }
    };
    this.unsubscribe = this.options.signaling.subscribe(frame => {
      void this.handleSignal(frame).catch(error => failed.reject(error));
    });
    if (this.options.role === 'initiator') {
      this.attachChannel(peer.createDataChannel(this.options.channelLabel ?? 'hadamard-device-link', {
        ordered: true,
      }), opened, failed);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await this.options.signaling.send({ type: 'signal', description: offer });
    } else {
      peer.ondatachannel = event => this.attachChannel(event.channel, opened, failed);
    }
    const timeoutMs = this.options.connectTimeoutMs ?? 15_000;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        this.captureDiagnostics('timed-out', 'No direct or TURN-relayed WebRTC path became available.');
        reject(new WebRtcTransportError(this.failureMessage(), this.diagnostics()));
      }, timeoutMs);
    });
    try {
      await Promise.race([opened.promise, failed.promise, timedOut]);
    } catch (error) {
      this.close();
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  send(data: string): void {
    if (!this.channel || this.channel.readyState !== 'open') {
      throw new Error('WebRTC Device Link data channel is not open.');
    }
    this.channel.send(data);
  }

  onMessage(listener: (data: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  addMediaStream(stream: MediaStream): void {
    const peer = this.peer;
    if (!peer) throw new Error('Connect WebRTC before adding media tracks.');
    for (const track of stream.getTracks()) peer.addTrack(track, stream);
  }

  diagnostics(): WebRtcTransportDiagnostics {
    if (this.diagnosticsValue) return structuredClone(this.diagnosticsValue);
    const peer = this.peer;
    return {
      state: peer?.connectionState ?? 'new',
      iceConnectionState: peer?.iceConnectionState ?? 'new',
      signalingState: peer?.signalingState ?? 'stable',
      hasTurnServer: hasTurnServer(this.options.iceServers ?? []),
    };
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.channel?.close();
    this.peer?.close();
    this.channel = undefined;
    this.peer = undefined;
  }

  private attachChannel(
    channel: RTCDataChannel,
    opened: ReturnType<typeof deferred<void>>,
    failed: ReturnType<typeof deferred<never>>,
  ): void {
    this.channel = channel;
    channel.onopen = () => opened.resolve();
    channel.onerror = () => failed.reject(new WebRtcTransportError(
      'WebRTC data channel failed.',
      this.diagnostics(),
    ));
    channel.onmessage = event => {
      if (typeof event.data === 'string') for (const listener of this.listeners) listener(event.data);
    };
  }

  private async handleSignal(frame: WebRtcSignalFrame): Promise<void> {
    const peer = this.peer;
    if (!peer || frame.type !== 'signal') return;
    if (frame.description) {
      await peer.setRemoteDescription(frame.description);
      if (frame.description.type === 'offer') {
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        await this.options.signaling.send({ type: 'signal', description: answer });
      }
    } else if (frame.candidate) {
      await peer.addIceCandidate(frame.candidate);
    }
  }

  private captureDiagnostics(
    state?: WebRtcTransportDiagnostics['state'],
    reason?: string,
  ): void {
    const peer = this.peer;
    this.diagnosticsValue = {
      state: state ?? peer?.connectionState ?? 'new',
      iceConnectionState: peer?.iceConnectionState ?? 'new',
      signalingState: peer?.signalingState ?? 'stable',
      hasTurnServer: hasTurnServer(this.options.iceServers ?? []),
      ...(reason ? { reason } : {}),
    };
  }

  private failureMessage(): string {
    return hasTurnServer(this.options.iceServers ?? [])
      ? 'WebRTC failed even though a TURN route was configured; inspect TURN reachability and credentials.'
      : 'WebRTC found no direct path and no TURN relay is configured.';
  }
}

export class WebRtcTransportError extends Error {
  constructor(message: string, readonly diagnostics: WebRtcTransportDiagnostics) {
    super(message);
    this.name = 'WebRtcTransportError';
  }
}

export function validateIceServers(servers: RTCIceServer[], requireRelay: boolean): void {
  for (const server of servers) {
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    if (urls.length === 0) throw new Error('ICE server requires at least one URL.');
    for (const url of urls) {
      if (!/^(?:stun|turn|turns):/iu.test(url)) throw new Error(`Unsupported ICE server URL: ${url}`);
      if (/^turns?:/iu.test(url) && (!server.username || !server.credential)) {
        throw new Error('TURN servers require explicit username and credential.');
      }
    }
  }
  if (requireRelay && !hasTurnServer(servers)) throw new Error('Relay-only WebRTC requires a configured TURN server.');
}

function hasTurnServer(servers: RTCIceServer[]): boolean {
  return servers.some(server => {
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    return urls.some(url => /^turns?:/iu.test(url));
  });
}

function defaultPeerConnectionFactory(configuration: RTCConfiguration): RTCPeerConnection {
  if (typeof globalThis.RTCPeerConnection !== 'function') {
    throw new Error('WebRTC is unavailable in this runtime; use Electron/browser or inject a peerConnectionFactory.');
  }
  return new globalThis.RTCPeerConnection(configuration);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
