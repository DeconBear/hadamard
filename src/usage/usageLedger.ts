import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  nodeSqliteDriverFactory,
  type SqliteDriver,
  type SqliteDriverFactory,
} from '../storage-v2/sqliteDriver.js';
import type {
  UsageEventV2,
  UsageFilter,
  UsageImportResult,
  UsagePage,
  UsageSummary,
} from './contracts.js';

const SCHEMA_VERSION = 1;
const FILTER_COLUMNS: Record<Exclude<keyof UsageFilter, 'from' | 'to'>, string> = {
  source: 'source',
  status: 'status',
  model: 'requested_model',
  providerId: 'provider_id',
  credentialId: 'credential_id',
  routeId: 'route_id',
  configurationId: 'configuration_id',
  projectId: 'project_id',
  agentId: 'agent_id',
  sessionId: 'session_id',
  runId: 'run_id',
};

export interface UsageLedgerOptions {
  filename: string;
  driverFactory?: SqliteDriverFactory;
}

export class UsageLedger {
  private constructor(private readonly driver: SqliteDriver) {
    initializeSchema(driver);
  }

  static async open(options: UsageLedgerOptions): Promise<UsageLedger> {
    if (!options.filename.trim()) throw new TypeError('filename must not be empty');
    if (options.filename !== ':memory:') {
      await mkdir(path.dirname(path.resolve(options.filename)), { recursive: true });
    }
    const driver = await (options.driverFactory ?? nodeSqliteDriverFactory).open(options.filename);
    try {
      return new UsageLedger(driver);
    } catch (error) {
      driver.close();
      throw error;
    }
  }

  append(event: UsageEventV2): boolean {
    assertUsageEvent(event);
    const result = this.driver.prepare(`
      INSERT OR IGNORE INTO usage_events (
        event_id, request_id, correlation_id, timestamp, source, status,
        requested_model, resolved_model, operation,
        provider_id, credential_id, route_id, configuration_id, project_id, agent_id,
        session_id, run_id, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, reasoning_tokens, audio_input_tokens, audio_output_tokens,
        requests, usage_accuracy, cost_usd, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.requestId,
      event.correlationId,
      event.timestamp,
      event.source,
      event.status,
      event.requestedModel,
      event.resolvedModel ?? null,
      event.operation,
      event.providerId ?? null,
      event.credentialId ?? null,
      event.routeId ?? null,
      event.configurationId ?? null,
      event.projectId ?? null,
      event.agentId ?? null,
      event.sessionId ?? null,
      event.runId ?? null,
      event.usage.inputTokens,
      event.usage.outputTokens,
      event.usage.cacheReadTokens,
      event.usage.cacheWriteTokens,
      event.usage.reasoningTokens,
      event.usage.audioInputTokens,
      event.usage.audioOutputTokens,
      event.usage.requests,
      event.usage.accuracy,
      event.usage.costUsd ?? 0,
      JSON.stringify(event),
    );
    return result.changes > 0;
  }

  query(page: UsagePage = {}): UsageEventV2[] {
    const { sql, parameters } = filterSql(page);
    const limit = clampInteger(page.limit, 100, 1, 1000);
    const offset = clampInteger(page.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    return this.driver.prepare(`
      SELECT event_json FROM usage_events${sql}
      ORDER BY timestamp DESC, event_id DESC LIMIT ? OFFSET ?
    `).all(...parameters, limit, offset).map(row => parseStoredEvent(row.event_json));
  }

  summarize(filter: UsageFilter = {}): UsageSummary {
    const { sql, parameters } = filterSql(filter);
    const row = this.driver.prepare(`
      SELECT
        COUNT(*) AS entries,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(audio_input_tokens), 0) AS audio_input_tokens,
        COALESCE(SUM(audio_output_tokens), 0) AS audio_output_tokens,
        COALESCE(SUM(requests), 0) AS requests,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        SUM(CASE WHEN usage_accuracy = 'unknown' THEN 1 ELSE 0 END) AS unknown_entries,
        SUM(CASE WHEN usage_accuracy = 'estimated' THEN 1 ELSE 0 END) AS estimated_entries
      FROM usage_events${sql}
    `).get(...parameters);
    return {
      entries: numeric(row?.entries),
      inputTokens: numeric(row?.input_tokens),
      outputTokens: numeric(row?.output_tokens),
      cacheReadTokens: numeric(row?.cache_read_tokens),
      cacheWriteTokens: numeric(row?.cache_write_tokens),
      totalTokens: numeric(row?.total_tokens),
      reasoningTokens: numeric(row?.reasoning_tokens),
      audioInputTokens: numeric(row?.audio_input_tokens),
      audioOutputTokens: numeric(row?.audio_output_tokens),
      requests: numeric(row?.requests),
      costUsd: numeric(row?.cost_usd),
      accuracy: numeric(row?.unknown_entries) > 0
        ? 'unknown'
        : numeric(row?.estimated_entries) > 0
          ? 'estimated'
          : 'actual',
    };
  }

  async importLegacyJsonl(filename: string): Promise<UsageImportResult> {
    let buffer: Buffer;
    try {
      buffer = await readFile(filename);
    } catch (error) {
      if (isMissingFile(error)) return { imported: 0, skipped: 0, malformed: 0 };
      throw error;
    }
    const sourceKey = path.resolve(filename);
    const checkpoint = this.driver.prepare(`
      SELECT byte_offset FROM usage_import_sources WHERE source_key = ?
    `).get(sourceKey);
    const previousOffset = numeric(checkpoint?.byte_offset);
    const startOffset = previousOffset <= buffer.length ? previousOffset : 0;
    if (startOffset === buffer.length) return { imported: 0, skipped: 0, malformed: 0 };
    return this.driver.transaction(() => {
      let imported = 0;
      let skipped = 0;
      let malformed = 0;
      let offset = startOffset;
      for (let cursor = startOffset; cursor <= buffer.length; cursor += 1) {
        if (cursor < buffer.length && buffer[cursor] !== 0x0a) continue;
        const raw = buffer.subarray(offset, cursor).toString('utf8').replace(/\r$/u, '');
        const lineOffset = offset;
        offset = cursor + 1;
        if (!raw.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          malformed += 1;
          continue;
        }
        const event = legacyEvent(value, raw, lineOffset);
        if (!event) {
          malformed += 1;
        } else if (this.append(event)) {
          imported += 1;
        } else {
          skipped += 1;
        }
      }
      this.driver.prepare(`
        INSERT INTO usage_import_sources (source_key, byte_offset, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
          byte_offset = excluded.byte_offset,
          updated_at = excluded.updated_at
      `).run(sourceKey, buffer.length, new Date().toISOString());
      return { imported, skipped, malformed };
    });
  }

  async exportJsonl(filename: string, filter: UsageFilter = {}): Promise<number> {
    await mkdir(path.dirname(path.resolve(filename)), { recursive: true });
    const events = [];
    for (let offset = 0; ; offset += 1000) {
      const page = this.query({ ...filter, limit: 1000, offset });
      events.push(...page);
      if (page.length < 1000) break;
    }
    await writeFile(filename, events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''), 'utf8');
    return events.length;
  }

  deleteBefore(timestamp: string): number {
    assertTimestamp(timestamp, 'timestamp');
    return this.driver.prepare('DELETE FROM usage_events WHERE timestamp < ?').run(timestamp).changes;
  }

  close(): void {
    this.driver.close();
  }
}

function initializeSchema(driver: SqliteDriver): void {
  driver.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS usage_schema (version INTEGER NOT NULL);
    INSERT INTO usage_schema(version)
      SELECT ${SCHEMA_VERSION} WHERE NOT EXISTS (SELECT 1 FROM usage_schema);
    CREATE TABLE IF NOT EXISTS usage_events (
      event_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_model TEXT NOT NULL,
      resolved_model TEXT,
      operation TEXT NOT NULL,
      provider_id TEXT,
      credential_id TEXT,
      route_id TEXT,
      configuration_id TEXT,
      project_id TEXT,
      agent_id TEXT,
      session_id TEXT,
      run_id TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      audio_input_tokens INTEGER NOT NULL,
      audio_output_tokens INTEGER NOT NULL,
      requests INTEGER NOT NULL,
      usage_accuracy TEXT NOT NULL,
      cost_usd REAL NOT NULL,
      event_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_events_timestamp ON usage_events(timestamp);
    CREATE INDEX IF NOT EXISTS usage_events_model ON usage_events(requested_model, timestamp);
    CREATE INDEX IF NOT EXISTS usage_events_provider ON usage_events(provider_id, timestamp);
    CREATE INDEX IF NOT EXISTS usage_events_route ON usage_events(route_id, timestamp);
    CREATE INDEX IF NOT EXISTS usage_events_configuration ON usage_events(configuration_id, timestamp);
    CREATE INDEX IF NOT EXISTS usage_events_project ON usage_events(project_id, timestamp);
    CREATE INDEX IF NOT EXISTS usage_events_agent ON usage_events(agent_id, timestamp);
    CREATE TABLE IF NOT EXISTS usage_import_sources (
      source_key TEXT PRIMARY KEY,
      byte_offset INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const row = driver.prepare('SELECT version FROM usage_schema LIMIT 1').get();
  if (numeric(row?.version) !== SCHEMA_VERSION) {
    throw new Error(`Unsupported usage ledger schema version: ${String(row?.version)}`);
  }
}

function filterSql(filter: UsageFilter): { sql: string; parameters: unknown[] } {
  const clauses: string[] = [];
  const parameters: unknown[] = [];
  if (filter.from) {
    assertTimestamp(filter.from, 'from');
    clauses.push('timestamp >= ?');
    parameters.push(filter.from);
  }
  if (filter.to) {
    assertTimestamp(filter.to, 'to');
    clauses.push('timestamp < ?');
    parameters.push(filter.to);
  }
  for (const [key, column] of Object.entries(FILTER_COLUMNS) as Array<[keyof typeof FILTER_COLUMNS, string]>) {
    const value = filter[key];
    if (value === undefined) continue;
    clauses.push(`${column} = ?`);
    parameters.push(value);
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', parameters };
}

function legacyEvent(value: unknown, raw: string, offset: number): UsageEventV2 | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version === 2 && typeof value.eventId === 'string') {
    try {
      const event = value as unknown as UsageEventV2;
      assertUsageEvent(event);
      return event;
    } catch {
      return undefined;
    }
  }
  // Legacy `/cost` included timestamp-less valid records in the all-time total.
  // Anchor them outside normal retention windows without pretending they are current usage.
  const timestamp = typeof value.ts === 'string' && Number.isFinite(Date.parse(value.ts))
    ? value.ts
    : '1970-01-01T00:00:00.000Z';
  const eventId = typeof value.eventId === 'string' && value.eventId
    ? value.eventId
    : `legacy:${createHash('sha256').update(raw).digest('hex')}:${offset}`;
  const costUsd = count(value.costUsd);
  return {
    version: 2,
    eventId,
    requestId: optionalString(value.requestId) ?? optionalString(value.runId) ?? eventId,
    correlationId: optionalString(value.correlationId) ?? optionalString(value.sessionId) ?? eventId,
    timestamp,
    source: usageSource(value.source) ?? 'import',
    status: 'succeeded',
    requestedModel: typeof value.model === 'string' && value.model ? value.model : 'unknown',
    operation: 'generate',
    ...(optionalString(value.providerId) ? { providerId: optionalString(value.providerId) } : {}),
    ...(optionalString(value.credentialId) ? { credentialId: optionalString(value.credentialId) } : {}),
    ...(optionalString(value.routeId) ? { routeId: optionalString(value.routeId) } : {}),
    ...(optionalString(value.configurationId) ? { configurationId: optionalString(value.configurationId) } : {}),
    ...(optionalString(value.projectId) ? { projectId: optionalString(value.projectId) } : {}),
    ...(optionalString(value.agentId) ? { agentId: optionalString(value.agentId) } : {}),
    ...(optionalString(value.sessionId) ? { sessionId: optionalString(value.sessionId) } : {}),
    ...(optionalString(value.runId) ? { runId: optionalString(value.runId) } : {}),
    usage: {
      requests: 1,
      inputTokens: count(value.inputTokens),
      outputTokens: count(value.outputTokens),
      totalTokens: count(value.inputTokens) + count(value.outputTokens),
      cacheReadTokens: count(value.cacheReadTokens),
      cacheWriteTokens: count(value.cacheWriteTokens),
      reasoningTokens: count(value.reasoningTokens),
      audioInputTokens: count(value.audioInputTokens),
      audioOutputTokens: count(value.audioOutputTokens),
      ...(costUsd > 0 ? { costUsd } : {}),
      accuracy: costUsd > 0 ? 'actual' : 'unknown',
    },
    attempts: [],
    durationMs: 0,
    streaming: false,
  };
}

function assertUsageEvent(event: UsageEventV2): void {
  if (event.version !== 2) throw new TypeError('usage event version must be 2');
  if (!event.eventId.trim()) throw new TypeError('usage event id must not be empty');
  if (!event.requestId.trim()) throw new TypeError('usage event request id must not be empty');
  if (!event.correlationId.trim()) throw new TypeError('usage event correlation id must not be empty');
  if (!event.requestedModel.trim()) throw new TypeError('usage event model must not be empty');
  assertTimestamp(event.timestamp, 'usage event timestamp');
  for (const [name, value] of Object.entries({
    requests: event.usage.requests,
    inputTokens: event.usage.inputTokens,
    outputTokens: event.usage.outputTokens,
    totalTokens: event.usage.totalTokens,
    cacheReadTokens: event.usage.cacheReadTokens,
    cacheWriteTokens: event.usage.cacheWriteTokens,
    reasoningTokens: event.usage.reasoningTokens,
    audioInputTokens: event.usage.audioInputTokens,
    audioOutputTokens: event.usage.audioOutputTokens,
    costUsd: event.usage.costUsd ?? 0,
    durationMs: event.durationMs,
  })) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a finite non-negative number`);
  }
}

function parseStoredEvent(value: unknown): UsageEventV2 {
  if (typeof value !== 'string') throw new TypeError('usage event payload must be a string');
  const event = JSON.parse(value) as UsageEventV2;
  assertUsageEvent(event);
  return event;
}

function assertTimestamp(value: string, name: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${name} must be an ISO timestamp`);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function usageSource(value: unknown): UsageEventV2['source'] | undefined {
  return value === 'hadamard' || value === 'bridge' || value === 'keyway'
    || value === 'native-cli' || value === 'import'
    ? value
    : value === 'hadamard-sdk'
      ? 'hadamard'
      : value === 'bridge-sdk'
        ? 'bridge'
        : value === 'keyway-gateway'
          ? 'keyway'
          : undefined;
}

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
