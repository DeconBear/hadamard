/** Stable public facade for the Hadamard SDK terminal surface. */
import { pathToFileURL } from 'node:url';

import { printWelcomeSplash } from './tuiWelcomeBanner.js';
import type { HadamardTuiOptions } from './tuiTypes.js';

export { HADAMARD_INTERACTIVE_COMMANDS as TUI_SLASH_COMMANDS } from '../ui/commandSurface.js';
export {
  activeAtToken,
  filterSlashCommands,
  isTuiChatSession,
  renderRichText,
} from './tuiTextPresenter.js';
export type { HadamardTuiOptions } from './tuiTypes.js';

export async function runHadamardTui(options: HadamardTuiOptions = {}): Promise<void> {
  const { runHadamardTui: run } = await import('./hadamardTuiController.js');
  return run(options);
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

if (isDirectRun()) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'hadamard TUI requires an interactive terminal (TTY). Run it directly in your terminal — not piped or through another tool.\n',
    );
    process.exit(1);
  }
  printWelcomeSplash();
  runHadamardTui().catch((error: unknown) => {
    process.stderr.write(`Fatal: ${(error as Error).stack ?? (error as Error).message}\n`);
    process.exit(1);
  });
}
