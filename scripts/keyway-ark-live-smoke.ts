import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createEmbeddedKeyway } from '../src/keyway/embeddedKeyway.js';
import type { KeywayJson, KeywaySecretStorePort } from '../src/keyway/keywayPorts.js';

const apiKey = process.env.ARK_API_KEY?.trim();
if (!apiKey) {
  process.stderr.write('ARK_API_KEY is required. Set it in the process environment; do not place it in a file or command argument.\n');
  process.exit(2);
}

const baseUrl = process.env.ARK_BASE_URL?.trim()
  || 'https://ark.cn-beijing.volces.com/api/plan/v3';
const root = await mkdtemp(path.join(os.tmpdir(), 'hadamard-keyway-ark-live-'));
const secrets = new Map<string, string>();
const secretStore: KeywaySecretStorePort = {
  async put(ref, value) { secrets.set(ref, value); },
  async resolve(ref) { return secrets.get(ref); },
  async has(ref) { return secrets.has(ref); },
  async remove(ref) { secrets.delete(ref); },
};
const probes: ProbeResult[] = [];

try {
  const embedded = await createEmbeddedKeyway({ homeDir: root, secretStore });
  const timestamp = new Date().toISOString();
  const providerId = 'ark-agent-plan';
  const targetId = 'target.ark-agent-plan';
  const credentialId = 'credential.ark-agent-plan.live';
  const secretRef = `secret:${credentialId}`;
  embedded.store.saveTarget({
    kind: 'managed-api',
    id: targetId,
    providerId,
    protocol: 'openai',
    baseUrl,
    enabled: true,
  });
  embedded.store.saveCredential({
    id: credentialId,
    providerId,
    secretRef,
    label: 'Ark Agent Plan live smoke',
    priority: 0,
    weight: 1,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await secretStore.put(secretRef, apiKey);
  for (const model of ['glm-5.2', 'glm-5.3'] as const) {
    embedded.store.saveRoute({
      id: `route.ark.${model}`,
      alias: `ark-${model}`,
      mode: 'direct',
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      candidates: [{
        id: `candidate.ark.${model}`,
        targetId,
        upstreamModel: model,
        priority: 0,
        weight: 1,
        enabled: true,
      }],
    });
  }

  try {
    probes.push(await runProbe(embedded, 'glm-5.2', stablePrompt(), apiKey));
    probes.push(await runProbe(embedded, 'glm-5.2', stablePrompt(), apiKey));
    probes.push(await runProbe(embedded, 'glm-5.3', [
      { role: 'user', content: '请用一句简短中文确认：Keyway 的 GLM-5.3 路由可以正常对话。' },
    ], apiKey));
  } finally {
    await embedded.close();
  }
} finally {
  secrets.clear();
  await rm(root, { recursive: true, force: true });
}

const cacheReadTokens = probes
  .filter((probe): probe is ProbeSuccess => probe.ok)
  .reduce((sum, probe) => sum + probe.usage.cacheReadTokens, 0);
const report = {
  endpoint: baseUrl,
  probes,
  routingPassed: probes.every(probe => probe.ok),
  cacheObserved: cacheReadTokens > 0,
  cacheReadTokens,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.routingPassed) process.exitCode = 1;

function stablePrompt(): KeywayJson[] {
  const prefix = Array.from({ length: 160 }, (_, index) =>
    `稳定缓存前缀 ${index + 1}：Hadamard 使用 Keyway 统一管理模型路由、凭证、限额和用量账本。`).join('\n');
  return [
    { role: 'system', content: prefix },
    { role: 'user', content: '请只用一句简短中文确认：GLM-5.2 路由对话正常。' },
  ];
}

async function runProbe(
  embedded: Awaited<ReturnType<typeof createEmbeddedKeyway>>,
  model: 'glm-5.2' | 'glm-5.3',
  messages: KeywayJson[],
  secret: string,
): Promise<ProbeResult> {
  const requestId = `ark-live-${randomUUID()}`;
  try {
    const result = await embedded.core.execute({
      requestId,
      correlationId: requestId,
      routeAlias: `ark-${model}`,
      requestedModel: model,
      operation: 'generate',
      payload: {
        modelRequest: {
          model,
          messages,
          max_tokens: 128,
        },
      },
    }).result;
    const text = extractText(result.output);
    if (!text.trim()) throw new Error('Provider returned an empty assistant message.');
    return {
      ok: true,
      model,
      routeId: result.routeId,
      responsePreview: text.slice(0, 160),
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        totalTokens: result.usage.totalTokens,
        accuracy: result.usage.accuracy,
      },
      attempts: result.attempts.map(attempt => ({
        targetId: attempt.targetId,
        upstreamModel: attempt.upstreamModel,
        status: attempt.status,
        latencyMs: attempt.latencyMs,
      })),
    };
  } catch (error) {
    return {
      ok: false,
      model,
      error: sanitizeError(error, secret),
    };
  }
}

function extractText(value: KeywayJson): string {
  if (typeof value === 'string') return value;
  if (!value || Array.isArray(value) || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (!Array.isArray(value.content)) return '';
  return value.content.map(block => {
    if (typeof block === 'string') return block;
    return block && !Array.isArray(block) && typeof block === 'object'
      && block.type === 'text' && typeof block.text === 'string'
      ? block.text
      : '';
  }).join('');
}

function sanitizeError(error: unknown, secret: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(secret, '[redacted]').slice(0, 300);
}

interface ProbeSuccess {
  ok: true;
  model: string;
  routeId: string;
  responsePreview: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    accuracy: string;
  };
  attempts: Array<{
    targetId: string;
    upstreamModel: string;
    status: string;
    latencyMs: number;
  }>;
}

interface ProbeFailure {
  ok: false;
  model: string;
  error: string;
}

type ProbeResult = ProbeSuccess | ProbeFailure;
