// Fake Hcanvas sidecar for broker tests (JSON-RPC 2.0 over Content-Length
// framed stdio). No external deps; Node ESM.
//
// Modes: --mode=stubborn (ignore shutdown exit), --mode=no-init (never answer
// initialize), --mode=crash-on-start (write stderr, then exit 3 without init).
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const mode = args.find(value => value.startsWith('--mode='))?.slice('--mode='.length) ?? 'full';

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body]);
}

function write(message) {
  process.stdout.write(frame(message));
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function notify(method, params) {
  write({ jsonrpc: '2.0', method, params });
}

const artifactPath = path.join(process.cwd(), 'out.txt');
try {
  writeFileSync(artifactPath, 'artifact-data');
} catch {
  /* cwd may be read-only in some sandboxes; artifact validation still runs */
}

const pendingSlow = new Map();

function readFrames() {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = buffer.subarray(0, headerEnd).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) process.exit(2);
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) break;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.subarray(bodyStart + length);
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      try {
        handle(message);
      } catch (error) {
        process.stderr.write('fake sidecar handler error: ' + String(error) + '\n');
        process.exit(4);
      }
    }
  });
}

function handle(message) {
  if (message.method === 'initialize') {
    if (mode === 'no-init') return;
    if (mode === 'crash-on-start') {
      process.stderr.write('fake sidecar crashed before initialize\n');
      setTimeout(() => process.exit(3), 20);
      return;
    }
    respond(message.id, {
      protocolVersion: '1.0',
      serverInfo: { name: 'fake-sidecar', version: '1.0.0' },
      capabilities: {
        requests: [
          { method: 'echo' },
          { method: 'render', progress: true },
          { method: 'slow' },
          { method: 'slow-cancelable' },
          { method: 'flood' },
          { method: 'seqs' },
          { method: 'log' },
          { method: 'bigline' },
          { method: 'artifact' },
          { method: 'crash' },
          { method: 'stderr' },
          { method: 'shutdown' },
        ],
        features: { progress: true, cancel: true, artifacts: true },
      },
    });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === '$/cancelRequest') {
    const id = message.params?.id;
    if (pendingSlow.has(String(id))) {
      pendingSlow.delete(String(id));
      respondError(id, -32800, 'Request cancelled');
    }
    return;
  }
  if (message.id === undefined) return;
  const params = message.params ?? {};
  switch (message.method) {
    case 'echo':
      respond(message.id, params);
      return;
    case 'shutdown':
      respond(message.id, {});
      if (mode !== 'stubborn') setTimeout(() => process.exit(0), 5);
      return;
    case 'crash':
      process.exit(1);
      return;
    case 'slow':
    case 'slow-cancelable':
      pendingSlow.set(String(message.id), true);
      return;
    case 'render': {
      const chunks = Number(params.chunks ?? 3);
      notify('$/progress', { token: message.id, value: { kind: 'begin', percentage: 0 } });
      for (let index = 1; index <= chunks; index += 1) {
        notify('output', { requestId: message.id, stream: 'stdout', seq: index, chunk: 'chunk' + index + '\n' });
        notify('$/progress', { token: message.id, value: { kind: 'report', percentage: Math.round((index / chunks) * 100) } });
      }
      notify('$/progress', { token: message.id, value: { kind: 'end', percentage: 100 } });
      respond(message.id, {
        ok: true,
        artifacts: [
          { kind: 'artifact', path: 'out.txt', name: 'out.txt', mime: 'text/plain' },
          { kind: 'artifact', path: '../escape.txt', name: 'escape', mime: 'text/plain' },
        ],
      });
      return;
    }
    case 'flood': {
      const count = Number(params.count ?? 5000);
      const chunk = 'x'.repeat(Number(params.chunkSize ?? 10));
      const frames = [];
      for (let index = 1; index <= count; index += 1) {
        frames.push(frame({ jsonrpc: '2.0', method: 'output', params: { requestId: message.id, stream: 'stdout', seq: index, chunk } }));
      }
      process.stdout.write(Buffer.concat(frames));
      respond(message.id, { ok: true, count });
      return;
    }
    case 'seqs': {
      const seqs = params.seqs ?? [1, 2, 2, 4];
      const chunks = params.chunks ?? ['a', 'b', 'c', 'd'];
      for (let index = 0; index < seqs.length; index += 1) {
        notify('output', { requestId: message.id, stream: 'stdout', seq: seqs[index], chunk: chunks[index] });
      }
      respond(message.id, { ok: true });
      return;
    }
    case 'log': {
      notify('log', { level: 'warn', message: 'L'.repeat(Number(params.size ?? 200)) });
      respond(message.id, { ok: true });
      return;
    }
    case 'bigline': {
      notify('output', { requestId: message.id, stream: 'stdout', seq: 1, chunk: 'y'.repeat(Number(params.size ?? 1000)) });
      respond(message.id, { ok: true });
      return;
    }
    case 'artifact': {
      notify('artifact', { kind: 'artifact', path: 'out.txt', name: 'out.txt', mime: 'text/plain' });
      notify('artifact', { kind: 'artifact', path: '../escape.txt', name: 'escape', mime: 'text/plain' });
      respond(message.id, { ok: true });
      return;
    }
    case 'stderr': {
      process.stderr.write('stderr line one\nstderr line two\n');
      respond(message.id, { ok: true });
      return;
    }
    default:
      respondError(message.id, -32601, 'Method not found: ' + message.method);
  }
}

readFrames();
