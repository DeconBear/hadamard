import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createEmbeddedKeyway } from '../src/keyway/embeddedKeyway.js';
import { probeKeywayNativeTargetAuth } from '../src/keyway/keywayProviderExecutor.js';
import type { KeywayJson, KeywaySecretStorePort } from '../src/keyway/keywayPorts.js';

const runtime = nativeRuntime(process.env.KEYWAY_NATIVE_RUNTIME?.trim() || 'claude');
const model = process.env.KEYWAY_NATIVE_MODEL?.trim() || (runtime === 'claude' ? 'sonnet' : 'gpt-5');
const timeoutMs = positiveTimeout(process.env.KEYWAY_NATIVE_TIMEOUT_MS?.trim() || '300000');
const target = {
  kind: 'native-cli' as const,
  id: `target.native.${runtime}`,
  runtime,
  enabled: true,
};
const auth = await probeKeywayNativeTargetAuth(target);
if (auth.state !== 'authenticated' && auth.state !== 'configured') {
  process.stdout.write(`${JSON.stringify({ runtime, model, auth, skipped: true }, null, 2)}\n`);
  process.exit(2);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-keyway-native-live-'));
const routeAlias = `native-${runtime}-live`;
const secretStore: KeywaySecretStorePort = {
  async put() { throw new TypeError('Native CLI smoke does not accept managed secrets.'); },
  async resolve() { return undefined; },
  async has() { return false; },
  async remove() {},
};

try {
  const embedded = await createEmbeddedKeyway({ homeDir: root, workDir: root, secretStore });
  try {
    const timestamp = new Date().toISOString();
    embedded.store.saveTarget(target);
    embedded.store.saveRoute({
      id: `route.native.${runtime}.live`,
      alias: routeAlias,
      mode: 'direct',
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      candidates: [{
        id: `candidate.native.${runtime}.live`,
        targetId: target.id,
        upstreamModel: model,
        priority: 0,
        weight: 1,
        enabled: true,
      }],
    });

    const first = await execute(embedded, routeAlias, model, root, {
      prompt: 'Reply with exactly NATIVE_ROUTE_OK and no other text. Do not use tools.',
    });
    const firstOutput = output(first.output);
    if (!firstOutput.text.includes('NATIVE_ROUTE_OK')) throw new Error('Native route response did not contain NATIVE_ROUTE_OK.');
    if (!firstOutput.sessionId) throw new Error('Native route did not return a resumable session id.');

    const second = await execute(embedded, routeAlias, model, root, {
      prompt: 'Reply with exactly NATIVE_RESUME_OK and no other text. Do not use tools.',
      sessionId: firstOutput.sessionId,
    });
    const secondOutput = output(second.output);
    if (!secondOutput.text.includes('NATIVE_RESUME_OK')) throw new Error('Resumed native response did not contain NATIVE_RESUME_OK.');
    if (secondOutput.sessionId !== firstOutput.sessionId) throw new Error('Native session id changed during resume.');

    process.stdout.write(`${JSON.stringify({
      runtime,
      model,
      auth,
      routeAlias,
      routeIds: [first.routeId, second.routeId],
      sessionResumePassed: true,
      sessionHash: createHash('sha256').update(firstOutput.sessionId).digest('hex').slice(0, 16),
      responses: [firstOutput.text.slice(0, 80), secondOutput.text.slice(0, 80)],
      usage: [first.usage, second.usage],
    }, null, 2)}\n`);
  } finally {
    await embedded.close();
  }
} finally {
  await delay(500);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

async function execute(
  embedded: Awaited<ReturnType<typeof createEmbeddedKeyway>>,
  route: string,
  requestedModel: string,
  workDir: string,
  payload: { prompt: string; sessionId?: string },
) {
  const requestId = `native-live-${randomUUID()}`;
  return embedded.core.execute({
    requestId,
    correlationId: requestId,
    routeAlias: route,
    requestedModel,
    operation: 'generate',
    payload: { ...payload, workDir },
    signal: AbortSignal.timeout(timeoutMs),
  }).result;
}

function output(value: KeywayJson): { text: string; sessionId?: string } {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new TypeError('Invalid native result output.');
  if (typeof value.text !== 'string') throw new TypeError('Native result output is missing text.');
  return {
    text: value.text,
    ...(typeof value.sessionId === 'string' && value.sessionId ? { sessionId: value.sessionId } : {}),
  };
}

function nativeRuntime(value: string): 'claude' | 'codex' {
  if (value === 'claude' || value === 'codex') return value;
  throw new TypeError('KEYWAY_NATIVE_RUNTIME must be claude or codex.');
}

function positiveTimeout(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError('KEYWAY_NATIVE_TIMEOUT_MS must be a positive integer.');
  return parsed;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
