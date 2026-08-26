import {
  createEmbeddedKeyway,
  createHeadlessKeywaySecretStore,
  type EmbeddedKeyway,
} from '../keyway/embeddedKeyway.js';
import { UsageRoutingAdminService } from '../keyway/usageRoutingAdminService.js';
import { KeywayMigrationService } from '../keyway/keywayMigrationService.js';
import { readLedgerSummary } from '../extensions/sessionCostTracker.js';
import { runUsageRoutingCommand } from '../ui/usageRoutingCommand.js';
import type { ModelApi } from '../types.js';

export class TuiUsageRoutingRuntime {
  private embedded?: EmbeddedKeyway;
  private adminService?: UsageRoutingAdminService;

  constructor(
    private readonly homeDir: string,
    private readonly workDir: string,
    private readonly onRouteSelected?: (selection: {
      routeAlias: string;
      model: string;
      modelApi: ModelApi;
    }) => Promise<void> | void,
  ) {}

  runCommand(
    command: string,
    args: string,
    promptSecret: (label: string) => Promise<string | undefined>,
  ): Promise<string[] | undefined> {
    return runUsageRoutingCommand(command, args, {
      admin: () => this.admin(),
      promptSecret,
      activateRoute: reference => this.activateRoute(reference),
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
      gateway: this.embedded.gateway,
      migration: new KeywayMigrationService({
        homeDir: this.homeDir,
        store: this.embedded.store,
        secretStore,
      }),
    });
    return this.adminService;
  }

  private async activateRoute(reference: string): Promise<{ routeAlias: string; model: string }> {
    const admin = await this.admin();
    const catalog = await admin.catalog();
    const route = catalog.routes.find(item => item.id === reference || item.alias === reference);
    if (!route || !route.enabled) throw new TypeError('Enabled Gateway Route not found.');
    const candidate = route.candidates.find(item => item.enabled) ?? route.candidates[0];
    if (!candidate || !this.embedded) throw new TypeError('Gateway Route has no enabled candidate.');
    const selection = {
      routeAlias: route.alias,
      model: candidate.upstreamModel,
      modelApi: this.embedded.modelApi({
        routeAlias: route.alias,
        configurationId: `keyway:${route.id}`,
        workDir: this.workDir,
      }),
    };
    await this.onRouteSelected?.(selection);
    return { routeAlias: selection.routeAlias, model: selection.model };
  }
}
