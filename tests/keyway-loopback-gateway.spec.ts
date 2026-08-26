import { describe, expect, it, vi } from 'vitest';

import { KeywayLoopbackGatewayController } from '../src/keyway/keywayLoopbackGateway.js';
import type {
  KeywayCorePort,
  KeywayGatewayModulePort,
  KeywayLoopbackGatewayInstancePort,
  KeywayStorePort,
} from '../src/keyway/keywayPorts.js';

describe('KeywayLoopbackGatewayController', () => {
  it('returns a client key once and never exposes it from status', async () => {
    const close = vi.fn(async () => undefined);
    const start = vi.fn(async (): Promise<KeywayLoopbackGatewayInstancePort> => ({
      status: () => ({
        running: true,
        host: '127.0.0.1',
        port: 3210,
        url: 'http://127.0.0.1:3210',
        authentication: 'client-key',
      }),
      close,
    }));
    const module: KeywayGatewayModulePort = {
      KEYWAY_GATEWAY_VERSION: 1,
      LoopbackGateway: { start },
    };
    const controller = new KeywayLoopbackGatewayController({
      core: {} as KeywayCorePort,
      store: {} as KeywayStorePort,
      gatewayModule: module,
    });
    const first = await controller.start();
    expect(first.clientKey).toMatch(/^db_sk_/u);
    expect(first.newlyStarted).toBe(true);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      host: '127.0.0.1',
      clientKeys: [first.clientKey],
    }));
    expect(JSON.stringify(controller.status())).not.toContain(first.clientKey);
    const second = await controller.start();
    expect(second).not.toHaveProperty('clientKey');
    expect(second.newlyStarted).toBe(false);
    await controller.stop();
    expect(close).toHaveBeenCalledOnce();
    expect(controller.status()).toMatchObject({ running: false });
  });

  it('serializes concurrent starts and validates the requested port', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const start = vi.fn(async (): Promise<KeywayLoopbackGatewayInstancePort> => {
      await pending;
      return {
        status: () => ({
          running: true,
          host: '127.0.0.1',
          port: 3210,
          url: 'http://127.0.0.1:3210',
          authentication: 'client-key',
        }),
        async close() {},
      };
    });
    const controller = new KeywayLoopbackGatewayController({
      core: {} as KeywayCorePort,
      store: {} as KeywayStorePort,
      gatewayModule: { KEYWAY_GATEWAY_VERSION: 1, LoopbackGateway: { start } },
    });
    await expect(controller.start(-1)).rejects.toThrow('port');
    const first = controller.start();
    const second = controller.start();
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(start).toHaveBeenCalledOnce();
    expect(firstResult).toHaveProperty('clientKey');
    expect(secondResult).not.toHaveProperty('clientKey');
    await controller.stop();
  });
});
