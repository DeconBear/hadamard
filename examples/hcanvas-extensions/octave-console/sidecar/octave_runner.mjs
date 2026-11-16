// GNU Octave sidecar runner for the Hcanvas Octave Console example.
// JSON-RPC 2.0 over stdio with LSP Content-Length framing.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = process.stdout;
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  OUT.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body]));
}
function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }
function respondError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function truncate(text, limit) {
  const value = String(text || '');
  return value.length > limit ? value.slice(0, limit) + '\n… truncated' : value;
}

function octaveCommand() {
  const override = process.env.HCANVAS_OCTAVE_BIN;
  return override && override.trim() ? override.trim() : 'octave';
}

function runRequest(params) {
  const code = typeof params?.code === 'string' ? params.code : '';
  if (!code.trim()) return { ok: false, stage: 'validate', error: 'No code to run.' };
  const command = octaveCommand();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hcanvas-octave-'));
  const script = path.join(dir, 'snippet.m');
  writeFileSync(script, code, 'utf8');
  const started = Date.now();
  try {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (probe.error || (probe.status !== 0 && !probe.stdout && !probe.stderr)) {
      return { ok: false, stage: 'toolchain', error: 'GNU Octave was not found on PATH. Install Octave and retry (or set HCANVAS_OCTAVE_BIN).' };
    }
    const result = spawnSync(command, ['--no-gui', '--quiet', script], { cwd: dir, encoding: 'utf8', timeout: 120000, windowsHide: true });
    const artifacts = [];
    for (const name of readdirSync(dir)) {
      if (!/\.(png|svg)$/i.test(name)) continue;
      const file = path.join(dir, name);
      const data = readFileSync(file);
      if (data.length > 8 * 1024 * 1024) continue;
      artifacts.push({ mime: name.endsWith('.svg') ? 'image/svg+xml' : 'image/png', name, dataBase64: data.toString('base64') });
    }
    return {
      ok: result.status === 0,
      stage: result.status === 0 ? 'run' : 'error',
      exitCode: result.status,
      stdout: truncate(result.stdout, 1024 * 1024),
      stderr: truncate(result.stderr, 1024 * 1024),
      artifacts: artifacts.slice(0, 4),
      durationMs: Date.now() - started,
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function handle(message) {
  if (message.method === 'initialize') {
    respond(message.id, { protocolVersion: '1.0', serverInfo: { name: 'hcanvas-octave-runner', version: '0.1.0' }, capabilities: { requests: [{ method: 'run' }] } });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'shutdown') { respond(message.id, {}); setTimeout(() => process.exit(0), 10); return; }
  if (message.method !== 'run' || message.id === undefined) {
    if (message.id !== undefined) respondError(message.id, -32601, 'Method not found: ' + String(message.method));
    return;
  }
  try { respond(message.id, runRequest(message.params || {})); }
  catch (error) { respondError(message.id, -32603, error instanceof Error ? error.message : String(error)); }
}

function consume() {
  for (;;) {
    const idx = buffer.indexOf('\r\n\r\n');
    if (idx < 0) return;
    const header = buffer.subarray(0, idx).toString('ascii');
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) { buffer = buffer.subarray(idx + 4); continue; }
    const length = Number(match[1]);
    if (buffer.length < idx + 4 + length) return;
    const body = buffer.subarray(idx + 4, idx + 4 + length).toString('utf8');
    buffer = buffer.subarray(idx + 4 + length);
    try { handle(JSON.parse(body)); } catch { /* ignore malformed frames */ }
  }
}

process.stdin.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); consume(); });
process.stdin.on('end', () => process.exit(0));
