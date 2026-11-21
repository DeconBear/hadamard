#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CPP_SHARED_HEADER, cppSharedDefinitions, CPP_VARIABLES_MIME, splitCppVariableOutput } from './shared_variables.mjs';

const OUT = process.stdout;
const OUTPUT_LIMIT = 1024 * 1024;
let buffer = Buffer.alloc(0);
let current = null;
let child = null;
let tmpRoot = '';
let compilerCache;
let stopping = false;

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  OUT.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body]));
}
function respond(id, result) { if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, result }); }
function respondError(id, code, message) { if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, error: { code, message } }); }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }

function compilerCommand() {
  if (compilerCache !== undefined) return compilerCache;
  for (const candidate of ['g++', 'clang++']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (probe.status === 0 || probe.stdout || probe.stderr) { compilerCache = candidate; return candidate; }
  }
  compilerCache = null;
  return null;
}

function truncate(text, limit = OUTPUT_LIMIT) {
  const value = String(text || '');
  return value.length > limit ? value.slice(0, limit) + '\n… truncated' : value;
}

function ensureTmpRoot() {
  if (!tmpRoot || !existsSync(tmpRoot)) tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'hcanvas-cpp-kernel-'));
  return tmpRoot;
}

function cleanup(execution) {
  if (!execution) return;
  try { rmSync(execution.dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function stream(streamName, text) {
  const execution = current;
  if (!execution || !text) return;
  const remaining = OUTPUT_LIMIT - execution.outputBytes;
  if (remaining <= 0) return;
  const value = String(text).slice(0, remaining);
  execution.outputBytes += value.length;
  const suffix = String(text).length > value.length || execution.outputBytes >= OUTPUT_LIMIT ? '\n… output truncated' : '';
  for (const chunk of (value + suffix).match(/[\s\S]{1,60000}/g) || []) {
    notify('kernel/stream', { executionId: execution.executionId, name: streamName, text: chunk });
  }
}

function finish(status, error) {
  const execution = current;
  if (!execution) return;
  current = null;
  if (error) {
    notify('kernel/error', {
      executionId: execution.executionId,
      ename: error.ename || 'CppError',
      evalue: error.evalue || String(error),
      traceback: Array.isArray(error.traceback) ? error.traceback : String(error.evalue || '').split(/\r?\n/),
    });
  }
  notify('kernel/execution_finished', { executionId: execution.executionId, status });
  notify('kernel/status', { state: 'idle' });
  respond(execution.requestId, { executionId: execution.executionId, status, durationMs: Date.now() - execution.started });
  cleanup(execution);
}

function killCurrent() {
  if (!child) return;
  const proc = child;
  child = null;
  try { proc.kill(); } catch { /* best effort */ }
}

function buildSource(code, variables) {
  const prologue = '#include "hcanvas_shared.hpp"\n' + cppSharedDefinitions(variables) + '\n';
  const prologueLines = prologue.split('\n').length - 1;
  const lines = code.split(/\r?\n/);
  const hasMain = /(^|[^A-Za-z0-9_])int\s+main\s*\(/u.test(code);
  if (hasMain) {
    return { source: prologue + code, lineMap: [...Array(prologueLines).fill(0), ...lines.map((_, index) => index + 1)] };
  }
  const includes = [];
  const body = [];
  for (const [index, line] of lines.entries()) {
    if (/^\s*#\s*include\b/u.test(line)) includes.push({ text: line, line: index + 1 });
    else body.push({ text: line, line: index + 1 });
  }
  const standardHeaders = [
    '#include <iostream>', '#include <string>', '#include <vector>', '#include <algorithm>',
    '#include <cmath>', '#include <cstdio>', '#include <cstdlib>', '#include <sstream>',
    '#include <iomanip>', '#include <map>', '#include <unordered_map>', '#include <set>',
    '#include <queue>', '#include <stack>', '#include <array>', '#include <numeric>',
    '#include <functional>', '#include <bitset>', '#include <cstring>', '#include <climits>',
  ].map(text => ({ text, line: 0 }));
  const header = [...standardHeaders, ...includes.filter(item => !/bits\/stdc\+\+\.h/u.test(item.text)), { text: 'using namespace std;', line: 0 }];
  const generated = [...header, { text: 'int main() {', line: 0 }, ...body, { text: '  return 0;\n}', line: 0 }];
  return {
    source: prologue + generated.map(item => item.text).join('\n'),
    lineMap: [...Array(prologueLines).fill(0), ...generated.map(item => item.line)],
  };
}

function mapCompileErrors(text, lineMap) {
  return String(text || '').replace(/main\.cpp:(\d+):/gu, (_match, line) => 'Cell line ' + (lineMap[Number(line) - 1] || '?') + ':');
}

function startExecution(id, params) {
  if (current) { respondError(id, -32603, 'C++ kernel is busy'); return; }
  const code = typeof params.code === 'string' ? params.code : '';
  const executionId = typeof params.executionId === 'string' && params.executionId ? params.executionId : 'cpp_' + Date.now().toString(36);
  const compiler = compilerCommand();
  if (!compiler) {
    current = { requestId: id, executionId, started: Date.now(), dir: '', outputBytes: 0 };
    notify('kernel/execution_started', { executionId });
    notify('kernel/status', { state: 'busy' });
    finish('error', { ename: 'ToolchainError', evalue: 'No C++ compiler found on PATH (install g++ or clang++).', traceback: [] });
    return;
  }
  ensureTmpRoot();
  const dir = mkdtempSync(path.join(tmpRoot, 'cell-'));
  const sourcePath = path.join(dir, 'main.cpp');
  const binaryPath = path.join(dir, process.platform === 'win32' ? 'main.exe' : 'main');
  writeFileSync(path.join(dir, 'hcanvas_shared.hpp'), CPP_SHARED_HEADER, 'utf8');
  const built = buildSource(code, params.variables);
  writeFileSync(sourcePath, built.source, 'utf8');
  current = { requestId: id, executionId, started: Date.now(), dir, outputBytes: 0, lineMap: built.lineMap };
  notify('kernel/execution_started', { executionId, ...(typeof params.cellId === 'string' && params.cellId ? { cellId: params.cellId } : {}) });
  notify('kernel/status', { state: 'busy' });
  const compile = spawn(compiler, ['-std=c++17', '-O2', '-o', binaryPath, sourcePath], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child = compile;
  let compileOut = '';
  let compileErr = '';
  compile.stdout.on('data', chunk => { compileOut = truncate(compileOut + String(chunk)); });
  compile.stderr.on('data', chunk => { compileErr = truncate(compileErr + String(chunk)); });
  compile.once('error', error => {
    child = null;
    if (current?.executionId !== executionId) return;
    stream('stderr', 'compiler error: ' + (error instanceof Error ? error.message : String(error)) + '\n');
    finish('error', { ename: 'CompilerError', evalue: error instanceof Error ? error.message : String(error), traceback: [] });
  });
  compile.once('exit', codeValue => {
    child = null;
    if (current?.executionId !== executionId) return;
    const compileOutput = mapCompileErrors(truncate(compileOut + compileErr), current.lineMap);
    if (codeValue !== 0) {
      finish('error', {
        ename: 'CompilationError',
        evalue: 'C++ compilation failed with exit code ' + String(codeValue) + '.',
        traceback: compileOutput.split(/\r?\n/).slice(0, 60),
      });
      return;
    }
    const run = spawn(binaryPath, [], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child = run;
    let stdoutLine = '';
    const timer = setTimeout(() => {
      stream('stderr', '\nExecution exceeded 60 seconds and was stopped.\n');
      try { run.kill(); } catch { /* best effort */ }
    }, 60000);
    const stdoutContent = line => {
      const parsed = splitCppVariableOutput(line);
      if (Object.keys(parsed.variables).length) notify('kernel/display_data', { executionId, data: { [CPP_VARIABLES_MIME]: parsed.variables } });
      if (parsed.stdout) stream('stdout', parsed.stdout + '\n');
    };
    run.stdout.on('data', chunk => {
      stdoutLine += String(chunk);
      for (;;) {
        const index = stdoutLine.indexOf('\n');
        if (index < 0) break;
        const line = stdoutLine.slice(0, index + 1);
        stdoutLine = stdoutLine.slice(index + 1);
        stdoutContent(line.replace(/\r?\n$/u, ''));
      }
      if (stdoutLine.length > OUTPUT_LIMIT) { stream('stdout', stdoutLine); stdoutLine = ''; }
    });
    run.stderr.on('data', chunk => stream('stderr', String(chunk)));
    run.once('error', error => {
      clearTimeout(timer);
      child = null;
      if (current?.executionId !== executionId) return;
      finish('error', { ename: 'RunError', evalue: error instanceof Error ? error.message : String(error), traceback: [] });
    });
    run.once('exit', (runCode, signal) => {
      clearTimeout(timer);
      child = null;
      if (current?.executionId !== executionId) return;
      if (stdoutLine) stdoutContent(stdoutLine);
      if (runCode === 0) finish('ok');
      else finish('error', { ename: 'RunError', evalue: 'C++ program exited with code ' + String(runCode) + (signal ? ' (' + signal + ')' : '') + '.', traceback: [] });
    });
  });
}

function interruptExecution() {
  if (!current) return;
  const execution = current;
  current = null;
  killCurrent();
  notify('kernel/execution_finished', { executionId: execution.executionId, status: 'aborted' });
  notify('kernel/status', { state: 'idle' });
  respond(execution.requestId, { executionId: execution.executionId, status: 'aborted', durationMs: Date.now() - execution.started });
  cleanup(execution);
}

function completeCode(code, cursorPos, variables) {
  const prefix = /[A-Za-z_][A-Za-z0-9_]*$/u.exec(String(code).slice(0, cursorPos))?.[0] || '';
  const keywords = ['auto', 'bool', 'break', 'case', 'catch', 'class', 'const', 'constexpr', 'continue', 'default', 'delete', 'double', 'else', 'enum', 'false', 'float', 'for', 'if', 'int', 'long', 'namespace', 'new', 'nullptr', 'private', 'protected', 'public', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'template', 'this', 'true', 'typedef', 'typename', 'union', 'unsigned', 'using', 'void', 'while', 'std::cout', 'std::endl', 'std::string', 'std::vector', 'std::pow', 'std::sqrt', 'hc_get', 'hc_set'];
  const names = new Set([...keywords, ...Object.keys(variables && typeof variables === 'object' ? variables : {}), ...(String(code).match(/[A-Za-z_][A-Za-z0-9_:]*/gu) || [])]);
  const matches = [...names].filter(name => name.startsWith(prefix)).sort().slice(0, 60);
  return { matches, cursorStart: cursorPos - prefix.length, cursorEnd: cursorPos };
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  const method = message.method;
  const id = message.id;
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  if (method === 'initialize') {
    const compiler = compilerCommand();
    respond(id, {
      protocolVersion: '1.0', language: 'cpp', languageVersion: compiler || 'none', displayName: 'C++' + (compiler ? ' (' + compiler + ')' : ''),
      features: { execute: true, interrupt: true, complete: true, inspect: false, variables: true }, mimeTypes: ['text/plain'],
    });
    return;
  }
  if (method === 'initialized') return;
  if (method === 'kernel/complete') { respond(id, completeCode(params.code || '', Number(params.cursorPos || 0), params.variables)); return; }
  if (method === 'kernel/execute') { startExecution(id, params); return; }
  if (method === 'kernel/interrupt') { interruptExecution(); respond(id, { ok: true }); return; }
  if (method === 'kernel/shutdown') {
    respond(id, { ok: true });
    stopping = true;
    killCurrent();
    try { if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    setTimeout(() => process.exit(0), 50);
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
      process.stderr.write('hcanvas cpp kernel message error: ' + (error instanceof Error ? error.message : String(error)) + '\n');
    }
  }
}

process.stdin.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); consume(); });
process.stdin.on('end', () => { stopping = true; killCurrent(); try { if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } process.exit(0); });
process.on('SIGTERM', () => { killCurrent(); process.exit(0); });
process.on('SIGINT', () => { killCurrent(); process.exit(0); });
