/**
 * S1a unified agent store (plan/AGENT_SUBAGENT_UNIFICATION_08Aug2026):
 * frontmatter round-trip of the new keys, json→md auto-migration, the
 * AgentProfile compatibility view, subagent:false filtering, and §6-6
 * definition-bridgeConfig model resolution on the subagent run path.
 */
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadHadamardAgentDefinitions,
} from '../src/runtime/hadamardAgentDefinitions.js';
import {
  agentDefinitionsDir,
  migrateAgentProfilesToMarkdown,
  readProfilesFromAgentDefinitions,
} from '../src/config/agentDefinitionMigration.js';
import {
  deleteAgentProfile,
  findAgentProfile,
  listAgentProfiles,
  upsertAgentProfile,
} from '../src/config/agentProfiles.js';
import { BrokenReferenceError } from '../src/manager/resolveTargetRef.js';
import {
  createAgentSdk,
  type ModelApi,
  type ModelRequest,
  type ModelStreamHandle,
} from '../src/index.js';
import type { Message, MessageStreamEvent } from '../src/provider/types.js';

let home: string;
let workDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 's1a-home-'));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 's1a-work-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

function dataRoot(): string {
  return path.join(home, '.hadamard');
}

function seedBridgeConfig(name = 'cfg', model = 'm1'): void {
  fs.mkdirSync(dataRoot(), { recursive: true });
  fs.writeFileSync(
    path.join(dataRoot(), 'bridge-configs.json'),
    JSON.stringify({
      configs: [{ name, runtime: 'claude', provider: 'anthropic', apiKey: 'test-key', model, models: [{ name: model }] }],
    }),
    'utf-8',
  );
}

function writeProfileJson(profiles: unknown[]): void {
  fs.mkdirSync(dataRoot(), { recursive: true });
  fs.writeFileSync(
    path.join(dataRoot(), 'agent-configs.json'),
    JSON.stringify({ version: 1, profiles }),
    'utf-8',
  );
}

function agentsDir(): string {
  return agentDefinitionsDir(home);
}

// ── 1. frontmatter round-trip ─────────────────────────────────────────

describe('frontmatter new keys (S1a)', () => {
  it('parses all unified-store keys and maps maxIterations to maxToolIterations', async () => {
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.writeFileSync(path.join(agentsDir(), 'coder.md'), [
      '---',
      'name: coder',
      'description: Implements scoped coding tasks',
      'bridgeConfig: deepseek',
      'model: deepseek-chat',
      'effort: high',
      'permissionMode: acceptEdits',
      'promptMode: extend',
      'temperature: 0.7',
      'topP: 0.9',
      'maxTokens: 8192',
      'maxIterations: 50',
      'timeoutMs: 600000',
      'workspaceAccess: full',
      'tools: Read, Grep, Bash',
      'subagent: false',
      'allowedAgents: Explore, Plan',
      '---',
      '',
      'You are a senior engineer.',
      '',
    ].join('\n'), 'utf-8');

    const definitions = await loadHadamardAgentDefinitions({
      homeDir: dataRoot(),
      workDir,
      loadDefaultAgentDirectories: true,
    });
    const coder = definitions.find(definition => definition.name === 'coder');
    expect(coder).toBeDefined();
    expect(coder?.bridgeConfig).toBe('deepseek');
    expect(coder?.promptMode).toBe('extend');
    expect(coder?.temperature).toBe(0.7);
    expect(coder?.topP).toBe(0.9);
    expect(coder?.maxTokens).toBe(8192);
    expect(coder?.maxToolIterations).toBe(50);
    expect(coder?.timeoutMs).toBe(600000);
    expect(coder?.workspaceAccess).toBe('full');
    expect(coder?.allowedTools).toEqual(['Read', 'Grep', 'Bash']);
    expect(coder?.subagent).toBe(false);
    expect(coder?.allowedAgents).toEqual(['Explore', 'Plan']);
  });

  it('defaults: promptMode replace, subagent delegatable, maxTurns still maps', async () => {
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.writeFileSync(path.join(agentsDir(), 'plain.md'), [
      '---',
      'name: plain',
      'description: Plain subagent',
      'maxTurns: 7',
      '---',
      '',
      'Do the thing.',
      '',
    ].join('\n'), 'utf-8');
    const definitions = await loadHadamardAgentDefinitions({ homeDir: dataRoot(), workDir });
    const plain = definitions.find(definition => definition.name === 'plain');
    expect(plain?.promptMode).toBe('replace');
    expect(plain?.subagent).toBeUndefined(); // absent = delegatable (default true)
    expect(plain?.maxToolIterations).toBe(7);
  });
});

// ── 2. json→md migration ──────────────────────────────────────────────

describe('agent-configs.json → agents/*.md migration', () => {
  it('writes extended .md files, renames the json to .bak, and is idempotent', () => {
    seedBridgeConfig();
    writeProfileJson([
      {
        name: 'coder',
        bridgeConfig: 'cfg',
        model: 'm1',
        description: 'Implements tasks',
        systemPromptAppend: 'Extra coder instructions.',
        permissionMode: 'plan',
        effort: 'high',
        maxTokens: 8192,
        temperature: 0.7,
        topP: 0.9,
        allowedTools: ['Read', 'Grep'],
        workspaceAccess: 'full',
        maxIterations: 24,
        timeoutMs: 60000,
      },
      { name: 'minimal', bridgeConfig: 'cfg', model: 'm1' },
    ]);

    const first = migrateAgentProfilesToMarkdown(home);
    expect(first.migrated.sort()).toEqual(['coder', 'minimal']);
    expect(first.skipped).toEqual([]);

    const jsonPath = path.join(dataRoot(), 'agent-configs.json');
    expect(fs.existsSync(jsonPath)).toBe(false);
    expect(fs.existsSync(`${jsonPath}.migrated.bak`)).toBe(true);

    const coderMd = fs.readFileSync(path.join(agentsDir(), 'coder.md'), 'utf-8');
    for (const line of [
      'name: coder',
      'description: Implements tasks',
      'bridgeConfig: cfg',
      'model: m1',
      'effort: high',
      'permissionMode: plan',
      'promptMode: extend',
      'temperature: 0.7',
      'topP: 0.9',
      'maxTokens: 8192',
      'maxIterations: 24',
      'timeoutMs: 60000',
      'workspaceAccess: full',
      'tools: Read, Grep',
      'subagent: true',
    ]) {
      expect(coderMd).toContain(line);
    }
    expect(coderMd).toContain('Extra coder instructions.');

    // Idempotent: a second run changes nothing.
    const second = migrateAgentProfilesToMarkdown(home);
    expect(second.migrated).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(fs.readFileSync(path.join(agentsDir(), 'coder.md'), 'utf-8')).toBe(coderMd);
  });

  it('file wins: an existing same-named .md is not overwritten', () => {
    seedBridgeConfig();
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.writeFileSync(path.join(agentsDir(), 'coder.md'), [
      '---',
      'name: coder',
      'description: Hand-written definition',
      'bridgeConfig: cfg',
      'model: m1',
      '---',
      '',
      'FILE WINS BODY',
      '',
    ].join('\n'), 'utf-8');
    writeProfileJson([
      { name: 'coder', bridgeConfig: 'cfg', model: 'm1', systemPromptAppend: 'json body' },
    ]);

    const result = migrateAgentProfilesToMarkdown(home);
    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual(['coder']);
    expect(fs.readFileSync(path.join(agentsDir(), 'coder.md'), 'utf-8')).toContain('FILE WINS BODY');

    // The compatibility view follows the .md, not the migrated json values.
    const profile = findAgentProfile('coder', home);
    expect(profile?.systemPromptAppend).toBe('FILE WINS BODY');
  });

  it('skips migration entirely when a .bak already exists (restored json stays)', () => {
    seedBridgeConfig();
    writeProfileJson([{ name: 'restored', bridgeConfig: 'cfg', model: 'm1' }]);
    fs.writeFileSync(path.join(dataRoot(), 'agent-configs.json.migrated.bak'), '{}', 'utf-8');

    const result = migrateAgentProfilesToMarkdown(home);
    expect(result.migrated).toEqual([]);
    expect(fs.existsSync(path.join(dataRoot(), 'agent-configs.json'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir(), 'restored.md'))).toBe(false);
  });
});

// ── 3. AgentProfile compatibility view + write-through ────────────────

describe('profile compatibility view (S1a interim)', () => {
  it('derives profiles from .md definitions and keeps pure subagents out', () => {
    seedBridgeConfig();
    fs.mkdirSync(agentsDir(), { recursive: true });
    fs.writeFileSync(path.join(agentsDir(), 'coder.md'), [
      '---',
      'name: coder',
      'description: Profile-backed agent',
      'bridgeConfig: cfg',
      'model: m1',
      'maxIterations: 12',
      'timeoutMs: 30000',
      'tools: Read, Bash',
      '---',
      '',
      'Coder body.',
      '',
    ].join('\n'), 'utf-8');
    fs.writeFileSync(path.join(agentsDir(), 'explore.md'), [
      '---',
      'name: explore',
      'description: Pure subagent without a config',
      '---',
      '',
      'Explore body.',
      '',
    ].join('\n'), 'utf-8');

    const profiles = listAgentProfiles(home);
    expect(profiles.map(profile => profile.name)).toEqual(['coder']);
    const coder = profiles[0]!;
    expect(coder.systemPromptAppend).toBe('Coder body.');
    expect(coder.maxIterations).toBe(12);
    expect(coder.timeoutMs).toBe(30000);
    expect(coder.allowedTools).toEqual(['Read', 'Bash']);
    expect(readProfilesFromAgentDefinitions(home).map(profile => profile.name)).toEqual(['coder']);
  });

  it('write-through: upsert updates .md (preserving unknown keys), delete removes it', () => {
    seedBridgeConfig();
    writeProfileJson([{ name: 'coder', bridgeConfig: 'cfg', model: 'm1', systemPromptAppend: 'v1' }]);
    // First read migrates json → md.
    expect(listAgentProfiles(home).map(profile => profile.name)).toEqual(['coder']);
    // A subagent-only key that the profile model does not carry.
    const coderPath = path.join(agentsDir(), 'coder.md');
    fs.writeFileSync(
      coderPath,
      fs.readFileSync(coderPath, 'utf-8').replace('subagent: true', 'subagent: true\nallowedAgents: Explore'),
      'utf-8',
    );

    upsertAgentProfile({ name: 'coder', bridgeConfig: 'cfg', model: 'm2', description: 'v2' }, home);
    expect(fs.existsSync(path.join(dataRoot(), 'agent-configs.json'))).toBe(false);
    const updated = fs.readFileSync(coderPath, 'utf-8');
    expect(updated).toContain('model: m2');
    expect(updated).toContain('description: v2');
    expect(updated).toContain('allowedAgents: Explore'); // preserved
    expect(updated).not.toContain('v1'); // body replaced by fallback (no systemPromptAppend)

    upsertAgentProfile({ name: 'fresh', bridgeConfig: 'cfg', model: 'm1' }, home);
    expect(fs.existsSync(path.join(agentsDir(), 'fresh.md'))).toBe(true);

    deleteAgentProfile('coder', home);
    expect(fs.existsSync(coderPath)).toBe(false);
    expect(listAgentProfiles(home).map(profile => profile.name)).toEqual(['fresh']);
  });
});

// ── 4/5. runtime: subagent filtering + definition model resolution ────

class MockStream implements ModelStreamHandle {
  constructor(private readonly message: Message) {}
  async finalMessage(): Promise<Message> {
    return this.message;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
    // no incremental events
  }
}

class MockModelApi implements ModelApi {
  readonly createCalls: ModelRequest[] = [];
  async createMessage(request: ModelRequest): Promise<Message> {
    this.createCalls.push(structuredClone(request));
    return {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text: 'mock reply' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as Message;
  }
  streamMessage(): ModelStreamHandle {
    throw new Error('streaming not used in these tests');
  }
}

async function createTestSdk(modelApi: MockModelApi, agents: Array<Record<string, unknown>>) {
  const sessionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 's1a-sessions-'));
  return createAgentSdk({
    model: 'test-model',
    sessionDirectory,
    homeDir: home,
    workDir,
    modelApi,
    disableDefaultAgents: true,
    agents: agents as never,
  });
}

describe('subagent: false filtering', () => {
  it('hides the definition from the Agent tool surface but keeps it runnable as a main agent', async () => {
    const modelApi = new MockModelApi();
    const sdk = await createTestSdk(modelApi, [
      { name: 'chat-only', description: 'Main chat agent', systemPrompt: 'x', subagent: false },
      { name: 'delegatable', description: 'Delegatable agent', systemPrompt: 'x' },
    ]);
    try {
      expect(sdk.listAgentDefinitions().map(definition => definition.name)).toEqual(['delegatable']);
      expect(sdk.getAgentDefinition('chat-only')).toBeUndefined();
      expect(sdk.getAgentDefinition('delegatable')).toBeDefined();
      // Still runnable directly (main-chat semantics).
      const result = await sdk.runWithAgent('chat-only', 'hello');
      expect(result.text).toContain('mock reply');
    } finally {
      await sdk.close();
    }
  });
});

describe('definition bridgeConfig model resolution (§6-6)', () => {
  it('a definition without bridgeConfig inherits the session client', async () => {
    const modelApi = new MockModelApi();
    const sdk = await createTestSdk(modelApi, [
      { name: 'plain', description: 'Plain', systemPrompt: 'x' },
    ]);
    try {
      const result = await sdk.runWithAgent('plain', 'hello');
      expect(result.text).toContain('mock reply');
      expect(modelApi.createCalls.length).toBe(1);
    } finally {
      await sdk.close();
    }
  });

  it('a definition with bridgeConfig runs on its own resolved client, not the session client', async () => {
    // Local capture server stands in for the definition's provider endpoint:
    // the run must reach it (not the session mock) and use the config's model.
    const captured: Array<{ url: string; body: string }> = [];
    const server = await new Promise<import('node:http').Server>((resolve) => {
      const srv = createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          captured.push({ url: req.url ?? '', body });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'msg_routed',
            type: 'message',
            role: 'assistant',
            model: 'def-model',
            content: [{ type: 'text', text: 'routed reply' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }));
        });
      });
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const port = (server.address() as { port: number }).port;
    fs.mkdirSync(dataRoot(), { recursive: true });
    fs.writeFileSync(
      path.join(dataRoot(), 'bridge-configs.json'),
      JSON.stringify({
        configs: [{
          name: 'own',
          runtime: 'claude',
          provider: 'anthropic',
          apiKey: 'test-key',
          baseURL: `http://127.0.0.1:${port}`,
          model: 'def-model',
        }],
      }),
      'utf-8',
    );
    const modelApi = new MockModelApi();
    const sdk = await createTestSdk(modelApi, [
      { name: 'wired', description: 'Own config', systemPrompt: 'x', bridgeConfig: 'own', model: 'def-model' },
    ]);
    try {
      const result = await sdk.runWithAgent('wired', 'hello');
      expect(result.text).toContain('routed reply');
      expect(modelApi.createCalls.length).toBe(0);
      expect(captured.length).toBeGreaterThan(0);
      expect(captured[0]!.body).toContain('def-model');
    } finally {
      await sdk.close();
      server.close();
    }
  });

  it('a missing bridgeConfig fails the delegation with BrokenReferenceError', async () => {
    const modelApi = new MockModelApi();
    const sdk = await createTestSdk(modelApi, [
      { name: 'broken', description: 'Broken config', systemPrompt: 'x', bridgeConfig: 'missing-cfg' },
    ]);
    try {
      await sdk.runWithAgent('broken', 'hello').then(
        () => { throw new Error('expected rejection'); },
        (error: unknown) => {
          expect(error).toBeInstanceOf(BrokenReferenceError);
          expect((error as BrokenReferenceError).kind).toBe('config');
          expect((error as BrokenReferenceError).targetName).toBe('missing-cfg');
        },
      );
      expect(modelApi.createCalls.length).toBe(0);
    } finally {
      await sdk.close();
    }
  });
});
