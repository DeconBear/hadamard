import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createConnection, createServer } from 'node:net';

export interface SshTunnelOptions {
  host: string;
  user: string;
  remotePort: number;
  localPort?: number;
  identityFile?: string;
  knownHostsFile?: string;
  connectTimeoutMs?: number;
}

export interface SshProcessPort {
  readonly stderr: NodeJS.ReadableStream;
  readonly exitCode: number | null;
  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SshProcessFactory = (command: string, args: string[]) => SshProcessPort;

export class SshTunnelTransport {
  private process?: SshProcessPort;
  private localPort?: number;

  constructor(
    private readonly options: SshTunnelOptions,
    private readonly processFactory: SshProcessFactory = defaultProcessFactory,
  ) {
    validateSshOptions(options);
  }

  async start(): Promise<{ url: string; localPort: number }> {
    if (this.process && this.localPort) return { url: `wss://127.0.0.1:${this.localPort}`, localPort: this.localPort };
    const localPort = this.options.localPort ?? await availablePort();
    const args = [
      '-N',
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=20',
      '-o', 'ServerAliveCountMax=3',
      ...(this.options.knownHostsFile ? ['-o', `UserKnownHostsFile=${this.options.knownHostsFile}`] : []),
      ...(this.options.identityFile ? ['-i', this.options.identityFile] : []),
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${this.options.remotePort}`,
      `${this.options.user}@${this.options.host}`,
    ];
    const process = this.processFactory('ssh', args);
    this.process = process;
    this.localPort = localPort;
    let stderr = '';
    process.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-4_096); });
    try {
      await waitForTunnel(process, localPort, this.options.connectTimeoutMs ?? 10_000, () => stderr);
      return { url: `wss://127.0.0.1:${localPort}`, localPort };
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.process?.kill('SIGTERM');
    this.process = undefined;
    this.localPort = undefined;
  }
}

function validateSshOptions(options: SshTunnelOptions): void {
  if (!/^[A-Za-z0-9._:-]{1,255}$/u.test(options.host)) throw new Error('Invalid SSH host.');
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(options.user)) throw new Error('Invalid SSH user.');
  for (const [name, value] of [['remotePort', options.remotePort], ['localPort', options.localPort]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > 65_535)) {
      throw new Error(`Invalid SSH ${name}.`);
    }
  }
  if (options.identityFile?.includes('\0') || options.knownHostsFile?.includes('\0')) {
    throw new Error('SSH paths cannot contain NUL.');
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local tunnel port.');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

async function waitForTunnel(
  process: SshProcessPort,
  port: number,
  timeoutMs: number,
  stderr: () => string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (process.exitCode !== null) throw new Error(`SSH tunnel exited before becoming ready: ${stderr()}`);
    const connected = await new Promise<boolean>(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.setTimeout(250, () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`SSH tunnel did not become reachable within ${timeoutMs}ms: ${stderr()}`);
}

function defaultProcessFactory(command: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(command, args, { shell: false, windowsHide: true, stdio: 'pipe' });
}
