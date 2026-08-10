import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import pty from 'node-pty';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hadamard-tui-e2e-'));
const homeDir = path.join(tempRoot, 'home');
const workDir = path.join(tempRoot, 'workspace');
const configPath = path.join(tempRoot, 'settings.json');
await fs.mkdir(homeDir, { recursive: true });
await fs.mkdir(workDir, { recursive: true });
await fs.writeFile(configPath, JSON.stringify({
  env: {
    HADAMARD_API_KEY: 'tui-e2e-placeholder',
    HADAMARD_PROVIDER: 'openai',
    HADAMARD_MODEL: 'tui-e2e-model',
  },
}), 'utf8');

const child = pty.spawn(
  process.execPath,
  [path.join(root, 'bin', 'hadamard-tui.js'), workDir, '--config', configPath],
  {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: root,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      HADAMARD_HOME: path.join(homeDir, '.hadamard'),
      NO_COLOR: '1',
    },
  },
);

let output = '';
let exited = false;
let exitCode;
child.onData(data => { output += data; });
child.onExit(event => {
  exited = true;
  exitCode = event.exitCode;
});

function plainText() {
  return output
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\r/gu, '');
}

async function waitFor(pattern, label, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = plainText();
    if (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)) return;
    if (exited) throw new Error(`TUI exited before ${label} (code ${exitCode}).\n${text}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}.\n${plainText()}`);
}

try {
  await waitFor('ctrl+c clear/exit', 'initial prompt');
  child.write('/tools\r');
  await waitFor(/\bRead\b.*\bWrite\b/su, '/tools output');
  child.write('/exit\r');
  await waitFor('Goodbye.', 'clean shutdown');
  await waitForExit();
  if (exitCode !== 0) throw new Error(`TUI exited with code ${exitCode}.\n${plainText()}`);
  process.stdout.write(JSON.stringify({
    passed: true,
    assertions: ['initial prompt', '/tools output', 'clean /exit'],
  }, null, 2) + '\n');
} finally {
  if (!exited) child.kill();
  await fs.rm(tempRoot, { recursive: true, force: true });
}
process.exit(0);

async function waitForExit(timeoutMs = 10_000) {
  const started = Date.now();
  while (!exited && Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!exited) throw new Error(`Timed out waiting for TUI exit.\n${plainText()}`);
}
