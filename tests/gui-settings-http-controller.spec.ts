import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { GuiHttpRouter } from '../src/gui/guiHttpRouter.js';
import {
  registerGuiSettingsHttpController,
  type GuiSettingsHttpControllerPort,
} from '../src/gui/guiSettingsHttpController.js';

function request(method: string, body?: unknown): IncomingMessage {
  return {
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  } as unknown as IncomingMessage;
}

function response(): ServerResponse & { status?: number; body?: unknown } {
  const result = {
    writeHead: vi.fn((status: number) => {
      result.status = status;
      return result;
    }),
    end: vi.fn((body?: string | Buffer) => {
      result.body = typeof body === 'string' && body.startsWith('{') ? JSON.parse(body) : body;
      return result;
    }),
  } as unknown as ServerResponse & { status?: number; body?: unknown };
  return result;
}

function createPort(): GuiSettingsHttpControllerPort {
  return {
    dataRootStatus: vi.fn(() => ({ path: 'E:/hadamard-home' })),
    changeDataRoot: vi.fn(async body => ({ ok: true, path: body.path })),
    openDataRoot: vi.fn(() => ({ path: 'E:/hadamard-home' })),
    openConfig: vi.fn(async () => ({ path: 'E:/hadamard-home/settings.json' })),
    saveSettings: vi.fn(async () => ({ ok: true })),
    readHooks: vi.fn(async () => ({ hooks: {}, typedHooks: [], typedHookIssues: [] })),
    saveHooks: vi.fn(async body => ({ ok: true, ...body })),
    mutationError: vi.fn(() => ({ status: 409, body: { error: 'busy' } })),
  };
}

async function invoke(
  port: GuiSettingsHttpControllerPort,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<ReturnType<typeof response>> {
  const router = new GuiHttpRouter();
  registerGuiSettingsHttpController(router, port);
  const res = response();
  expect(await router.handle(request(method, body), res, new URL(`http://localhost${pathname}`))).toBe(true);
  return res;
}

describe('GUI settings HTTP controller', () => {
  it('serves and changes the data root through the settings port', async () => {
    const port = createPort();
    const status = await invoke(port, 'GET', '/api/settings/data-root');
    expect(status.body).toEqual({ path: 'E:/hadamard-home' });

    const changed = await invoke(port, 'POST', '/api/settings/data-root', { path: 'E:/new-home' });
    expect(port.changeDataRoot).toHaveBeenCalledWith({ path: 'E:/new-home' });
    expect(changed.body).toEqual({ ok: true, path: 'E:/new-home' });
  });

  it('opens the data root and config while preserving missing-config status', async () => {
    const port = createPort();
    const root = await invoke(port, 'POST', '/api/settings/data-root/open');
    expect(root.body).toEqual({ ok: true, path: 'E:/hadamard-home' });

    vi.mocked(port.openConfig).mockResolvedValue(undefined);
    const missing = await invoke(port, 'POST', '/api/settings/open-config');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Settings path unavailable' });
  });

  it('delegates settings and hook persistence bodies', async () => {
    const port = createPort();
    await invoke(port, 'POST', '/api/settings', { model: 'configured-model' });
    expect(port.saveSettings).toHaveBeenCalledWith({ model: 'configured-model' });

    const hooks = await invoke(port, 'GET', '/api/hooks');
    expect(hooks.body).toEqual({ hooks: {}, typedHooks: [], typedHookIssues: [] });

    await invoke(port, 'PUT', '/api/hooks', { typedHooks: [] });
    expect(port.saveHooks).toHaveBeenCalledWith({ typedHooks: [] });
  });

  it('maps mutation conflicts consistently', async () => {
    const port = createPort();
    vi.mocked(port.saveSettings).mockRejectedValue(new Error('busy'));
    const res = await invoke(port, 'POST', '/api/settings', { model: 'x' });
    expect(port.mutationError).toHaveBeenCalled();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'busy' });
  });
});
