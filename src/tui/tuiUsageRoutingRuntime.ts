import {
  createEmbeddedKeyway,
  createHeadlessKeywaySecretStore,
  type EmbeddedKeyway,
} from '../keyway/embeddedKeyway.js';
import { UsageRoutingAdminService } from '../keyway/usageRoutingAdminService.js';
import { readLedgerSummary } from '../extensions/sessionCostTracker.js';
import { runUsageRoutingCommand } from '../ui/usageRoutingCommand.js';

export class TuiUsageRoutingRuntime {
  private embedded?: EmbeddedKeyway;
  private adminService?: UsageRoutingAdminService;

  constructor(
    private readonly homeDir: string,
    private readonly workDir: string,
  ) {}

  runCommand(
    command: string,
    args: string,
    promptSecret: (label: string) => Promise<string | undefined>,
  ): Promise<string[] | undefined> {
    return runUsageRoutingCommand(command, args, {
      admin: () => this.admin(),
      promptSecret,
    });
  }

  commandPorts(
    ledgerEnabled: () => boolean,
    promptSecret: (label: string) => Promise<string | undefined>,
  ) {
    return {
      usageLedgerSummary: () => ledgerEnabled()
        ? readLedgerSummary(this.homeDir).catch(() => null)
        : Promise.resolve(null),
      runUsageRoutingCommand: (command: string, args: string) =>
        this.runCommand(command, args, promptSecret),
    };
  }

  async close(): Promise<void> {
    this.adminService?.close();
    await this.embedded?.close();
  }

  private async admin(): Promise<UsageRoutingAdminService> {
    if (this.adminService) return this.adminService;
    const secretStore = await createHeadlessKeywaySecretStore({ homeDir: this.homeDir });
    this.embedded = await createEmbeddedKeyway({
      homeDir: this.homeDir,
      workDir: this.workDir,
      secretStore,
    });
    this.adminService = await UsageRoutingAdminService.open({
      homeDir: this.homeDir,
      store: this.embedded.store,
      secretStore,
      executor: this.embedded.executor,
    });
    return this.adminService;
  }
}
