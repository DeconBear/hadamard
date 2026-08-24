import { probeLanguageServerCommand } from './languageServerRegistry.js';
import type { LanguageServerDefinition } from './types.js';

/**
 * Well-known language servers, activated automatically when their command is
 * found on PATH. Explicit `languageServers` entries always win over presets.
 */
export const LANGUAGE_SERVER_PRESETS: LanguageServerDefinition[] = [
  {
    id: 'typescript',
    languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'],
    command: 'typescript-language-server',
    args: ['--stdio'],
  },
  {
    id: 'python',
    languages: ['python'],
    extensions: ['.py', '.pyi'],
    command: 'pyright-langserver',
    args: ['--stdio'],
  },
  {
    id: 'go',
    languages: ['go'],
    extensions: ['.go'],
    command: 'gopls',
    args: ['serve'],
  },
  {
    id: 'rust',
    languages: ['rust'],
    extensions: ['.rs'],
    command: 'rust-analyzer',
    args: [],
  },
];

export interface ResolveLanguageServerDefinitionsOptions {
  autoDetect: boolean;
  /** PATH probe, injectable for tests. Defaults to the registry PATH lookup. */
  probe?: (command: string) => Promise<boolean>;
}

export async function resolveLanguageServerDefinitions(
  configured: LanguageServerDefinition[],
  options: ResolveLanguageServerDefinitionsOptions,
): Promise<LanguageServerDefinition[]> {
  if (!options.autoDetect) return [...configured];
  const probe = options.probe ?? probeLanguageServerCommand;
  const covered = new Set(configured.map(definition => definition.id));
  const detected: LanguageServerDefinition[] = [];
  for (const preset of LANGUAGE_SERVER_PRESETS) {
    if (covered.has(preset.id)) continue;
    if (await probe(preset.command)) {
      detected.push({ ...preset, languages: [...preset.languages], extensions: [...preset.extensions], args: [...(preset.args ?? [])] });
    }
  }
  return [...configured, ...detected];
}
