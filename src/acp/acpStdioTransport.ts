import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import {
  ACP_ERROR_PARSE,
  acpError,
  acpErrorFromException,
  parseAcpMessage,
  type AcpServerResponse,
} from './acpProtocol.js';
import type { AcpServer } from './acpServer.js';
import type { AcpClientChannel } from './acpPermissionBridge.js';

/**
 * NDJSON JSON-RPC transport for the ACP server. Requests are dispatched
 * concurrently so session/cancel notifications can interrupt an in-flight
 * prompt; outgoing client requests (session/request_permission) correlate
 * by a server-namespaced id. stdout carries protocol frames only — all
 * diagnostics go to stderr.
 */
export class AcpStdioTransport implements AcpClientChannel {
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private outgoingCounter = 0;

  constructor(
    private readonly server: AcpServer,
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
    private readonly log: (line: string) => void = line => process.stderr.write(`${line}\n`),
  ) {}

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = `hadamard-acp-${++this.outgoingCounter}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async start(): Promise<void> {
    const lines = createInterface({ input: this.input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        this.dispatchLine(line);
      }
    } finally {
      // stdin EOF: reject dangling client requests so in-flight approvers
      // resolve (as deny) instead of hanging past process teardown.
      const eof = new Error('ACP transport closed (stdin EOF).');
      for (const pending of this.pending.values()) pending.reject(eof);
      this.pending.clear();
      this.server.shutdown('ACP transport closed');
    }
  }

  private dispatchLine(line: string): void {
    let parsed;
    try {
      parsed = parseAcpMessage(JSON.parse(line));
    } catch (error) {
      if (error instanceof SyntaxError) {
        this.write(acpError(null, ACP_ERROR_PARSE, 'Parse error.'));
      } else {
        this.write(acpErrorFromException(null, error));
      }
      return;
    }
    switch (parsed.kind) {
      case 'response': {
        const pendingKey = String(parsed.id);
        const pending = this.pending.get(pendingKey);
        if (!pending) return; // Late or unknown response; ignore.
        this.pending.delete(pendingKey);
        if (parsed.error) {
          pending.reject(new Error(`ACP client error ${parsed.error.code}: ${parsed.error.message}`));
        } else {
          pending.resolve(parsed.result);
        }
        return;
      }
      case 'notification':
        void this.server.handleNotification(parsed).catch(error => {
          this.log(`hadamard-acp: notification ${parsed.method} failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        return;
      case 'request':
        void this.server.handleRequest(parsed, this)
          .catch(error => acpErrorFromException(parsed.id, error))
          .then((response: AcpServerResponse) => this.write(response));
        return;
    }
  }

  private write(value: unknown): void {
    this.output.write(`${JSON.stringify(value)}\n`);
  }
}
