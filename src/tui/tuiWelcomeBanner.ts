/**
 * Hadamard TUI entry banner. Kept dependency-light so the CLI can print a
 * splash before the heavy controller/SDK graph loads.
 */
import { readPackageVersion } from '../cli/version.js';
import { A, truncateToWidth } from './ansi.js';

export interface TuiWelcomePageOptions {
  workDir: string;
  model: string;
  toolCount: number;
  permissionMode: string;
  version?: string;
  width?: number;
}

export function resolveTuiWelcomeVersion(version?: string): string {
  return version ?? readPackageVersion(import.meta.url);
}

export function formatWelcomeWordmark(version?: string): string[] {
  const resolved = resolveTuiWelcomeVersion(version);
  const mark = `${A.cyan}${A.bold}`;
  return [
    '',
    `${mark}█  █${A.reset}  ${A.bold}Hadamard${A.reset}${A.dim}  v${resolved}${A.reset}`,
    `${mark}████${A.reset}  ${A.dim}Agent team platform${A.reset}`,
    `${mark}█  █${A.reset}`,
  ];
}

export function formatWelcomeStatus(options: TuiWelcomePageOptions): string[] {
  const width = Math.max(options.width ?? 80, 20);
  const workDir = truncateToWidth(options.workDir, Math.max(width - 12, 20));
  return [
    `${A.dim}      cwd    ${A.reset}${workDir}`,
    `${A.dim}      model  ${A.reset}${options.model}${A.dim}  ·  ${options.permissionMode}${A.reset}`,
    `${A.dim}      tools  ${A.reset}${options.toolCount} loaded`,
  ];
}

export function formatWelcomeTips(): string[] {
  return [
    '',
    `${A.dim}      Type a prompt to start · /help commands · /model to switch${A.reset}`,
    '',
  ];
}

/** Full entry-page banner shown in the TUI transcript after runtime is ready. */
export function formatWelcomePage(options: TuiWelcomePageOptions): string[] {
  return [
    ...formatWelcomeWordmark(options.version),
    ...formatWelcomeStatus(options),
    ...formatWelcomeTips(),
  ];
}

/** Compact session banner kept for callers that still import `formatBanner`. */
export function formatBanner(options: TuiWelcomePageOptions): string[] {
  return formatWelcomePage(options);
}

/** Immediate stdout splash printed before the TUI controller is imported. */
export function printWelcomeSplash(options: {
  version?: string;
  stream?: NodeJS.WriteStream;
} = {}): void {
  const stream = options.stream ?? process.stdout;
  const lines = [
    ...formatWelcomeWordmark(options.version),
    `${A.dim}      starting…${A.reset}`,
    '',
  ];
  stream.write(`${lines.join('\n')}\n`);
}
