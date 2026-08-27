import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import {
  OUTBOX_CLAIM_SQL,
  OUTBOX_MAINTENANCE_NEXT_ATTEMPT_SQL,
  outboxClaimBindings,
  outboxMaintenanceBindings,
  TELEGRAM_GROUP_MIN_INTERVAL_MS,
} from '../lib/telegram-outbox-policy.ts';

const miniflare = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  d1Databases: { DB: crypto.randomUUID() },
});

try {
  const db = await miniflare.getD1Database('DB');
  await db.prepare(`CREATE TABLE telegram_outbox (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    lease_token TEXT,
    lease_until INTEGER,
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  )`).run();
  const now = 1_800_000_000_000;
  const insert = db.prepare(`INSERT INTO telegram_outbox (
    id, attempt_id, status, attempt_count, next_attempt_at, created_at
  ) VALUES (?, ?, 'pending', 0, ?, ?)`);
  await db.batch([
    insert.bind('a-1', 'attempt-a', now, now),
    insert.bind('a-2', 'attempt-a', now, now + 1),
    insert.bind('b-1', 'attempt-b', now, now),
  ]);

  const first = await db
    .prepare(OUTBOX_CLAIM_SQL)
    .bind(...outboxClaimBindings('attempt-a', 'lease-a-1', now))
    .first<{ id: string }>();
  assert.equal(first?.id, 'a-1');

  const concurrent = await db
    .prepare(OUTBOX_CLAIM_SQL)
    .bind(...outboxClaimBindings('attempt-b', 'lease-b-1', now))
    .first<{ id: string }>();
  assert.equal(concurrent, null, 'one group must have only one in-flight send');
  const maintenanceWhileSending = await db
    .prepare(OUTBOX_MAINTENANCE_NEXT_ATTEMPT_SQL)
    .bind(...outboxMaintenanceBindings(now))
    .first<{ attempt_id: string }>();
  assert.equal(maintenanceWhileSending, null, 'maintenance must respect the global send lease');

  await db
    .prepare("UPDATE telegram_outbox SET status = 'sent', sent_at = ?, lease_token = NULL, lease_until = NULL WHERE id = 'a-1'")
    .bind(now)
    .run();
  const duringCooldown = await db
    .prepare(OUTBOX_CLAIM_SQL)
    .bind(...outboxClaimBindings('attempt-a', 'lease-a-2', now))
    .first<{ id: string }>();
  assert.equal(duringCooldown, null, 'group cooldown must prevent bursts');

  const afterCooldown = await db
    .prepare(OUTBOX_CLAIM_SQL)
    .bind(...outboxClaimBindings('attempt-a', 'lease-a-2', now + TELEGRAM_GROUP_MIN_INTERVAL_MS))
    .first<{ id: string }>();
  assert.equal(afterCooldown?.id, 'a-2', 'events must preserve attempt order');

  await db
    .prepare("UPDATE telegram_outbox SET status = 'pending', next_attempt_at = ?, lease_token = NULL, lease_until = NULL WHERE id = 'a-2'")
    .bind(now + 60_000)
    .run();
  await db
    .prepare(`INSERT INTO telegram_outbox (
      id, attempt_id, status, attempt_count, next_attempt_at, created_at
    ) VALUES ('a-3', 'attempt-a', 'pending', 0, ?, ?)`)
    .bind(now + TELEGRAM_GROUP_MIN_INTERVAL_MS, now + 2)
    .run();
  const overtaking = await db
    .prepare(OUTBOX_CLAIM_SQL)
    .bind(...outboxClaimBindings('attempt-a', 'lease-a-3', now + TELEGRAM_GROUP_MIN_INTERVAL_MS))
    .first<{ id: string }>();
  assert.equal(overtaking, null, 'a later event must not overtake a delayed earlier event');

  const maintenanceCandidate = await db
    .prepare(OUTBOX_MAINTENANCE_NEXT_ATTEMPT_SQL)
    .bind(...outboxMaintenanceBindings(now + TELEGRAM_GROUP_MIN_INTERVAL_MS))
    .first<{ attempt_id: string }>();
  assert.equal(
    maintenanceCandidate?.attempt_id,
    'attempt-b',
    'maintenance must select one globally eligible attempt without overtaking within an attempt',
  );

  console.log('telegram outbox policy tests: PASS');
} finally {
  await miniflare.dispose();
}

const migrationMiniflare = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  d1Databases: { DB: crypto.randomUUID() },
});

try {
  const db = await migrationMiniflare.getD1Database('DB');
  await db.batch([
    db.prepare('CREATE TABLE attempts (id TEXT PRIMARY KEY NOT NULL)'),
    db.prepare(`CREATE TABLE telegram_outbox (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      question_id INTEGER,
      event_type TEXT NOT NULL CHECK (event_type IN ('answer','completed')),
      payload_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','dead')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      lease_token TEXT,
      lease_until INTEGER,
      telegram_message_id INTEGER,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    )`),
    db.prepare(`CREATE UNIQUE INDEX idx_telegram_outbox_attempt_event
      ON telegram_outbox (attempt_id, question_id, event_type)`),
    db.prepare(`CREATE INDEX idx_telegram_outbox_pending
      ON telegram_outbox (status, next_attempt_at, created_at)`),
    db.prepare("INSERT INTO attempts (id) VALUES ('legacy-attempt')"),
    db.prepare(`INSERT INTO telegram_outbox (
      id, attempt_id, question_id, event_type, payload_text, next_attempt_at, created_at
    ) VALUES ('legacy-answer', 'legacy-attempt', 7, 'answer', 'legacy', 1, 1)`),
  ]);

  const migration = await readFile(
    new URL('../drizzle/0006_numerous_jack_flag.sql', import.meta.url),
    'utf8',
  );
  await db.batch(migration
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => db.prepare(statement)));

  const table = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'telegram_outbox'")
    .first<{ sql: string }>();
  assert.doesNotMatch(table?.sql ?? '', /event_type IN/);
  await db.batch(['started', 'progress', 'aborted'].map((eventType, index) => (
    db.prepare(`INSERT INTO telegram_outbox (
      id, attempt_id, event_type, payload_text, delivery_method, next_attempt_at, created_at
    ) VALUES (?, 'legacy-attempt', ?, 'test', 'send', 2, ?)`)
      .bind(`new-${eventType}`, eventType, index + 2)
  )));
  const migrated = await db
    .prepare(`SELECT COUNT(*) AS count,
      SUM(CASE WHEN delivery_method = 'send' THEN 1 ELSE 0 END) AS send_count
      FROM telegram_outbox`)
    .first<{ count: number; send_count: number }>();
  assert.deepEqual(migrated, { count: 4, send_count: 4 });
  console.log('telegram legacy migration test: PASS');
} finally {
  await migrationMiniflare.dispose();
}
