import assert from 'node:assert/strict';
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
