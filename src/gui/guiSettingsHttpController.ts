import { json, readJson, type GuiHttpRouter } from './guiHttpRouter.js';

export interface GuiSettingsHttpControllerPort {
  dataRootStatus(): unknown;
  changeDataRoot(body: Record<string, unknown>): Promise<unknown>;
  openDataRoot(): { path: string };
  openConfig(): Promise<{ path: string } | undefined>;
  saveSettings(body: Record<string, unknown>): Promise<unknown>;
  readHooks(): Promise<unknown>;
  saveHooks(body: Record<string, unknown>): Promise<unknown>;
  mutationError(error: unknown): { status: number; body: unknown };
}

function mappedError(
  port: GuiSettingsHttpControllerPort,
  res: Parameters<typeof json>[0],
  error: unknown,
): void {
  const mapped = port.mutationError(error);
  json(res, mapped.status, mapped.body);
}

export function registerGuiSettingsHttpController(
  router: GuiHttpRouter,
  port: GuiSettingsHttpControllerPort,
): void {
  router.route('GET', '/api/settings/data-root', (_req, res) => {
    json(res, 200, port.dataRootStatus());
  });
  router.route('POST', '/api/settings/data-root', async (req, res) => {
    try {
      json(res, 200, await port.changeDataRoot(await readJson(req)));
    } catch (error) {
      mappedError(port, res, error);
    }
  });
  router.route('POST', '/api/settings/data-root/open', (_req, res) => {
    const opened = port.openDataRoot();
    json(res, 200, { ok: true, path: opened.path });
  });
  router.route('POST', '/api/settings/open-config', async (_req, res) => {
    const opened = await port.openConfig();
    if (!opened) return json(res, 404, { error: 'Settings path unavailable' });
    json(res, 200, { ok: true, path: opened.path });
  });
  router.route('POST', '/api/settings', async (req, res) => {
    try {
      json(res, 200, await port.saveSettings(await readJson(req)));
    } catch (error) {
      mappedError(port, res, error);
    }
  });
  router.route('GET', '/api/hooks', async (_req, res) => {
    json(res, 200, await port.readHooks());
  });
  router.route('PUT', '/api/hooks', async (req, res) => {
    try {
      json(res, 200, await port.saveHooks(await readJson(req)));
    } catch (error) {
      mappedError(port, res, error);
    }
  });
}
