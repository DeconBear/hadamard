import { json, readJson, type GuiHttpRouter } from './guiHttpRouter.js';

export interface GuiAgentHttpResult {
  status: number;
  body: unknown;
}

export interface GuiAgentHttpControllerPort {
  listProfiles(): Promise<GuiAgentHttpResult> | GuiAgentHttpResult;
  saveProfile(body: Record<string, unknown>): Promise<GuiAgentHttpResult>;
  deleteProfile(body: Record<string, unknown>): Promise<GuiAgentHttpResult>;
  definition(name: string): Promise<GuiAgentHttpResult> | GuiAgentHttpResult;
  templates(): Promise<GuiAgentHttpResult> | GuiAgentHttpResult;
  instantiateTemplate(body: Record<string, unknown>): Promise<GuiAgentHttpResult>;
  activate(body: Record<string, unknown>): Promise<GuiAgentHttpResult>;
}

function respond(res: Parameters<typeof json>[0], result: GuiAgentHttpResult): void {
  json(res, result.status, result.body);
}

export function registerGuiAgentHttpController(
  router: GuiHttpRouter,
  port: GuiAgentHttpControllerPort,
): void {
  router.route('GET', '/api/agent-profiles', async (_req, res) => {
    respond(res, await port.listProfiles());
  });
  router.route('POST', '/api/agent-profiles', async (req, res) => {
    respond(res, await port.saveProfile(await readJson(req)));
  });
  router.route('POST', '/api/agent-profiles/delete', async (req, res) => {
    respond(res, await port.deleteProfile(await readJson(req)));
  });
  router.route('GET', '/api/agent-definition', async (_req, res, url) => {
    respond(res, await port.definition(url.searchParams.get('name')?.trim() ?? ''));
  });
  router.route('GET', '/api/agent-templates', async (_req, res) => {
    respond(res, await port.templates());
  });
  router.route('POST', '/api/agent-templates/instantiate', async (req, res) => {
    respond(res, await port.instantiateTemplate(await readJson(req)));
  });
  router.route('POST', '/api/agent/activate', async (req, res) => {
    respond(res, await port.activate(await readJson(req)));
  });
}
