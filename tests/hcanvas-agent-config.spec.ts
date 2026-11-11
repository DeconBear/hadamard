import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLlmConfig } from '../src/hcanvas/agentChat.js';

const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hcanvas-agent-config-'));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function clearModelEnv(): void {
  for (const key of ['HCANVAS_LLM_BASE_URL','HCANVAS_LLM_API_KEY','HCANVAS_LLM_MODEL','HADAMARD_BASE_URL','HADAMARD_API_KEY','HADAMARD_MODEL','ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_MODEL','OPENAI_BASE_URL','OPENAI_API_KEY','OPENAI_MODEL','HADAMARD_PROVIDER']) vi.stubEnv(key, '');
}

describe('Hcanvas Copilot model resolution', () => {
  it('prefers Hcanvas-specific configuration', async () => {
    clearModelEnv();
    const workspace = await tempDir();
    vi.stubEnv('HCANVAS_LLM_BASE_URL', 'http://localhost:9999/v1');
    vi.stubEnv('HCANVAS_LLM_MODEL', 'canvas-model');
    const config = await resolveLlmConfig(workspace);
    expect(config).toMatchObject({ provider: 'openai', source: 'hcanvas', model: 'canvas-model' });
  });

  it('falls back to Hadamard settings and detects Anthropic', async () => {
    clearModelEnv();
    const workspace = await tempDir();
    const home = await tempDir();
    await writeFile(path.join(home, 'settings.json'), JSON.stringify({ env: { HADAMARD_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', HADAMARD_API_KEY: 'test-key', HADAMARD_MODEL: 'glm-5.3', ACTOVIQ_PROVIDER: 'anthropic' } }), 'utf8');
    vi.stubEnv('HADAMARD_HOME', home);
    const config = await resolveLlmConfig(workspace);
    expect(config).toMatchObject({ provider: 'anthropic', source: 'hadamard', model: 'glm-5.3' });
    expect(config?.apiKey).toBe('test-key');
  });
});
