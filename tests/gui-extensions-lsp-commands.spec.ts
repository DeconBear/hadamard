import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startHadamardGuiServer, type HadamardGuiServer } from '../src/gui/hadamardGui.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface GuiEvent {
  type: string;
  title?: string;
  text?: string;
  message?: string;
  items?: Array<{ label: string; description?: string }>;
}

async function startGui(settings: Record<string, unknown>): Promise<HadamardGuiServer & { configPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-gui-ext-lsp-'));
  tempDirs.push(root);
  const homeDir = path.join(root, 'home');
  const workDir = path.join(root, 'work');
  await mkdir(workDir, { recursive: true });
  const configPath = path.join(homeDir, '.hadamard', 'settings.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    HADAMARD_PROVIDER: 'openai',
    HADAMARD_API_KEY: 'test-key',
    HADAMARD_MODEL: 'gpt-4o-mini',
    ...settings,
  }), 'utf8');
  const server = await startHadamardGuiServer({
    workDir,
    homeDir,
    host: '127.0.0.1',
    port: 47000 + Math.floor(Math.random() * 9000),
    configPath,
  });
  return Object.assign(server, { configPath });
}

async function sendSlash(server: HadamardGuiServer, text: string): Promise<GuiEvent[]> {
  const response = await fetch(`${server.url}api/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hadamard-token': server.token,
    },
    body: JSON.stringify({ text }),
  });
  expect(response.status).toBe(200);
  const body = await response.text();
  return body
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as GuiEvent);
}

function commandResult(events: GuiEvent[]): GuiEvent {
  const result = events.find(event => event.type === 'command.result');
  expect(result, `expected a command.result event in ${JSON.stringify(events)}`).toBeDefined();
  return result!;
}

describe('GUI /extensions and /lsp slash commands', () => {
  it('lists built-in extensions with state and config summaries', async () => {
    const server = await startGui({
      extensions: { security: { enabled: true, protectedPaths: ['src'] } },
    });
    try {
      const result = commandResult(await sendSlash(server, '/extensions'));
      expect(result.title).toBe('Extensions');
      expect(result.text).toContain('Built-in extensions (5)');
      const labels = (result.items ?? []).map(item => item.label);
      expect(labels).toContain('Security Guard (security)');
      expect(labels).toContain('Output Filter (filterOutput)');
      expect(labels).toContain('Cost Tracker (costTracker)');
      expect(labels).toContain('Usage Bar (usageBar)');
      expect(labels).toContain('Notifications (notifications)');
      const security = (result.items ?? []).find(item => item.label === 'Security Guard (security)');
      expect(security?.description).toContain('on · default off · policy');
      expect(security?.description).toContain('protectedPaths: 1');
    } finally {
      await server.close();
    }
  });

  it('toggles an extension and persists it to settings.json', async () => {
    const server = await startGui({});
    try {
      const toggled = commandResult(await sendSlash(server, '/extensions security on'));
      expect(toggled.text).toContain('Security Guard (security) enabled');
      expect(toggled.text).toContain('policy extension; applies to subsequent agent runs');

      const listed = commandResult(await sendSlash(server, '/extensions'));
      const security = (listed.items ?? []).find(item => item.label === 'Security Guard (security)');
      expect(security?.description).toContain('on · default off · policy');

      const persisted = JSON.parse(await readFile(server.configPath, 'utf8')) as {
        extensions?: { security?: { enabled?: boolean } };
      };
      expect(persisted.extensions?.security?.enabled).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('rejects unknown extension ids with the valid id list', async () => {
    const server = await startGui({});
    try {
      const events = await sendSlash(server, '/extensions nope on');
      const error = events.find(event => event.type === 'error');
      expect(error?.message).toContain('unknown extension: nope');
      expect(error?.message).toContain('security, filterOutput, costTracker, usageBar, notifications');
    } finally {
      await server.close();
    }
  });

  it('shows configured language server status on /lsp', async () => {
    const server = await startGui({
      autoDetectLanguageServers: false,
      languageServers: [{
        id: 'test-ls',
        languages: ['python'],
        extensions: ['.py'],
        command: 'hadamard-definitely-missing-lsp-command',
      }],
    });
    try {
      const result = commandResult(await sendSlash(server, '/lsp'));
      expect(result.title).toBe('Language servers');
      expect(result.text).toContain('Language servers (1)');
      expect(result.items).toEqual([
        {
          label: 'test-ls',
          description: 'python · unavailable (Configured command is unavailable: hadamard-definitely-missing-lsp-command) · not started',
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('prints configuration guidance on /lsp when no servers are configured or detected', async () => {
    const server = await startGui({ autoDetectLanguageServers: false });
    try {
      const result = commandResult(await sendSlash(server, '/lsp'));
      expect(result.title).toBe('Language servers');
      expect(result.text).toContain('No language servers configured or detected.');
      expect(result.text).toContain('languageServers in ~/.hadamard/settings.json');
      expect(result.text).toContain('typescript-language-server');
    } finally {
      await server.close();
    }
  });
});
