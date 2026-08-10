import { describe, expect, it, vi } from 'vitest';

import { createGuiReferenceHttpService } from '../src/gui/guiReferenceHttpService.js';

describe('GUI reference HTTP service', () => {
  it('queries usages and broken references from one snapshot contract', async () => {
    const snapshot = vi.fn(async () => ({
      index: [
        {
          from: { kind: 'agent' as const, name: 'reviewer' },
          to: { kind: 'config' as const, name: 'default' },
          field: 'bridgeConfig',
        },
      ],
      known: { configs: ['default'], agents: ['reviewer'] },
    }));
    const service = createGuiReferenceHttpService({
      snapshot,
      rename: vi.fn(),
      repointModel: vi.fn(),
      mutationError: error => ({ status: 409, body: { error: String(error) } }),
    });

    await expect(service.list('config', 'default')).resolves.toEqual({
      status: 200,
      body: { edges: [(await snapshot()).index[0]] },
    });
    await expect(service.broken()).resolves.toEqual({ status: 200, body: { edges: [] } });
  });

  it('validates mutations and preserves host results and error mapping', async () => {
    const rename = vi.fn(async () => ({ rewritten: ['agent'], state: { active: true } }));
    const repointModel = vi.fn(async () => ({ rewritten: ['router'], state: { active: true } }));
    const service = createGuiReferenceHttpService({
      snapshot: vi.fn(),
      rename,
      repointModel,
      mutationError: error => ({ status: 409, body: { error: (error as Error).message } }),
    });

    await expect(service.rename({ kind: 'agent', oldName: 'old', newName: 'new' })).resolves.toEqual({
      status: 200,
      body: { ok: true, rewritten: ['agent'], state: { active: true } },
    });
    await expect(service.repointModel({ config: '', fromModel: 'old', toModel: 'new' })).resolves
      .toEqual({ status: 400, body: { error: 'Missing config/fromModel/toModel' } });
    expect(rename).toHaveBeenCalledWith('agent', 'old', 'new');
    expect(repointModel).not.toHaveBeenCalled();
  });
});
