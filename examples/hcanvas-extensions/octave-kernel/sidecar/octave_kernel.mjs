#!/usr/bin/env node
/**
 * Hcanvas GNU Octave kernel sidecar (HKP 1.0, JSON-RPC over stdio).
 *
 * Keeps one long-lived interactive Octave process so variables survive across
 * cells. User code is written to a temp script and executed through `source`
 * inside a try/catch; new figures are printed to PNG and sent as display MIME
 * bundles. Interrupt kills the process (state is lost) and the next execution
 * starts a fresh one.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROTOCOL_VERSION = '1.0';
const OUT = process.stdout;
let buffer = Buffer.alloc(0);
let child = null;
let childGeneration = 0;
let current = null;
let tmpDir = '';
let versionCache = '';
let stopping = false;
let outLine = '';
let errLine = '';
let suppressGnuplotNotice = false;

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  OUT.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body]));
}
function respond(id, result) { if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, result }); }
function respondError(id, code, message) { if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, error: { code, message } }); }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }

function registryOctaveCandidates() {
  if (process.platform !== 'win32') return [];
  const candidates = [];
  for (const hive of ['HKLM', 'HKCU']) {
    const probe = spawnSync('reg.exe', ['query', hive + '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'Octave', '/d'], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    for (const line of String(probe.stdout || '').split(/\r?\n/)) {
      const match = /InstallLocation\s+REG_\w+\s+(.+)$/i.exec(line);
      if (!match) continue;
      const location = match[1].trim().replace(/\\+$/, '');
      if (!location) continue;
      candidates.push(path.join(location, 'mingw64', 'bin', 'octave.exe'));
      candidates.push(path.join(location, 'bin', 'octave.exe'));
      candidates.push(path.join(location, 'octave.exe'));
    }
  }
  return candidates;
}

function octaveCommand() {
  const override = (process.env.OCTAVE_BIN || process.env.HCANVAS_OCTAVE_BIN || '').trim();
  if (override) return override;
  for (const candidate of registryOctaveCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return 'octave';
}

function octaveVersion() {
  if (versionCache) return versionCache;
  try {
    const probe = spawnSync(octaveCommand(), ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const first = String(probe.stdout || '').split(/\r?\n/)[0] || '';
    const match = /version\s+([0-9][^\s]*)/i.exec(first) || /([0-9]+\.[0-9]+\.[0-9]+)/.exec(first);
    versionCache = match ? match[1] : 'unknown';
  } catch {
    versionCache = 'unknown';
  }
  return versionCache;
}

function ensureTmpDir() {
  if (!tmpDir || !existsSync(tmpDir)) tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hcanvas-octave-kernel-'));
  const getter = path.join(tmpDir, 'hc_get.m');
  const setter = path.join(tmpDir, 'hc_set.m');
  if (!existsSync(getter)) writeFileSync(getter, [
    'function value = hc_get(name, default)',
    '  global HCANVAS_SHARED_VARIABLES;',
    '  value = default;',
    '  if isstruct(HCANVAS_SHARED_VARIABLES) && isfield(HCANVAS_SHARED_VARIABLES, name)',
    '    value = HCANVAS_SHARED_VARIABLES.(name);',
    '  end',
    'end',
    '',
  ].join('\n'), 'utf8');
  if (!existsSync(setter)) writeFileSync(setter, [
    'function hc_set(name, value)',
    '  global HCANVAS_SHARED_VARIABLES;',
    '  if ~ischar(name) || ~isvarname(name)',
    "    error('hc_set:invalidName', 'Use a portable variable name.');",
    '  end',
    '  if ~isstruct(HCANVAS_SHARED_VARIABLES), HCANVAS_SHARED_VARIABLES = struct(); end',
    '  try',
    '    HCANVAS_SHARED_VARIABLES.(name) = jsondecode(jsonencode(value));',
    '  catch err',
    "    error('hc_set:invalidValue', 'Shared values must be JSON-compatible: %s', err.message);",
    '  end',
    "  assignin('base', name, value);",
    'end',
    '',
  ].join('\n'), 'utf8');
  return tmpDir;
}

function octavePath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/'/g, "''");
}

function removePath(target) {
  if (!target) return;
  try { rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
}

function emitStream(stream, text) {
  const active = current;
  if (!active || !text) return;
  for (let index = 0; index < text.length; index += 60000) {
    notify('kernel/stream', { executionId: active.executionId, name: stream, text: text.slice(index, index + 60000) });
  }
}

function cleanupCurrentFiles(execution) {
  if (!execution) return;
  if (execution.cellFile) removePath(execution.cellFile);
  if (execution.variableFile) removePath(execution.variableFile);
  for (const image of execution.images) removePath(image);
}

function finishCurrent(status, forcedError) {
  const execution = current;
  if (!execution) return;
  current = null;
  const resolvedStatus = status === 'error' || execution.error || forcedError ? 'error' : status;
  for (const imagePath of execution.images) {
    try {
      const data = readFileSync(imagePath);
      notify('kernel/display_data', {
        executionId: execution.executionId,
        data: { 'text/plain': '<Figure>', 'image/png': data.toString('base64') },
      });
    } catch { /* ignore missing figure */ }
  }
  if (resolvedStatus === 'error') {
    const error = execution.error || forcedError || { ename: 'OctaveError', evalue: 'Octave execution failed.', traceback: [] };
    notify('kernel/error', {
      executionId: execution.executionId,
      ename: error.ename || 'OctaveError',
      evalue: error.evalue || String(error),
      traceback: Array.isArray(error.traceback) ? error.traceback : (error.evalue ? String(error.evalue).split(/\r?\n/) : []),
    });
  }
  notify('kernel/execution_finished', { executionId: execution.executionId, status: resolvedStatus });
  notify('kernel/status', { state: 'idle' });
  respond(execution.requestId, {
    executionId: execution.executionId,
    status: resolvedStatus,
    durationMs: Date.now() - execution.started,
  });
  cleanupCurrentFiles(execution);
}

function handleStdoutLine(line) {
  if (line.endsWith('\r')) line = line.slice(0, -1);
  const execution = current;
  if (line.startsWith('__HCANVAS_DONE__:')) {
    const status = line.slice('__HCANVAS_DONE__:'.length).trim() === 'error' ? 'error' : 'ok';
    finishCurrent(status);
    return;
  }
  if (line.startsWith('__HCANVAS_IMAGE__:')) {
    if (execution) execution.images.push(line.slice('__HCANVAS_IMAGE__:'.length));
    return;
  }
  if (line.startsWith('__HCANVAS_VARIABLES__:')) {
    if (execution) {
      try {
        const variables = JSON.parse(line.slice('__HCANVAS_VARIABLES__:'.length));
        if (variables && typeof variables === 'object' && !Array.isArray(variables)) {
          notify('kernel/display_data', { executionId: execution.executionId, data: { 'application/vnd.hcanvas.variables+json': variables } });
        }
      } catch { /* malformed helper output must not break the kernel */ }
    }
    return;
  }
  if (!execution) return;
  emitStream('stdout', line + '\n');
}

function handleStderrLine(line) {
  if (line.endsWith('\r')) line = line.slice(0, -1);
  // The gnuplot toolkit prints a long host-level notice on first figure print.
  // Qt is not available in this installation, so suppress the noise block.
  if (suppressGnuplotNotice) {
    if (line.includes('The qt toolkit is recommended instead')) suppressGnuplotNotice = false;
    return;
  }
  if (line.startsWith('warning: using the gnuplot graphics toolkit is discouraged')) {
    suppressGnuplotNotice = true;
    return;
  }
  if (line.startsWith('DEBUG: FC_')) return;
  const execution = current;
  if (line.startsWith('__HCANVAS_ERROR__:')) {
    if (execution) {
      try {
        const parsed = JSON.parse(line.slice('__HCANVAS_ERROR__:'.length));
        execution.error = {
          ename: typeof parsed.ename === 'string' ? parsed.ename : 'OctaveError',
          evalue: typeof parsed.evalue === 'string' ? parsed.evalue : String(parsed),
          traceback: typeof parsed.evalue === 'string' ? parsed.evalue.split(/\r?\n/) : [],
        };
      } catch {
        execution.error = { ename: 'OctaveError', evalue: line.slice('__HCANVAS_ERROR__:'.length), traceback: [] };
      }
    }
    return;
  }
  if (!execution) return;
  emitStream('stderr', line + '\n');
}

function onStdout(chunk) {
  outLine += String(chunk);
  for (;;) {
    const index = outLine.indexOf('\n');
    if (index < 0) break;
    const line = outLine.slice(0, index);
    outLine = outLine.slice(index + 1);
    handleStdoutLine(line);
  }
  if (outLine.length > 4 * 1024 * 1024) { handleStdoutLine(outLine); outLine = ''; }
}

function onStderr(chunk) {
  errLine += String(chunk);
  for (;;) {
    const index = errLine.indexOf('\n');
    if (index < 0) break;
    const line = errLine.slice(0, index);
    errLine = errLine.slice(index + 1);
    handleStderrLine(line);
  }
  if (errLine.length > 4 * 1024 * 1024) { handleStderrLine(errLine); errLine = ''; }
}

function attachProcess(proc, generation) {
  proc.stdout.on('data', onStdout);
  proc.stderr.on('data', onStderr);
  proc.once('error', error => {
    if (generation !== childGeneration) return;
    child = null;
    suppressGnuplotNotice = false;
    if (current) finishCurrent('error', { ename: 'OctaveProcessError', evalue: error instanceof Error ? error.message : String(error), traceback: [] });
  });
  proc.once('exit', (code, signal) => {
    if (generation !== childGeneration) return;
    child = null;
    suppressGnuplotNotice = false;
    if (current) {
      finishCurrent('error', { ename: 'OctaveProcessExited', evalue: 'Octave process exited unexpectedly (code ' + String(code) + ', signal ' + String(signal) + ').', traceback: [] });
    }
  });
}

function ensureProcess() {
  if (child && !child.killed) return child;
  ensureTmpDir();
  const generation = ++childGeneration;
  const proc = spawn(octaveCommand(), ['--no-gui', '--quiet', '--no-window-system', '--no-line-editing'], {
    cwd: tmpDir,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child = proc;
  outLine = '';
  errLine = '';
  suppressGnuplotNotice = false;
  attachProcess(proc, generation);
  return proc;
}

function killChild() {
  if (!child) return;
  const proc = child;
  child = null;
  childGeneration += 1;
  try { proc.kill(); } catch { /* best effort */ }
}

function startExecution(id, params) {
  if (current) { respondError(id, -32603, 'Octave kernel is busy'); return; }
  const code = typeof params.code === 'string' ? params.code : '';
  const executionId = typeof params.executionId === 'string' && params.executionId ? params.executionId : 'octave_' + Date.now().toString(36);
  ensureTmpDir();
  const cellFile = path.join(tmpDir, 'cell-' + executionId.replace(/[^A-Za-z0-9_-]+/g, '-') + '.m');
  const variableFile = path.join(tmpDir, 'variables-' + executionId.replace(/[^A-Za-z0-9_-]+/g, '-') + '.json');
  try {
    writeFileSync(cellFile, code, 'utf8');
    writeFileSync(variableFile, JSON.stringify(params.variables && typeof params.variables === 'object' ? params.variables : {}), 'utf8');
  } catch (error) {
    respond(id, { executionId, status: 'error', durationMs: 0 });
    notify('kernel/error', { executionId, ename: 'IOError', evalue: error instanceof Error ? error.message : String(error), traceback: [] });
    return;
  }
  current = { requestId: id, executionId, started: Date.now(), cellFile, variableFile, images: [], error: null };
  notify('kernel/execution_started', { executionId, ...(typeof params.cellId === 'string' && params.cellId ? { cellId: params.cellId } : {}) });
  notify('kernel/status', { state: 'busy' });
  const proc = ensureProcess();
  const escapedFile = octavePath(cellFile);
  const escapedVariables = octavePath(variableFile);
  const escapedDir = octavePath(tmpDir);
  const script = [
    "addpath('" + escapedDir + "');",
    'global HCANVAS_SHARED_VARIABLES;',
    'if ~isstruct(HCANVAS_SHARED_VARIABLES), HCANVAS_SHARED_VARIABLES = struct(); end',
    '__hc_status__ = \'ok\';',
    'try',
    "  __hc_import__ = jsondecode(fileread('" + escapedVariables + "'));",
    '  __hc_old_names__ = fieldnames(HCANVAS_SHARED_VARIABLES);',
    '  for __hc_old_index__ = 1:numel(__hc_old_names__)',
    '    __hc_name__ = __hc_old_names__{__hc_old_index__};',
    '    if ~isfield(__hc_import__, __hc_name__)',
    '      HCANVAS_SHARED_VARIABLES = rmfield(HCANVAS_SHARED_VARIABLES, __hc_name__);',
    '      clear(__hc_name__);',
    '    end',
    '  end',
    '  __hc_shared_names__ = fieldnames(__hc_import__);',
    '  for __hc_shared_index__ = 1:numel(__hc_shared_names__)',
    '    __hc_name__ = __hc_shared_names__{__hc_shared_index__};',
    '    if isvarname(__hc_name__)',
    '      HCANVAS_SHARED_VARIABLES.(__hc_name__) = __hc_import__.(__hc_name__);',
    "      eval([__hc_name__ ' = __hc_import__.(__hc_name__);']);",
    '    end',
    '  end',
    "  source('" + escapedFile + "');",
    'catch __hc_err__',
    "  __hc_status__ = 'error';",
    "  fprintf(2, '__HCANVAS_ERROR__:%s\\n', jsonencode(struct('ename', __hc_err__.identifier, 'evalue', __hc_err__.message)));",
    'end',
    '__hc_export__ = HCANVAS_SHARED_VARIABLES;',
    '__hc_export_names__ = fieldnames(__hc_export__);',
    'for __hc_export_index__ = 1:numel(__hc_export_names__)',
    '  __hc_name__ = __hc_export_names__{__hc_export_index__};',
    "  if exist(__hc_name__, 'var')",
    '    try',
    "      eval(['__hc_value__ = ' __hc_name__ ';']);",
    '      __hc_export__.(__hc_name__) = jsondecode(jsonencode(__hc_value__));',
    '    catch __hc_variable_error__',
    "      fprintf(2, 'Shared variable %s was not updated: %s\\n', __hc_name__, __hc_variable_error__.message);",
    '    end',
    '  end',
    'end',
    'HCANVAS_SHARED_VARIABLES = __hc_export__;',
    "fprintf('__HCANVAS_VARIABLES__:%s\\n', jsonencode(__hc_export__));",
    "if ~exist('__hc_known_figs__', 'var'), __hc_known_figs__ = []; end",
    "__hc_figs__ = get(0, 'children');",
    '__hc_new__ = setdiff(__hc_figs__, __hc_known_figs__);',
    'for __hc_i__ = 1:numel(__hc_new__)',
    '  try',
    '    figure(__hc_new__(__hc_i__));',
    "    __hc_file__ = sprintf('" + escapedDir + "/fig-%d.png', __hc_new__(__hc_i__));",
    "    print('-dpng', __hc_file__);",
    "    fprintf('__HCANVAS_IMAGE__:%s\\n', __hc_file__);",
    '  catch',
    '  end',
    'end',
    '__hc_known_figs__ = __hc_figs__;',
    "fprintf('__HCANVAS_DONE__:%s\\n', __hc_status__);",
    ''
  ].join('\n');
  try {
    proc.stdin.write(script);
  } catch (error) {
    finishCurrent('error', { ename: 'OctaveProcessError', evalue: error instanceof Error ? error.message : String(error), traceback: [] });
  }
}

function interruptExecution() {
  suppressGnuplotNotice = false;
  if (!current) return;
  const execution = current;
  current = null;
  killChild();
  notify('kernel/execution_finished', { executionId: execution.executionId, status: 'aborted' });
  notify('kernel/status', { state: 'idle' });
  respond(execution.requestId, { executionId: execution.executionId, status: 'aborted', durationMs: Date.now() - execution.started });
  cleanupCurrentFiles(execution);
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  const method = message.method;
  const id = message.id;
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  if (method === 'initialize') {
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      language: 'octave',
      languageVersion: octaveVersion(),
      displayName: 'GNU Octave ' + octaveVersion(),
      features: { execute: true, interrupt: true, complete: false, inspect: false, variables: true },
      mimeTypes: ['text/plain', 'image/png'],
    });
    return;
  }
  if (method === 'initialized') return;
  if (method === 'kernel/execute') { startExecution(id, params); return; }
  if (method === 'kernel/interrupt') {
    interruptExecution();
    respond(id, { ok: true });
    return;
  }
  if (method === 'kernel/shutdown') {
    respond(id, { ok: true });
    stopping = true;
    killChild();
    const cleanup = () => { removePath(tmpDir); process.exit(0); };
    setTimeout(cleanup, 50);
    return;
  }
  if (id !== undefined && id !== null) respondError(id, -32601, 'Method not found: ' + String(method));
}

function consume() {
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
    const length = Number(match[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
    buffer = buffer.subarray(headerEnd + 4 + length);
    try { handleMessage(JSON.parse(body)); } catch (error) {
      process.stderr.write('hcanvas octave kernel message error: ' + (error instanceof Error ? error.message : String(error)) + '\n');
    }
  }
}

process.stdin.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); consume(); });
process.stdin.on('end', () => { stopping = true; killChild(); removePath(tmpDir); process.exit(0); });
process.on('SIGTERM', () => { killChild(); removePath(tmpDir); process.exit(0); });
process.on('SIGINT', () => { killChild(); removePath(tmpDir); process.exit(0); });
