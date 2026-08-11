import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type { AppServer } from '../appServer.js';
import { APP_SERVER_LEGACY_PROTOCOL_VERSION, parseAppServerRequest } from '../protocol.js';

export class StdioAppServerTransport {
  constructor(
    private readonly server: AppServer,
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
  ) {}

  async start(): Promise<void> {
    const lines = createInterface({ input: this.input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = await this.server.handle(
          parseAppServerRequest(JSON.parse(line)),
          notification => this.write(notification),
        );
        this.write(response);
      } catch (error) {
        this.write({
          version: APP_SERVER_LEGACY_PROTOCOL_VERSION,
          id: '',
          error: {
            code: 'INVALID_REQUEST',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  private write(value: unknown): void {
    this.output.write(`${JSON.stringify(value)}\n`);
  }
}
