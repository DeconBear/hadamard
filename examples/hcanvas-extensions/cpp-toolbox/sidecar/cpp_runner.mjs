// C++ sidecar runner for the Hcanvas C++ Toolbox example.
// JSON-RPC 2.0 over stdio with LSP Content-Length framing.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function findCompiler() {
  const candidates = process.platform === 'win32' ? ['g++', 'clang++', 'cl'] : ['g++', 'clang++'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, candidate === 'cl' ? ['/nologo', '/?'] : ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (probe.status === 0 || probe.stdout || probe.stderr) return candidate;
  }
  return null;
}

function runRequest(params) {
  const code = typeof params?.code === 'string' ? params.code : '';
  const args = Array.isArray(params?.args) ? params.args.map(String).slice(0, 20) : [];
  if (!code.trim()) return { ok: false, stage: 'validate', error: 'No code to compile.' };
  const compiler = findCompiler();
  if (!compiler) return { ok: false, stage: 'toolchain', error: 'No C++ compiler found (install g++/clang++ and put it on PATH).' };
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hcanvas-cpp-'));
  const source = path.join(dir, 'main.cpp');
  const binary = path.join(dir, process.platform === 'win32' ? 'main.exe' : 'main');
  writeFileSync(source, code, 'utf8');
  const started = Date.now();
  try {
    const compileArgs = compiler === 'cl'
      ? ['/nologo', '/std:c++17', '/O2', '/EHsc', '/Fe:' + binary, source]
      : ['-std=c++17', '-O2', '-o', binary, source];
    const compile = spawnSync(compiler, compileArgs, { cwd: dir, encoding: 'utf8', timeout: 120000, windowsHide: true });
    const compileStdout = truncate(compile.stdout, 1024 * 1024);
    const compileStderr = truncate(compile.stderr, 1024 * 1024);
    if (compile.status !== 0 || compile.error) {
      return { ok: false, stage: 'compile', compiler, exitCode: compile.status, stdout: compileStdout, stderr: compileStderr, error: compile.error ? String(compile.error.message || compile.error) : 'Compilation failed.', durationMs: Date.now() - started };
    }
    const run = spawnSync(binary, args, { cwd: dir, encoding: 'utf8', timeout: 30000, windowsHide: true });
    return {
      ok: true,
      compiler,
      exitCode: run.status,
      timedOut: run.error && run.error.code === 'ETIMEDOUT',
      stdout: truncate(run.stdout, 1024 * 1024),
      stderr: truncate(run.stderr, 1024 * 1024),
      compile: { stdout: compileStdout, stderr: compileStderr },
      durationMs: Date.now() - started,
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function handle(message) {
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: '1.0',
      serverInfo: { name: 'hcanvas-cpp-runner', version: '0.1.0' },
      capabilities: { requests: [{ method: 'run' }], features: { progress: false, cancel: false, artifacts: false } },
    });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'shutdown') { respond(message.id, {}); setTimeout(() => process.exit(0), 10); return; }
  if (message.method === 'exit') { process.exit(0); return; }
  if (message.method !== 'run' || message.id === undefined) {
    if (message.id !== undefined) respondError(message.id, -32601, 'Method not found: ' + String(message.method));
    return;
  }
  try {
    respond(message.id, runRequest(message.params || {}));
  } catch (error) {
    respondError(message.id, -32603, error instanceof Error ? error.message : String(error));
  }
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
