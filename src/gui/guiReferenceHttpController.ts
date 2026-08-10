import { json, readJson, type GuiHttpRouter } from './guiHttpRouter.js';

export interface GuiReferenceHttpResult {
  status: number;
  body: unknown;
}

export interface GuiReferenceHttpControllerPort {
  list(kind: string, name: string): Promise<GuiReferenceHttpResult>;
  broken(): Promise<GuiReferenceHttpResult>;
  rename(body: Record<string, unknown>): Promise<GuiReferenceHttpResult>;
  repointModel(body: Record<string, unknown>): Promise<GuiReferenceHttpResult>;
}

function respond(res: Parameters<typeof json>[0], result: GuiReferenceHttpResult): void {
  json(res, result.status, result.body);
}

export function registerGuiReferenceHttpController(
  router: GuiHttpRouter,
  port: GuiReferenceHttpControllerPort,
): void {
  router.route('GET', '/api/references', async (_req, res, url) => {
    respond(
      res,
      await port.list(
        url.searchParams.get('kind')?.trim() ?? '',
        url.searchParams.get('name')?.trim() ?? '',
      ),
    );
  });
  router.route('GET', '/api/references/broken', async (_req, res) => {
    respond(res, await port.broken());
  });
  router.route('POST', '/api/references/rename', async (req, res) => {
    respond(res, await port.rename(await readJson(req)));
  });
  router.route('POST', '/api/references/repoint-model', async (req, res) => {
    respond(res, await port.repointModel(await readJson(req)));
  });
}
