import path from 'node:path';
import { homedir } from 'node:os';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { createProjectSource } from './projectSource.js';
import { registerProjectWebApi } from './webApi.js';

export const name = 'hadamard-project';

export interface Config {
  /** Optional extra project, in addition to DSH's workspace/session discovery. */
  workDir?: string;
  /** Hadamard home/data-root; defaults to the current OS user home. */
  homeDir?: string;
  /** Maximum JSON response size; oversized content fails without truncation. */
  maxOutputBytes?: number;
}

export const Config: Schema<Config> = Schema.object({
  workDir: Schema.string().description('Optional extra workspace (absolute path). DSH projects are discovered automatically.'),
  homeDir: Schema.string().description('Optional Hadamard home/data-root (absolute path). Defaults to OS home.'),
  maxOutputBytes: Schema.number().min(1024).max(4194304).default(1048576),
});

export function apply(ctx: Context, config: Config = {}): void {
  for (const key of ['workDir', 'homeDir'] as const) {
    if (config[key] !== undefined && (!config[key]?.trim() || !path.isAbsolute(config[key]!))) {
      throw new Error(`${key} must be an absolute path`);
    }
  }
  const maxOutputBytes = config.maxOutputBytes ?? 1048576;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 4194304) {
    throw new Error('maxOutputBytes must be an integer between 1024 and 4194304');
  }
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort(new Error('Project plugin unloaded')));
  registerProjectWebApi(ctx, createProjectSource(ctx, { ...config, homeDir: config.homeDir ?? homedir() }), lifetime.signal, maxOutputBytes);
}
