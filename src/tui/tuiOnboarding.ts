import fs from 'node:fs';
import path from 'node:path';
import * as readline from 'node:readline';

import { resolveHadamardHome } from '../index.js';

export async function onboardTuiCredentials(configPath?: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> => new Promise(resolve => rl.question(question, resolve));

  console.log('\n  Welcome to Hadamard! Let\'s set up your first connection.\n');

  const provider = await ask('  Provider (anthropic/openai) [anthropic]: ');
  const apiKey = await ask('  API Key: ');
  const baseURL = await ask('  Base URL [https://api.deepseek.com]: ');
  const model = await ask('  Model [deepseek-chat]: ');

  rl.close();

  const resolvedProvider = provider.trim() || 'anthropic';
  const resolvedBaseURL = baseURL.trim() || 'https://api.deepseek.com';
  const resolvedModel = model.trim() || 'deepseek-chat';
  const directory = resolveHadamardHome();
  const file = configPath ?? path.join(directory, 'settings.json');

  fs.mkdirSync(directory, { recursive: true });
  const env: Record<string, string> = {
    HADAMARD_API_KEY: apiKey.trim(),
    HADAMARD_BASE_URL: resolvedBaseURL,
    HADAMARD_MODEL: resolvedModel,
  };
  if (resolvedProvider === 'openai') env.HADAMARD_PROVIDER = 'openai';
  fs.writeFileSync(file, JSON.stringify({ env }, null, 2), 'utf-8');
  console.log(`\n  Config saved to ${file}. Starting TUI...\n`);
}
