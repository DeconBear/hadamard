// Fake HKP kernel for kernel protocol tests (SPEC-8). No external deps; Node ESM.
import { Buffer } from 'node:buffer';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

function notify(method, params) {
  write({ jsonrpc: '2.0', method, params });
}

let executing = null; // { executionId, requestId, interrupted, hang, timer }

function finish(status) {
  if (!executing) return;
  const current = executing;
  executing = null;
  if (current.timer) clearTimeout(current.timer);
  notify('kernel/execution_finished', { executionId: current.executionId, status });
  respond(current.requestId, { executionId: current.executionId, status, durationMs: Date.now() - current.startedAt });
}

function handle(message) {
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: '1.0',
      language: 'fake',
      languageVersion: '1.0.0',
      displayName: 'Fake Kernel',
      features: { execute: true, interrupt: true, complete: true, inspect: true },
      mimeTypes: ['text/plain', 'text/html', 'image/png'],
    });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'kernel/shutdown') {
    respond(message.id, {});
    setTimeout(() => process.exit(0), 5);
    return;
  }
  if (message.method === 'kernel/interrupt') {
    respond(message.id, { ok: true });
    if (executing && !executing.hang) {
      executing.interrupted = true;
      const current = executing;
      if (current.timer) clearTimeout(current.timer);
      setTimeout(() => {
        if (executing === current) finish('aborted');
      }, 10);
    }
    return;
  }
  if (message.method === 'kernel/complete') {
    respond(message.id, { matches: ['print', 'printf'], cursorStart: 0, cursorEnd: message.params?.cursorPos ?? 0 });
    return;
  }
  if (message.method === 'kernel/inspect') {
    respond(message.id, { name: 'print', signature: 'print(...)', documentation: 'Print values to the output stream.' });
    return;
  }
  if (message.method !== 'kernel/execute' || message.id === undefined) {
    if (message.id !== undefined) respond(message.id, { ok: false });
    return;
  }
  const params = message.params ?? {};
  const code = String(params.code ?? '');
  if (executing) {
    respond(message.id, { executionId: params.executionId, status: 'error', durationMs: 0 });
    return;
  }
  const startedAt = Date.now();
  executing = { executionId: params.executionId, requestId: message.id, interrupted: false, hang: false, startedAt, timer: null };
  notify('kernel/execution_started', { executionId: params.executionId, ...(params.cellId ? { cellId: params.cellId } : {}) });
  notify('kernel/status', { state: 'busy' });

  if (code.includes('hang')) {
    executing.hang = true;
    return;
  }
  if (code.includes('crash')) {
    notify('kernel/stream', { executionId: params.executionId, name: 'stdout', text: 'before crash\n' });
    setTimeout(() => process.exit(7), 10);
    return;
  }
  if (code.includes('slow')) {
    notify('kernel/stream', { executionId: params.executionId, name: 'stdout', text: 'working...\n' });
    const current = executing;
    current.timer = setTimeout(() => {
      if (executing !== current) return;
      notify('kernel/stream', { executionId: params.executionId, name: 'stdout', text: 'done\n' });
      finish('ok');
    }, 250);
    return;
  }
  if (code.includes('shared-variables')) {
    notify('kernel/display_data', {
      executionId: params.executionId,
      data: { 'application/vnd.hcanvas.variables+json': params.variables ?? {} },
    });
    finish('ok');
    return;
  }
  if (code.toLowerCase().includes('error')) {
    notify('kernel/stream', { executionId: params.executionId, name: 'stderr', text: 'traceback line\n' });
    notify('kernel/error', {
      executionId: params.executionId,
      ename: 'ValueError',
      evalue: 'boom',
      traceback: ['Traceback (most recent call last)', 'ValueError: boom'],
    });
    finish('error');
    return;
  }
  if (code.includes('bigdisplay')) {
    const size = Number((/bigdisplay:(\d+)/u.exec(code) ?? [])[1] ?? 400);
    notify('kernel/display_data', {
      executionId: params.executionId,
      data: {
        'text/html': '<p>' + 'h'.repeat(size) + '</p>',
        'text/plain': 'big display',
      },
    });
    finish('ok');
    return;
  }
  if (code.includes('display')) {
    notify('kernel/stream', { executionId: params.executionId, name: 'stdout', text: 'out\n' });
    notify('kernel/display_data', {
      executionId: params.executionId,
      data: { 'text/plain': '<Figure>', 'image/png': PNG_1X1 },
    });
    notify('kernel/execute_result', { executionId: params.executionId, data: { 'text/plain': '42' } });
    finish('ok');
    return;
  }
  if (code.includes('big')) {
    const size = Number((/big:(\d+)/u.exec(code) ?? [])[1] ?? 100000);
    notify('kernel/stream', { executionId: params.executionId, name: 'stdout', text: 'z'.repeat(size) });
    finish('ok');
    return;
  }
  notify('kernel/stream', { executionId: params.executionId, name: 'stdout', text: 'hel' });
  notify('kernel/stream', { executionId: params.executionId, name: 'stdout', text: 'lo\n' });
  notify('kernel/display_data', { executionId: params.executionId, data: { 'text/plain': 'display' } });
  notify('kernel/execute_result', { executionId: params.executionId, data: { 'text/plain': 'hello' } });
  finish('ok');
}

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
      process.stderr.write('fake kernel handler error: ' + String(error) + '\n');
      process.exit(4);
    }
  }
});
