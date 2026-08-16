import * as readline from 'node:readline';

import { loadJsonConfigFile } from '../config/loadJsonConfigFile.js';
import {
  persistHadamardSettingsStore,
  resolveHadamardSettingsStore,
} from '../config/hadamardSettingsStore.js';
import { isRecord } from '../runtime/helpers.js';

export interface TuiCredentialSettings {
  provider: string;
  apiKey: string;
  baseURL: string;
  model: string;
}

export async function saveTuiCredentialSettings(
  input: TuiCredentialSettings,
  configPath?: string,
): Promise<string> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error('API key cannot be empty.');
  const store = await resolveHadamardSettingsStore({ configPath });
  const raw = isRecord(store.raw) ? structuredClone(store.raw) : {};
  const env = isRecord(raw.env)
    ? { ...raw.env }
    : Object.fromEntries(Object.entries(raw).filter(
        (entry): entry is [string, string] => /^[A-Z0-9_]+$/u.test(entry[0])
          && typeof entry[1] === 'string',
      ));
  env.HADAMARD_API_KEY = apiKey;
  env.HADAMARD_BASE_URL = input.baseURL.trim() || 'https://api.deepseek.com';
  env.HADAMARD_MODEL = input.model.trim() || 'deepseek-chat';
  if (input.provider.trim().toLowerCase() === 'openai') env.HADAMARD_PROVIDER = 'openai';
  else delete env.HADAMARD_PROVIDER;
  raw.env = env;
  await persistHadamardSettingsStore(store.configPath, raw);
  // Always load the exact file we wrote. On first install there is no prior
  // module-level config for persistHadamardSettingsStore() to reload.
  await loadJsonConfigFile(store.configPath);
  return store.configPath;
}

export async function onboardTuiCredentials(configPath?: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> => new Promise(resolve => rl.question(question, resolve));

  console.log('\n  Welcome to Hadamard! Let\'s set up your first connection.\n');

  const provider = await ask('  Provider (anthropic/openai) [anthropic]: ');
  const apiKey = await ask('  API Key: ');
  const baseURL = await ask('  Base URL [https://api.deepseek.com]: ');
  const model = await ask('  Model [deepseek-chat]: ');

  rl.close();

  const file = await saveTuiCredentialSettings({
    provider: provider.trim() || 'anthropic',
    apiKey,
    baseURL: baseURL.trim() || 'https://api.deepseek.com',
    model: model.trim() || 'deepseek-chat',
  }, configPath);
  console.log(`\n  Config saved to ${file}. Starting TUI...\n`);
}
