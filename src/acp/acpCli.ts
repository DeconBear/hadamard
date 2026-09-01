#!/usr/bin/env node
import {
  createHadamardCoreTools,
  createAgentSdk,
  loadDefaultHadamardSettings,
} from '../index.js';
import { readPackageVersion } from '../cli/version.js';
import type { HadamardPermissionMode, RuntimeProviderId } from '../types.js';
import { CleanAcpEngine, type AcpRuntimeEngine } from './acpEngine.js';
import { ACP_BRIDGE_RUNTIMES, BridgeAcpEngine } from './acpBridgeEngine.js';
import { AcpServer } from './acpServer.js';
import { AcpStdioTransport } from './acpStdioTransport.js';

export const HADAMARD_ACP_ENGINES = ['clean', 'bridge'] as const;
export type HadamardAcpEngine = (typeof HADAMARD_ACP_ENGINES)[number];

export interface AcpCliOptions {
  engine: HadamardAcpEngine;
  runtime?: RuntimeProviderId;
  model?: string;
  permissionMode?: HadamardPermissionMode;
}

export function parseAcpCliArgs(argv: string[]): AcpCliOptions {
  const options: { engine?: string; runtime?: string; model?: string; permissionMode?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} requires a value.`);
      return value;
    };
    if (arg === '--engine') options.engine = next();
    else if (arg?.startsWith('--engine=')) options.engine = arg.slice('--engine='.length);
    else if (arg === '--runtime') options.runtime = next();
    else if (arg?.startsWith('--runtime=')) options.runtime = arg.slice('--runtime='.length);
    else if (arg === '--model') options.model = next();
    else if (arg?.startsWith('--model=')) options.model = arg.slice('--model='.length);
    else if (arg === '--permission-mode') options.permissionMode = next();
    else if (arg?.startsWith('--permission-mode=')) options.permissionMode = arg.slice('--permission-mode='.length);
    else throw new Error(`Unknown argument: ${String(arg)}`);
  }
  const engine = options.engine ?? 'clean';
  // team/hybrid engines are planned (plan/DSH_HADAMARD_RUNTIME_PLUGIN_01Sep2026.md
  // Phase 4); fail fast rather than silently running a different runtime.
  if (!(HADAMARD_ACP_ENGINES as readonly string[]).includes(engine)) {
    throw new Error(
      `Unsupported --engine "${engine}". Implemented engines: ${HADAMARD_ACP_ENGINES.join(', ')}.`,
    );
  }
  if (options.runtime !== undefined
    && !(ACP_BRIDGE_RUNTIMES as readonly string[]).includes(options.runtime)) {
    throw new Error(
      `Unsupported --runtime "${options.runtime}". Known runtimes: ${ACP_BRIDGE_RUNTIMES.join(', ')}.`,
    );
  }
  if (engine === 'bridge' && options.runtime === undefined) {
    throw new Error(`--engine bridge requires --runtime (${ACP_BRIDGE_RUNTIMES.join(', ')}).`);
  }
  if (engine === 'clean' && options.runtime !== undefined) {
    throw new Error('--runtime only applies to --engine bridge; the clean engine runs the in-process Hadamard SDK.');
  }
  const permissionMode = options.permissionMode ?? 'default';
  const modes: readonly string[] = ['default', 'acceptEdits', 'bypassPermissions', 'approveForMe', 'plan', 'auto'];
  if (!modes.includes(permissionMode)) {
    throw new Error(`Unsupported --permission-mode "${permissionMode}". Expected one of: ${modes.join(', ')}.`);
  }
  return {
    engine: engine as HadamardAcpEngine,
    runtime: options.runtime as RuntimeProviderId | undefined,
    model: options.model,
    permissionMode: permissionMode as HadamardPermissionMode,
  };
}

async function createEngine(cli: AcpCliOptions, workDir: string): Promise<AcpRuntimeEngine> {
  if (cli.engine === 'bridge') {
    // authSource stays 'native' inside BridgeAcpEngine: reuse the CLI's own
    // login, never read or copy OAuth/session secrets.
    return BridgeAcpEngine.create({
      runtime: cli.runtime ?? 'claude',
      workDir,
      model: cli.model,
      permissionMode: cli.permissionMode,
    });
  }
  const sdk = await createAgentSdk({
    workDir,
    tools: createHadamardCoreTools({ cwd: workDir }),
    permissionMode: cli.permissionMode,
    model: cli.model,
  });
  return new CleanAcpEngine(sdk, { model: cli.model, permissionMode: cli.permissionMode });
}

async function main(): Promise<void> {
  const cli = parseAcpCliArgs(process.argv.slice(2));
  await loadDefaultHadamardSettings();
  const workDir = process.cwd();
  const engine = await createEngine(cli, workDir);
  const server = new AcpServer({
    engine,
    agentVersion: readPackageVersion(import.meta.url),
  });
  const close = async () => {
    server.shutdown('hadamard-acp shutting down');
    await engine.close();
  };
  process.once('SIGINT', () => { void close().finally(() => process.exit(130)); });
  process.once('SIGTERM', () => { void close().finally(() => process.exit(143)); });
  try {
    await new AcpStdioTransport(server).start();
  } finally {
    await close();
  }
}

const isDirectRun = process.argv[1]?.endsWith('hadamard-acp.js')
  || process.argv[1]?.endsWith('acpCli.js');
if (isDirectRun) {
  main().catch(error => {
    process.stderr.write(`hadamard-acp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
