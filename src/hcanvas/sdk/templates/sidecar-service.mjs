// Minimal Hcanvas sidecar service: JSON-RPC 2.0 over stdio, LSP Content-Length framing.
// The host starts this only after the extension is trusted and the sidecar is declared
// in manifest.contributes.sidecars. Never use shell:true or read unbounded input.
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body]));
}

function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '1.0',
      serverInfo: { name: 'example-sidecar', version: '0.1.0' },
      capabilities: { requests: [{ method: 'echo' }] },
    } });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    setTimeout(() => process.exit(0), 10);
    return;
  }
  if (message.method === 'echo') {
    send({ jsonrpc: '2.0', id: message.id, result: { echoed: message.params ?? null } });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const match = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'));
    if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
    const length = Number(match[1]);
    if (buffer.length < headerEnd + 4 + length) break;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
    buffer = buffer.subarray(headerEnd + 4 + length);
    try { handle(JSON.parse(body)); } catch { /* ignore malformed frames */ }
  }
});
process.stdin.on('end', () => process.exit(0));
