import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NOTEBOOK_VARIABLES_MIME } from '../src/hcanvas/notebook/variables.js';

const running = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  for (const child of running) child.kill();
  running.clear();
});

class KernelClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: Array<Record<string, unknown>> = [];
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private readonly requests = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    running.add(this.child);
    this.child.stdout.on('data', chunk => this.consume(chunk));
    this.child.on('exit', () => {
      for (const request of this.requests.values()) request.reject(new Error('Kernel exited before answering.'));
      this.requests.clear();
    });
  }

  async initialize(): Promise<Record<string, unknown>> {
    const response = await this.request('initialize', { protocolVersion: '1.0' });
    expect(response.protocolVersion).toBe('1.0');
    return response;
  }

  async execute(code: string, variables: Record<string, unknown>): Promise<{ result: Record<string, unknown>; events: Array<Record<string, unknown>> }> {
    const start = this.events.length;
    const result = await this.request('kernel/execute', { executionId: 'test_' + Date.now(), code, variables });
    return { result, events: this.events.slice(start) };
  }

  close(): void {
    this.child.kill();
    running.delete(this.child);
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.sequence;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(method + ' timed out.'));
      }, 30_000);
      this.requests.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]));
    });
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const match = /content-length:\s*(\d+)/iu.exec(this.buffer.subarray(0, headerEnd).toString('ascii'));
      if (!match) { this.buffer = Buffer.alloc(0); return; }
      const length = Number(match[1]);
      if (this.buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8')) as Record<string, unknown>;
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      if (typeof message.id === 'number') {
        const request = this.requests.get(message.id);
        this.requests.delete(message.id);
        if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
        else request?.resolve((message.result || {}) as Record<string, unknown>);
      } else this.events.push(message);
    }
  }
}

function commandAvailable(command: string): boolean {
  return spawnSync(command, ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0;
}

const pythonAvailable = commandAvailable('python');
const cppAvailable = commandAvailable('g++') || commandAvailable('clang++');
const pythonKernel = path.resolve('examples/hcanvas-extensions/python-kernel/sidecar/hcanvas_python_kernel.py');
const cppKernel = path.resolve('examples/hcanvas-extensions/cpp-kernel/sidecar/cpp_kernel.mjs');
const octaveKernel = path.resolve('examples/hcanvas-extensions/octave-kernel/sidecar/octave_kernel.mjs');

function sharedSnapshot(events: Array<Record<string, unknown>>): Record<string, unknown> {
  const event = events.find(item => item.method === 'kernel/display_data' && item.params && typeof item.params === 'object' && NOTEBOOK_VARIABLES_MIME in (item.params as { data?: Record<string, unknown> }).data!);
  return event ? ((event.params as { data: Record<string, Record<string, unknown>> }).data[NOTEBOOK_VARIABLES_MIME] || {}) : {};
}

describe('real notebook kernel variables', () => {
  it.skipIf(!pythonAvailable)('keeps Python variables across executions and displays expression results', async () => {
    const client = new KernelClient('python', ['-u', pythonKernel]);
    try {
      await client.initialize();
      const first = await client.execute('doubled = distance * 2\nhc_set("doubled", doubled)\ndoubled', { distance: 12, greeting: 'shared' });
      expect(first.result.status).toBe('ok');
      expect(sharedSnapshot(first.events)).toMatchObject({ distance: 12, doubled: 24, greeting: 'shared' });
      const expression = first.events.find(event => event.method === 'kernel/execute_result');
      expect(JSON.stringify(expression)).toContain('24');
      const second = await client.execute('hc_set("greeting", greeting + " / C++")\nprint(hc_get("doubled"))', { distance: 12, doubled: 24, greeting: 'shared' });
      expect(second.result.status).toBe('ok');
      expect(sharedSnapshot(second.events)).toMatchObject({ doubled: 24, greeting: 'shared / C++' });
      expect(JSON.stringify(second.events)).toContain('24');
      const afterDelete = await client.execute('print("after delete")', { distance: 12, doubled: 24 });
      expect(afterDelete.result.status).toBe('ok');
      expect(sharedSnapshot(afterDelete.events)).toEqual({ distance: 12, doubled: 24 });
    } finally { client.close(); }
  }, 40_000);

  it.skipIf(!cppAvailable)('reads portable variables in C++ and publishes updated values', async () => {
    const client = new KernelClient(process.execPath, [cppKernel]);
    try {
      await client.initialize();
      const execution = await client.execute('total += 5;\nhc_set("total", total);\nstd::cout << greeting << ":" << total << std::endl;', { total: 7, greeting: 'shared / C++' });
      expect(execution.result.status, JSON.stringify(execution.events)).toBe('ok');
      expect(sharedSnapshot(execution.events)).toMatchObject({ total: 12, greeting: 'shared / C++' });
      expect(JSON.stringify(execution.events)).toContain('shared / C++:12');
    } finally { client.close(); }
  }, 40_000);

  it('uses an auto-detected Octave installation for shared variables when available', async context => {
    const client = new KernelClient(process.execPath, [octaveKernel]);
    try {
      const info = await client.initialize();
      if (info.languageVersion === 'unknown') { context.skip(); return; }
      const execution = await client.execute('total = total + 5;\nhc_set("total", total);\ndisp(greeting);', { total: 7, greeting: 'shared / Octave' });
      expect(execution.result.status, JSON.stringify(execution.events)).toBe('ok');
      expect(sharedSnapshot(execution.events)).toMatchObject({ total: 12, greeting: 'shared / Octave' });
      expect(JSON.stringify(execution.events)).toContain('shared / Octave');
      const afterDelete = await client.execute('disp("after delete");', { total: 12 });
      expect(afterDelete.result.status, JSON.stringify(afterDelete.events)).toBe('ok');
      expect(sharedSnapshot(afterDelete.events)).toEqual({ total: 12 });
    } finally { client.close(); }
  }, 50_000);
});
