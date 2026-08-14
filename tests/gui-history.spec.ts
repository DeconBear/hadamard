import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startHadamardGuiServer } from '../src/gui/hadamardGui.js';
import { getHadamardProjectSessionDirectory, SessionStore } from '../src/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('GUI session history', () => {
  it('replays stored user/assistant/tool messages through the history endpoint', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-gui-history-'));
    tempDirs.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    await mkdir(workDir, { recursive: true });

    const store = new SessionStore(getHadamardProjectSessionDirectory(workDir, homeDir));
    await store.create({
      id: 'chat-1',
      metadata: { __hadamardWorkDir: workDir },
      initialMessages: [
        { role: 'user', content: 'hello there' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '# Heading\n\nSome **bold** text.' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }] },
        { role: 'assistant', content: 'all done' },
      ],
    });

    const configPath = path.join(homeDir, '.hadamard', 'settings.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      HADAMARD_PROVIDER: 'openai',
      HADAMARD_API_KEY: 'test-key',
      HADAMARD_MODEL: 'gpt-4o-mini',
    }), 'utf8');

    const port = 47000 + Math.floor(Math.random() * 9000);
    const server = await startHadamardGuiServer({
      workDir,
      homeDir,
      host: '127.0.0.1',
      port,
      configPath,
      resumeSessionId: 'chat-1',
    });

    try {
      const payload = await fetch(`${server.url}api/session/messages`, {
        headers: { 'x-hadamard-token': server.token },
      }).then((res) => res.json()) as {
        messages: Array<{ type: string; text?: string; name?: string; ok?: boolean }>;
      };

      const types = payload.messages.map((entry) => entry.type);
      expect(types).toEqual(['user', 'assistant', 'tool', 'assistant']);

      expect(payload.messages[0]?.text).toBe('hello there');
      expect(payload.messages[1]?.text).toContain('# Heading');
      const toolEntry = payload.messages[2];
      expect(toolEntry?.name).toBe('Read');
      expect(toolEntry?.ok).toBe(true);
      expect(toolEntry?.text).toBe('file contents');
      expect(payload.messages[3]?.text).toBe('all done');
    } finally {
      await server.close();
    }
  });

  it('starts a fresh session on /clear and keeps the old conversation resumable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-gui-clear-'));
    tempDirs.push(root);
    const homeDir = path.join(root, 'home');
    const workDir = path.join(root, 'work');
    await mkdir(workDir, { recursive: true });
    const sessionDirectory = getHadamardProjectSessionDirectory(workDir, homeDir);
    const store = new SessionStore(sessionDirectory);
    await store.create({
      id: 'chat-before-clear',
      metadata: { __hadamardWorkDir: workDir },
      initialMessages: [
        { role: 'user', content: 'keep this conversation' },
        { role: 'assistant', content: 'kept' },
      ],
    });
    const configPath = path.join(homeDir, '.hadamard', 'settings.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      HADAMARD_PROVIDER: 'openai',
      HADAMARD_API_KEY: 'test-key',
      HADAMARD_MODEL: 'gpt-4o-mini',
    }), 'utf8');
    const server = await startHadamardGuiServer({
      workDir,
      homeDir,
      host: '127.0.0.1',
      port: 47000 + Math.floor(Math.random() * 9000),
      configPath,
      resumeSessionId: 'chat-before-clear',
    });

    try {
      const response = await fetch(`${server.url}api/send`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hadamard-token': server.token,
        },
        body: JSON.stringify({ text: '/clear', sessionId: 'chat-before-clear' }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"type":"clear"');

      const state = await fetch(`${server.url}api/state`, {
        headers: { 'x-hadamard-token': server.token },
      }).then(res => res.json()) as {
        session: { id: string; messages: number };
        sessions: Array<{ id: string }>;
      };
      expect(state.session.id).not.toBe('chat-before-clear');
      expect(state.session.messages).toBe(0);
      expect(state.sessions.map(item => item.id)).toContain('chat-before-clear');
      expect((await store.load('chat-before-clear')).messages).toHaveLength(2);
    } finally {
      await server.close();
    }
  });
});
