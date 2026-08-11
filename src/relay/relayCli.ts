#!/usr/bin/env node
import { HadamardRelayServer } from './relayServer.js';

export async function runHadamardRelayCli(
  argv = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const options = parseRelayCliOptions(argv);
  const authSecret = environment.HADAMARD_RELAY_SECRET;
  if (!authSecret) throw new Error('Set HADAMARD_RELAY_SECRET to at least 32 bytes.');
  const relay = new HadamardRelayServer({
    authSecret,
    host: options.host,
    port: options.port,
    allowPublic: options.allowPublic,
  });
  const address = await relay.start();
  process.stdout.write(`${JSON.stringify({ type: 'ready', ...address })}\n`);
  const shutdown = async () => {
    await relay.stop();
    process.exitCode = 0;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

export function parseRelayCliOptions(argv: string[]): {
  host?: string;
  port?: number;
  allowPublic: boolean;
} {
  let host: string | undefined;
  let port: number | undefined;
  let allowPublic = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--allow-public') allowPublic = true;
    else if (argument === '--host') host = argv[++index];
    else if (argument === '--port') {
      const value = Number(argv[++index]);
      if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) throw new Error('Invalid relay port.');
      port = value;
    } else throw new Error('Usage: hadamard-relay [--host <address>] [--port <port>] [--allow-public]');
  }
  if (host !== undefined && !host.trim()) throw new Error('Relay host cannot be empty.');
  return { host, port, allowPublic };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/gu, '/')}`) {
  runHadamardRelayCli().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
