import { DatabaseSync } from 'node:sqlite';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const counts = process.argv.slice(2).map(Number).filter(Number.isSafeInteger);
const eventCounts = counts.length > 0 ? counts : [100_000, 1_000_000];

for (const count of eventCounts) {
  const root = mkdtempSync(path.join(tmpdir(), 'keyway-storage-bench-'));
  try {
    const sqlite = runSqlite(root, count);
    const jsonl = runJsonl(root, count);
    process.stdout.write(`${JSON.stringify({ count, sqlite, jsonl })}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runSqlite(root, count) {
  const file = path.join(root, 'usage.db');
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE usage_events (
      event_id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      total_tokens INTEGER NOT NULL,
      cost_usd REAL
    );
    CREATE INDEX usage_events_timestamp ON usage_events(timestamp);
    CREATE INDEX usage_events_provider ON usage_events(provider_id, timestamp);
  `);
  const insert = db.prepare('INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?)');
  const writeStarted = performance.now();
  db.exec('BEGIN IMMEDIATE');
  for (let index = 0; index < count; index += 1) {
    insert.run(
      `event-${index}`,
      1_700_000_000_000 + index * 1000,
      `provider-${index % 8}`,
      `model-${index % 24}`,
      100 + (index % 1000),
      (index % 1000) / 1_000_000,
    );
  }
  db.exec('COMMIT');
  const writeMs = performance.now() - writeStarted;
  const queryStarted = performance.now();
  const rows = db.prepare(`
    SELECT provider_id, SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost
    FROM usage_events
    WHERE timestamp >= ?
    GROUP BY provider_id
    ORDER BY tokens DESC
  `).all(1_700_000_000_000 + Math.floor(count / 2) * 1000);
  const queryMs = performance.now() - queryStarted;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const backupStarted = performance.now();
  copyFileSync(file, path.join(root, 'usage.backup.db'));
  const backupMs = performance.now() - backupStarted;
  return {
    writeMs: round(writeMs),
    queryMs: round(queryMs),
    backupMs: round(backupMs),
    bytes: statSync(file).size,
    groups: rows.length,
  };
}

function runJsonl(root, count) {
  const file = path.join(root, 'usage.jsonl');
  const fd = openSync(file, 'w');
  const writeStarted = performance.now();
  const batch = [];
  for (let index = 0; index < count; index += 1) {
    batch.push(JSON.stringify({
      eventId: `event-${index}`,
      timestamp: 1_700_000_000_000 + index * 1000,
      providerId: `provider-${index % 8}`,
      model: `model-${index % 24}`,
      totalTokens: 100 + (index % 1000),
      costUsd: (index % 1000) / 1_000_000,
    }));
    if (batch.length === 10_000) {
      appendFileSync(fd, `${batch.join('\n')}\n`);
      batch.length = 0;
    }
  }
  if (batch.length > 0) appendFileSync(fd, `${batch.join('\n')}\n`);
  closeSync(fd);
  const writeMs = performance.now() - writeStarted;
  const queryStarted = performance.now();
  const threshold = 1_700_000_000_000 + Math.floor(count / 2) * 1000;
  const groups = new Map();
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const event = JSON.parse(line);
    if (event.timestamp < threshold) continue;
    const current = groups.get(event.providerId) ?? { tokens: 0, cost: 0 };
    current.tokens += event.totalTokens;
    current.cost += event.costUsd;
    groups.set(event.providerId, current);
  }
  const queryMs = performance.now() - queryStarted;
  const backupStarted = performance.now();
  copyFileSync(file, path.join(root, 'usage.backup.jsonl'));
  const backupMs = performance.now() - backupStarted;
  return {
    writeMs: round(writeMs),
    queryMs: round(queryMs),
    backupMs: round(backupMs),
    bytes: statSync(file).size,
    groups: groups.size,
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}
