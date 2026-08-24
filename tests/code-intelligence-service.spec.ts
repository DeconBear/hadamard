import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CodeIntelligenceService } from '../src/codeIntel/codeIntelligenceService.js';
import { LanguageServerRegistry } from '../src/codeIntel/languageServerRegistry.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const fakeServerSource = (logPath: string) => `
const fs = require('node:fs');
const logPath = ${JSON.stringify(logPath)};
const log = value => { try { fs.appendFileSync(logPath, JSON.stringify(value) + '\\n'); } catch {} };
let buffer = Buffer.alloc(0);
const send = value => { const body = Buffer.from(JSON.stringify(value)); process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n'); process.stdout.write(body); };
const loc = uri => ({ uri, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } });
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const split = buffer.indexOf('\\r\\n\\r\\n'); if (split < 0) return;
    const match = buffer.subarray(0, split).toString().match(/Content-Length:\\s*(\\d+)/i); if (!match) return;
    const length = Number(match[1]); if (buffer.length < split + 4 + length) return;
    const msg = JSON.parse(buffer.subarray(split + 4, split + 4 + length)); buffer = buffer.subarray(split + 4 + length);
    if (msg.method === 'exit') process.exit(0);
    if (msg.method === 'textDocument/didOpen') {
      log({ method: msg.method, uri: msg.params.textDocument.uri, version: msg.params.textDocument.version, text: msg.params.textDocument.text });
      send({ jsonrpc:'2.0', method:'textDocument/publishDiagnostics', params:{ uri:msg.params.textDocument.uri, diagnostics:[{ message:'fake diagnostic', severity:2, range:loc(msg.params.textDocument.uri).range }] } });
    }
    if (msg.method === 'textDocument/didChange') log({ method: msg.method, uri: msg.params.textDocument.uri, version: msg.params.textDocument.version, text: msg.params.contentChanges[0].text });
    if (msg.method === 'textDocument/didClose') log({ method: msg.method, uri: msg.params.textDocument.uri });
    if (msg.id === undefined) continue;
    let result = {};
    if (msg.method === 'workspace/symbol') result = [{ name:'targetSymbol', kind:12, location:loc('file:///target.ts') }];
    if (msg.method === 'textDocument/definition' || msg.method === 'textDocument/references') result = [loc(msg.params.textDocument.uri)];
    if (msg.method === 'textDocument/hover') result = msg.params.position.character === 99 ? null : { contents: { kind:'markdown', value:'**hover** documentation' } };
    send({ jsonrpc:'2.0', id:msg.id, result });
  }
});
`;

async function readNotifications(logPath: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(logPath, 'utf8').catch(() => '');
  return content.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line));
}

function createService(root: string, logPath: string): CodeIntelligenceService {
  return new CodeIntelligenceService({
    workDir: root,
    registry: new LanguageServerRegistry([{
      id: 'fake',
      languages: ['typescript'],
      extensions: ['.ts'],
      command: process.execPath,
      args: ['-e', fakeServerSource(logPath)],
    }]),
    timeoutMs: 2_000,
  });
}

describe('CodeIntelligenceService', () => {
  it('provides symbol, definition, reference, and diagnostic queries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-code-intel-'));
    tempDirs.push(root);
    const file = path.join(root, 'target.ts');
    await mkdir(root, { recursive: true });
    await writeFile(file, 'export const targetSymbol = 1;');
    const service = createService(root, path.join(root, 'server.log'));
    try {
      await expect(service.workspaceSymbols('target')).resolves.toEqual([
        expect.objectContaining({ name: 'targetSymbol' }),
      ]);
      await expect(service.definition(file, 0, 0)).resolves.toEqual([
        expect.objectContaining({ line: 1, character: 2 }),
      ]);
      await expect(service.references(file, 0, 0)).resolves.toHaveLength(1);
      await new Promise(resolve => setTimeout(resolve, 20));
      await expect(service.diagnostics(file)).resolves.toEqual([
        expect.objectContaining({ message: 'fake diagnostic', severity: 2 }),
      ]);
    } finally {
      await service.close();
    }
  });

  it('rejects workspace path escapes before opening documents', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-code-intel-escape-'));
    tempDirs.push(root);
    const service = createService(root, path.join(root, 'server.log'));
    try {
      await expect(service.definition('../secret.ts', 0, 0))
        .rejects.toThrow(/escapes workspace|outside workspace/);
    } finally {
      await service.close();
    }
  });

  it('pushes full-text didChange when an open file changes on disk', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-code-intel-sync-'));
    tempDirs.push(root);
    const file = path.join(root, 'target.ts');
    const logPath = path.join(root, 'server.log');
    await writeFile(file, 'export const targetSymbol = 1;');
    const service = createService(root, logPath);
    try {
      await service.definition(file, 0, 0);
      const updated = 'export const targetSymbol = 2;\nexport const extra = 3;\n';
      await writeFile(file, updated);
      const bumped = new Date(Date.now() + 10_000);
      await utimes(file, bumped, bumped);
      await service.definition(file, 0, 0);
      const changes = (await readNotifications(logPath))
        .filter(entry => entry.method === 'textDocument/didChange');
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ version: 2, text: updated });
      // An unchanged file does not re-sync.
      await service.definition(file, 0, 0);
      const after = (await readNotifications(logPath))
        .filter(entry => entry.method === 'textDocument/didChange');
      expect(after).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  it('sends didClose for open documents on close', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-code-intel-close-'));
    tempDirs.push(root);
    const file = path.join(root, 'target.ts');
    const logPath = path.join(root, 'server.log');
    await writeFile(file, 'export const targetSymbol = 1;');
    const service = createService(root, logPath);
    await service.definition(file, 0, 0);
    await service.close();
    const notifications = await readNotifications(logPath);
    expect(notifications.some(entry => entry.method === 'textDocument/didClose')).toBe(true);
  });

  it('sends didClose and drops state when an open file is deleted', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-code-intel-delete-'));
    tempDirs.push(root);
    const file = path.join(root, 'target.ts');
    const logPath = path.join(root, 'server.log');
    await writeFile(file, 'export const targetSymbol = 1;');
    const service = createService(root, logPath);
    try {
      await service.definition(file, 0, 0);
      await rm(file);
      await expect(service.diagnostics(file)).resolves.toEqual([]);
      const notifications = await readNotifications(logPath);
      expect(notifications.some(entry => entry.method === 'textDocument/didClose')).toBe(true);
    } finally {
      await service.close();
    }
  });

  it('normalizes hover markup and maps null to an empty string', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-code-intel-hover-'));
    tempDirs.push(root);
    const file = path.join(root, 'target.ts');
    await writeFile(file, 'export const targetSymbol = 1;');
    const service = createService(root, path.join(root, 'server.log'));
    try {
      await expect(service.hover(file, 0, 1)).resolves.toBe('**hover** documentation');
      await expect(service.hover(file, 0, 99)).resolves.toBe('');
    } finally {
      await service.close();
    }
  });

  it('reports server availability and running state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-code-intel-status-'));
    tempDirs.push(root);
    const file = path.join(root, 'target.ts');
    await writeFile(file, 'export const targetSymbol = 1;');
    const service = createService(root, path.join(root, 'server.log'));
    try {
      await expect(service.serverStatus()).resolves.toEqual([
        { id: 'fake', languages: ['typescript'], available: true, running: false },
      ]);
      await service.workspaceSymbols('target');
      await expect(service.serverStatus()).resolves.toEqual([
        { id: 'fake', languages: ['typescript'], available: true, running: true },
      ]);
    } finally {
      await service.close();
    }
  });

  it('marks servers with missing commands as unavailable and not running', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-code-intel-missing-'));
    tempDirs.push(root);
    const service = new CodeIntelligenceService({
      workDir: root,
      registry: new LanguageServerRegistry([{
        id: 'missing',
        languages: ['python'],
        extensions: ['.py'],
        command: 'hadamard-definitely-missing-lsp-command',
      }]),
    });
    try {
      await expect(service.serverStatus()).resolves.toEqual([
        {
          id: 'missing',
          languages: ['python'],
          available: false,
          reason: 'Configured command is unavailable: hadamard-definitely-missing-lsp-command',
          running: false,
        },
      ]);
    } finally {
      await service.close();
    }
  });
});
