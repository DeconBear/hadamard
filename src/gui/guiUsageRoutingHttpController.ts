import { json, readJson, type GuiHttpRouter } from './guiHttpRouter.js';
import { usageFilterFromSearch, type UsageRoutingAdminService } from '../keyway/usageRoutingAdminService.js';

export type GuiUsageRoutingPort = Pick<UsageRoutingAdminService,
  | 'overview' | 'ledger' | 'catalog'
  | 'saveCredential' | 'deleteCredential' | 'testCredential'
  | 'saveTarget' | 'deleteTarget' | 'testTarget'
  | 'saveRoute' | 'deleteRoute'
  | 'saveBudget' | 'deleteBudget'
  | 'gatewayStatus' | 'startGateway' | 'stopGateway'
  | 'previewBridgeMigration' | 'importBridgeMigration'
  | 'previewPortableMigration' | 'importPortableMigration'
  | 'installArkAgentPlan'>;

export interface GuiUsageRoutingSelectionPort {
  activateRoute(reference: string): Promise<{ routeAlias: string; model: string }>;
}

function failure(res: Parameters<typeof json>[0], error: unknown): void {
  json(res, error instanceof TypeError ? 400 : 500, {
    error: error instanceof TypeError ? error.message : 'Usage & Routing operation failed.',
  });
}

export function registerGuiUsageRoutingHttpController(
  router: GuiHttpRouter,
  port: GuiUsageRoutingPort,
  selection?: GuiUsageRoutingSelectionPort,
): void {
  router.route('GET', '/api/usage-routing/overview', (_req, res, url) => {
    json(res, 200, port.overview(usageFilterFromSearch(url.searchParams)));
  });
  router.route('GET', '/api/usage-routing/ledger', (_req, res, url) => {
    json(res, 200, port.ledger(usageFilterFromSearch(url.searchParams)));
  });
  router.route('GET', '/api/usage-routing/catalog', async (_req, res) => {
    try { json(res, 200, { ...(await port.catalog()), gateway: port.gatewayStatus() }); } catch (error) { failure(res, error); }
  });
  router.route('POST', '/api/usage-routing/gateway/start', async (req, res) => {
    try {
      const body = await readJson(req);
      json(res, 200, await port.startGateway(typeof body.port === 'number' ? body.port : 0));
    } catch (error) { failure(res, error); }
  });
  router.route('POST', '/api/usage-routing/gateway/stop', async (_req, res) => {
    try { json(res, 200, await port.stopGateway()); } catch (error) { failure(res, error); }
  });
  router.route('POST', '/api/usage-routing/presets/ark-agent-plan', async (req, res) => {
    try { json(res, 200, await port.installArkAgentPlan(await readJson(req))); } catch (error) { failure(res, error); }
  });
  router.route('POST', /^\/api\/usage-routing\/routes\/[^/]+\/activate$/u, async (_req, res, url) => {
    try {
      if (!selection) throw new TypeError('Gateway Route activation is unavailable in this host.');
      const reference = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
      json(res, 200, await selection.activateRoute(reference));
    } catch (error) { failure(res, error); }
  });
  router.route('GET', '/api/usage-routing/migration/bridge', (_req, res) => {
    try { json(res, 200, port.previewBridgeMigration()); } catch (error) { failure(res, error); }
  });
  router.route('POST', '/api/usage-routing/migration/bridge', async (_req, res) => {
    try { json(res, 200, await port.importBridgeMigration()); } catch (error) { failure(res, error); }
  });
  for (const action of ['preview', 'import'] as const) {
    router.route('POST', `/api/usage-routing/migration/portable/${action}`, async (req, res) => {
      try {
        const body = await readJson(req);
        if (typeof body.filePath !== 'string' || !body.filePath.trim()) throw new TypeError('filePath is required.');
        json(res, 200, action === 'preview'
          ? await port.previewPortableMigration(body.filePath)
          : await port.importPortableMigration(body.filePath));
      } catch (error) { failure(res, error); }
    });
  }
  for (const [resource, save, remove] of [
    ['credentials', port.saveCredential.bind(port), port.deleteCredential.bind(port)],
    ['targets', async (body: Record<string, unknown>) => port.saveTarget(body), async (id: string) => port.deleteTarget(id)],
    ['routes', async (body: Record<string, unknown>) => port.saveRoute(body), async (id: string) => port.deleteRoute(id)],
    ['budgets', async (body: Record<string, unknown>) => port.saveBudget(body), async (id: string) => port.deleteBudget(id)],
  ] as const) {
    router.route('PUT', `/api/usage-routing/${resource}`, async (req, res) => {
      try { json(res, 200, { ok: true, ...(await save(await readJson(req))) }); } catch (error) { failure(res, error); }
    });
    router.route('DELETE', new RegExp(`^/api/usage-routing/${resource}/[^/]+$`, 'u'), async (_req, res, url) => {
      try {
        const id = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
        json(res, 200, { ok: await remove(id) });
      } catch (error) { failure(res, error); }
    });
  }
  router.route('POST', /^\/api\/usage-routing\/credentials\/[^/]+\/test$/u, async (_req, res, url) => {
    try {
      const id = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
      json(res, 200, await port.testCredential(id));
    } catch (error) { failure(res, error); }
  });
  router.route('POST', /^\/api\/usage-routing\/targets\/[^/]+\/test$/u, async (_req, res, url) => {
    try {
      const id = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
      json(res, 200, await port.testTarget(id));
    } catch (error) { failure(res, error); }
  });
}
