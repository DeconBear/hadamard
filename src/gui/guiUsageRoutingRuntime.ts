import { createEmbeddedKeyway, type EmbeddedKeyway } from '../keyway/embeddedKeyway.js';
import type { KeywaySecretStorePort } from '../keyway/keywayPorts.js';
import { UsageRoutingAdminService } from '../keyway/usageRoutingAdminService.js';
import { KeywayMigrationService } from '../keyway/keywayMigrationService.js';
import { readLedgerSummary } from '../extensions/sessionCostTracker.js';
import { runUsageRoutingCommand } from '../ui/usageRoutingCommand.js';
import type { GuiHttpRouter } from './guiHttpRouter.js';
import {
  registerGuiUsageRoutingHttpController,
  type GuiUsageRoutingPort,
} from './guiUsageRoutingHttpController.js';

export type { GuiUsageRoutingPort } from './guiUsageRoutingHttpController.js';

export interface GuiUsageRoutingRuntimeOptions {
  router: GuiHttpRouter;
  homeDir: string;
  workDir: string;
  secretStore?: KeywaySecretStorePort;
  admin?: GuiUsageRoutingPort;
}

export interface GuiUsageRoutingRuntime {
  admin?: GuiUsageRoutingPort;
  close(): Promise<void>;
}

export async function createGuiUsageRoutingRuntime(
  options: GuiUsageRoutingRuntimeOptions,
): Promise<GuiUsageRoutingRuntime> {
  let embedded: EmbeddedKeyway | undefined;
  let ownedAdmin: UsageRoutingAdminService | undefined;
  let admin = options.admin;
  if (!admin && options.secretStore) {
    try {
      embedded = await createEmbeddedKeyway({
        homeDir: options.homeDir,
        workDir: options.workDir,
        secretStore: options.secretStore,
      });
      ownedAdmin = await UsageRoutingAdminService.open({
        homeDir: options.homeDir,
        store: embedded.store,
        secretStore: options.secretStore,
        executor: embedded.executor,
        gateway: embedded.gateway,
        migration: new KeywayMigrationService({
          homeDir: options.homeDir,
          store: embedded.store,
          secretStore: options.secretStore,
        }),
      });
      admin = ownedAdmin;
    } catch (error) {
      process.stderr.write(`[hadamard-gui] warning: Usage & Routing unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  if (admin) registerGuiUsageRoutingHttpController(options.router, admin);
  return {
    admin,
    async close() {
      ownedAdmin?.close();
      await embedded?.close().catch(() => undefined);
    },
  };
}

export async function runGuiUsageRoutingCommand(
  admin: GuiUsageRoutingPort | undefined,
  name: string,
  args: string,
): Promise<{ type: 'command.result'; title: string; text: string } | undefined> {
  if (!['usage', 'limits', 'keys', 'routes', 'gateway'].includes(name)) return undefined;
  if (!admin) return name === 'usage' ? undefined : {
    type: 'command.result',
    title: 'Usage & Routing',
    text: 'Usage & Routing is unavailable. Install matching Keyway TS packages.',
  };
  const lines = await runUsageRoutingCommand(name, args, { admin: async () => admin });
  if (!lines) return undefined;
  return {
    type: 'command.result',
    title: name === 'usage' ? 'Usage' : 'Usage & Routing',
    text: lines.join('\n'),
  };
}

export async function appendGuiLedgerUsage(
  lines: string[],
  enabled: boolean,
  homeDir: string,
): Promise<void> {
  if (!enabled) return;
  const ledger = await readLedgerSummary(homeDir).catch(() => null);
  if (!ledger || ledger.entries === 0) return;
  lines.push(
    '',
    'Ledger (all sessions):',
    `  Today: ${(ledger.today.inputTokens + ledger.today.outputTokens).toLocaleString()} tokens, $${ledger.today.costUsd.toFixed(4)}`,
    `  Total: ${(ledger.total.inputTokens + ledger.total.outputTokens).toLocaleString()} tokens, $${ledger.total.costUsd.toFixed(4)} across ${ledger.entries} entries`,
  );
}
