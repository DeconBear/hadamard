import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { LoopbackGateway } from '../src/keyway/vendor/gateway/index.js';

const options = parseArguments(process.argv.slice(2));
const route = {
  id: 'route.soak',
  alias: 'soak-chat',
  mode: 'direct',
  enabled: true,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
  candidates: [{
    id: 'candidate.soak',
    targetId: 'target.soak',
    upstreamModel: 'soak-model',
    priority: 0,
    weight: 1,
    enabled: true,
  }],
};
const clientKey = `db_sk_${randomBytes(32).toString('base64url')}`;
let executed = 0;
let requests = 0;
let failures = 0;
let stopped = false;
const errors = [];
const samples = [];
const startedAt = Date.now();
const deadline = startedAt + options.durationMs;

const core = {
  execute(request) {
    executed += 1;
    return {
      result: Promise.resolve({
        requestId: request.requestId,
        correlationId: request.correlationId,
        routeId: route.id,
        attempts: [],
        output: {
          id: `message.${executed}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'soak-ok' }],
          stop_reason: 'end_turn',
        },
        usage: {
          requests: 1,
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          audioInputTokens: 0,
          audioOutputTokens: 0,
          accuracy: 'actual',
        },
        statusCode: 200,
        providerRequestId: `provider.${executed}`,
      }),
      cancel() {},
      async *[Symbol.asyncIterator]() {},
    };
  },
};

const gateway = await LoopbackGateway.start({
  core,
  store: { async listRoutes() { return [route]; } },
  clientKeys: [clientKey],
});

const sampleTimer = setInterval(() => {
  sample('running');
}, options.sampleIntervalMs);
sampleTimer.unref();
sample('running');

process.once('SIGINT', () => { stopped = true; });
process.once('SIGTERM', () => { stopped = true; });

try {
  await Promise.all(Array.from({ length: options.concurrency }, (_, workerId) => worker(workerId)));
} finally {
  clearInterval(sampleTimer);
  await gateway.close();
}

await delay(1000);
sample(stopped ? 'interrupted' : 'complete');
const report = buildReport(stopped ? 'interrupted' : failures ? 'failed' : 'passed');
writeReport(report);
if (!options.output) console.log(JSON.stringify(report, null, 2));
if (failures) process.exitCode = 1;

async function worker(workerId) {
  const delayMs = Math.max(0, Math.ceil((options.concurrency * 1000) / options.requestsPerSecond));
  while (!stopped && Date.now() < deadline) {
    const sequence = requests++;
    const correlationId = `soak.${workerId}.${sequence}.${randomUUID()}`;
    const anthropic = sequence % 5 === 0;
    const streaming = !anthropic && sequence % 20 === 0;
    try {
      const response = await fetch(`${gateway.status().url}${anthropic ? '/v1/messages' : '/v1/chat/completions'}`, {
        method: 'POST',
        headers: anthropic
          ? { 'content-type': 'application/json', 'x-api-key': clientKey, 'x-correlation-id': correlationId }
          : { 'content-type': 'application/json', authorization: `Bearer ${clientKey}`, 'x-correlation-id': correlationId },
        body: JSON.stringify({
          model: route.alias,
          messages: [{ role: 'user', content: 'health probe' }],
          max_tokens: 8,
          ...(streaming ? { stream: true } : {}),
        }),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (response.headers.get('x-correlation-id') !== correlationId) throw new Error('correlation mismatch');
      if (streaming) {
        if (!body.includes('data: [DONE]')) throw new Error('stream terminator missing');
      } else {
        const parsed = JSON.parse(body);
        if (anthropic) {
          if (parsed?.content?.[0]?.text !== 'soak-ok') throw new Error('Anthropic response mismatch');
        } else if (parsed?.choices?.[0]?.message?.content !== 'soak-ok') {
          throw new Error('OpenAI response mismatch');
        }
      }
    } catch (error) {
      failures += 1;
      if (errors.length < 20) errors.push(error instanceof Error ? error.message : String(error));
    }
    if (delayMs) await delay(delayMs);
  }
}

function sample(status) {
  const memory = process.memoryUsage();
  samples.push({
    at: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    status,
    requests,
    executed,
    failures,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    activeHandles: activeHandleCount(),
  });
  if (samples.length > 1000) samples.splice(0, samples.length - 1000);
  if (options.output) writeReport(buildReport(status));
}

function buildReport(status) {
  const elapsedMs = Math.max(1, Date.now() - startedAt);
  const first = samples[0];
  const last = samples.at(-1);
  return {
    status,
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: new Date().toISOString(),
    configuredDurationMs: options.durationMs,
    elapsedMs,
    concurrency: options.concurrency,
    targetRequestsPerSecond: options.requestsPerSecond,
    requests,
    executed,
    failures,
    errorRate: requests ? failures / requests : 0,
    throughputRequestsPerSecond: requests / (elapsedMs / 1000),
    rssStartBytes: first?.rssBytes ?? 0,
    rssEndBytes: last?.rssBytes ?? 0,
    rssMaxBytes: Math.max(...samples.map(value => value.rssBytes)),
    activeHandlesStart: first?.activeHandles ?? 0,
    activeHandlesEnd: last?.activeHandles ?? 0,
    activeHandlesMax: Math.max(...samples.map(value => value.activeHandles)),
    recentErrors: errors,
    samples,
  };
}

function writeReport(report) {
  if (!options.output) return;
  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function activeHandleCount() {
  return typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : -1;
}

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith('--') || value === undefined) throw new TypeError(`Invalid argument near ${name ?? '<end>'}.`);
    values.set(name.slice(2), value);
  }
  return {
    durationMs: positiveInteger(values.get('duration-ms') ?? '7200000', 'duration-ms'),
    concurrency: positiveInteger(values.get('concurrency') ?? '25', 'concurrency'),
    requestsPerSecond: positiveInteger(values.get('rps') ?? '50', 'rps'),
    sampleIntervalMs: positiveInteger(values.get('sample-ms') ?? '60000', 'sample-ms'),
    output: values.has('output') ? path.resolve(values.get('output')) : undefined,
  };
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new RangeError(`--${name} must be a positive integer.`);
  return parsed;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
