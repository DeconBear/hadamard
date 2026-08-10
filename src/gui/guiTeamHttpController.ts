import { json, readJson, type GuiHttpRouter } from './guiHttpRouter.js';

export interface GuiTeamHttpResult {
  status: number;
  body: unknown;
}

export interface GuiTeamHttpControllerPort {
  definition(name: string): Promise<GuiTeamHttpResult> | GuiTeamHttpResult;
  restoreDefault(name: string): Promise<GuiTeamHttpResult> | GuiTeamHttpResult;
  save(body: Record<string, unknown>): Promise<GuiTeamHttpResult>;
  scaffold(body: Record<string, unknown>): Promise<GuiTeamHttpResult> | GuiTeamHttpResult;
  applyBlock(body: Record<string, unknown>): Promise<GuiTeamHttpResult> | GuiTeamHttpResult;
  proposal(
    id: string,
    action: string | undefined,
    method: string | undefined,
    body: Record<string, unknown>,
  ): Promise<GuiTeamHttpResult>;
  validate(body: Record<string, unknown>): Promise<GuiTeamHttpResult> | GuiTeamHttpResult;
  upgrade(body: Record<string, unknown>): Promise<GuiTeamHttpResult> | GuiTeamHttpResult;
  delete(body: Record<string, unknown>): Promise<GuiTeamHttpResult>;
  preferences(body: Record<string, unknown>): Promise<GuiTeamHttpResult>;
}

function respond(res: Parameters<typeof json>[0], result: GuiTeamHttpResult): void {
  json(res, result.status, result.body);
}

export function registerGuiTeamHttpController(
  router: GuiHttpRouter,
  port: GuiTeamHttpControllerPort,
): void {
  router.route('GET', '/api/team/definition', async (_req, res, url) => {
    respond(res, await port.definition(url.searchParams.get('name') || ''));
  });
  router.route('GET', '/api/team/restore-default', async (_req, res, url) => {
    respond(res, await port.restoreDefault(url.searchParams.get('name') || ''));
  });
  router.route('POST', '/api/team/save', async (req, res) => {
    respond(res, await port.save(await readJson(req)));
  });
  router.route('POST', '/api/team/scaffold', async (req, res) => {
    respond(res, await port.scaffold(await readJson(req)));
  });
  router.route('POST', '/api/team/apply-block', async (req, res) => {
    respond(res, await port.applyBlock(await readJson(req)));
  });
  router.route('GET', /^\/api\/team\/proposals\/[^/]+$/u, async (req, res, url) => {
    const match = url.pathname.match(/^\/api\/team\/proposals\/([^/]+)$/u)!;
    respond(res, await port.proposal(decodeURIComponent(match[1]!), undefined, req.method, {}));
  });
  router.route('POST', /^\/api\/team\/proposals\/[^/]+\/(?:apply|reject)$/u, async (req, res, url) => {
    const match = url.pathname.match(/^\/api\/team\/proposals\/([^/]+)\/(apply|reject)$/u)!;
    const body = await readJson(req).catch(() => ({}));
    respond(res, await port.proposal(decodeURIComponent(match[1]!), match[2], req.method, body));
  });
  router.route('POST', '/api/team/validate', async (req, res) => {
    respond(res, await port.validate(await readJson(req)));
  });
  router.route('POST', '/api/team/upgrade', async (req, res) => {
    respond(res, await port.upgrade(await readJson(req)));
  });
  router.route('POST', '/api/team/delete', async (req, res) => {
    respond(res, await port.delete(await readJson(req)));
  });
  router.route('POST', '/api/team/preferences', async (req, res) => {
    respond(res, await port.preferences(await readJson(req)));
  });
}
