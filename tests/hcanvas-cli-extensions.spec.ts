import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cli = path.join(root, 'src', 'hcanvas', 'cli.ts');
let temp = '';
let workspace = '';
let home = '';

async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, cli, ...args], {
      cwd: root,
      env: { ...process.env, HCANVAS_HOME: home, HADAMARD_HOME: home },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timed out: ' + args.join(' '))); }, 90_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function jsonLine(output: string): Record<string, unknown> {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try { return JSON.parse(line) as Record<string, unknown>; } catch { /* keep looking */ }
  }
  throw new Error('no JSON output: ' + output);
}

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-cli-'));
  workspace = path.join(temp, 'workspace');
  home = path.join(temp, 'home');
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

describe('Hcanvas CLI extension commands', () => {
  it('lists bundled extensions without a daemon and supports the plugin alias', async () => {
    const list = await runCli(['extension', 'list', '--workspace', workspace]);
    expect(list.code).toBe(0);
    const payload = jsonLine(list.stdout);
    expect(payload.ok).toBe(true);
    const ids = (payload.extensions as Array<{ id: string }>).map(entry => entry.id);
    expect(ids).toContain('hcanvas.notebook');
    const alias = await runCli(['plugin', 'list', '--workspace', workspace]);
    expect(alias.code).toBe(0);
    expect((jsonLine(alias.stdout).extensions as Array<{ id: string }>).map(entry => entry.id)).toContain('hcanvas.notebook');
  }, 120_000);

  it('installs, lists and uninstalls a project extension without a daemon', async () => {
    const folder = path.join(root, 'examples', 'hcanvas-extensions', 'json-viewer');
    const installed = await runCli(['extension', 'install', '--folder', folder, '--project', '--workspace', workspace]);
    expect(installed.code).toBe(0);
    const installPayload = jsonLine(installed.stdout);
    expect(installPayload.ok).toBe(true);
    expect(installPayload.id).toBe('com.hadamard.examples.json');
    const listed = jsonLine((await runCli(['extension', 'list', '--project', '--workspace', workspace])).stdout);
    expect((listed.extensions as Array<{ id: string }>).map(entry => entry.id)).toContain('com.hadamard.examples.json');
    const removed = await runCli(['extension', 'uninstall', 'com.hadamard.examples.json', '--project', '--workspace', workspace]);
    expect(removed.code).toBe(0);
    expect(jsonLine(removed.stdout).ok).toBe(true);
    const after = jsonLine((await runCli(['extension', 'list', '--project', '--workspace', workspace])).stdout);
    expect((after.extensions as Array<{ id: string }>).map(entry => entry.id)).not.toContain('com.hadamard.examples.json');
  }, 120_000);

  it('reports doctor checks and readable missing-extension errors', async () => {
    const doctor = await runCli(['doctor', '--workspace', workspace]);
    expect(doctor.code).toBe(0);
    const payload = jsonLine(doctor.stdout);
    expect(payload.ok).toBe(true);
    expect((payload.checks as Array<{ id: string }>).map(check => check.id)).toEqual(expect.arrayContaining(['node', 'workspace', 'extensions']));
    const missing = await runCli(['extension', 'info', 'com.example.missing', '--workspace', workspace]);
    expect(missing.code).toBe(1);
    expect(missing.stderr + missing.stdout).toContain('Unknown extension id');
  }, 120_000);
});
