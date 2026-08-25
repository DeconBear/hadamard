import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEmbeddedKeyway } from '../src/keyway/embeddedKeyway.js';
import type { KeywayExecutionTargetPort } from '../src/keyway/keywayPorts.js';
import type { ModelApi } from '../src/types.js';
import { UsageQueryService } from '../src/usage/usageQueryService.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const realPackages = process.env.HADAMARD_KEYWAY_REAL_PACKAGES === '1' ? describe : describe.skip;

realPackages('embedded Keyway real package smoke', () => {
  it('loads packed core/node modules and routes a managed request into the shared ledger', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-keyway-real-'));
    tempDirs.push(root);
    const homeDir = path.join(root, '.hadamard');
    const secrets = new Map<string, string>();
    const modelApi: ModelApi = {
      async createMessage(request) {
        return {
          id: 'message-real-smoke',
          type: 'message',
          role: 'assistant',
          model: request.model,
          content: [{ type: 'text', text: 'real package smoke' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 8 },
        };
      },
      streamMessage() { throw new Error('not used'); },
    };
    const embedded = await createEmbeddedKeyway({
      homeDir,
      secretStore: {
        async put(ref, value) { secrets.set(ref, value); },
        async resolve(ref) { return secrets.get(ref); },
        async has(ref) { return secrets.has(ref); },
        async remove(ref) { secrets.delete(ref); },
      },
      managedModelApiFactory: async () => modelApi,
    });
    const store = embedded.store as unknown as {
      saveTarget(target: KeywayExecutionTargetPort): void;
      saveCredential(value: Record<string, unknown>): void;
      saveRoute(value: Record<string, unknown>): void;
    };
    const timestamp = new Date().toISOString();
    store.saveTarget({
      kind: 'managed-api', id: 'target.ark', providerId: 'ark', protocol: 'openai',
      baseUrl: 'https://ark.example.test/v1', enabled: true,
    });
    store.saveCredential({
      id: 'credential.ark', providerId: 'ark', secretRef: 'secret.ark', label: 'Ark smoke',
      priority: 0, weight: 1, enabled: true, createdAt: timestamp, updatedAt: timestamp,
    });
    store.saveRoute({
      id: 'route.ark', alias: 'ark-smoke', mode: 'direct', enabled: true,
      createdAt: timestamp, updatedAt: timestamp,
      candidates: [{
        id: 'candidate.ark', targetId: 'target.ark', upstreamModel: 'glm-smoke',
        priority: 0, weight: 1, enabled: true,
      }],
    });
    secrets.set('secret.ark', 'smoke-secret');
    try {
      await embedded.core.execute({
        requestId: 'request.real-smoke',
        correlationId: 'correlation.real-smoke',
        routeAlias: 'ark-smoke',
        requestedModel: 'ark-smoke',
        operation: 'generate',
        payload: {
          modelRequest: {
            model: 'ark-smoke', messages: [{ role: 'user', content: 'hello' }], max_tokens: 256,
          },
        },
      }).result;
    } finally {
      await embedded.close();
    }

    const query = await UsageQueryService.open(homeDir);
    expect(query.summary()).toMatchObject({
      entries: 1, inputTokens: 12, outputTokens: 4, cacheReadTokens: 8,
    });
    expect(query.events()[0]).toMatchObject({ source: 'keyway', routeId: 'route.ark' });
    query.close();
  });
});
