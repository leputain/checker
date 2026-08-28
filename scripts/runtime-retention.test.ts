import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import {
  applyRuntimeRetention,
  RUNTIME_RETENTION_MAX_AGE_MS,
} from '../lib/runtime-retention.ts';
import {
  TELEGRAM_MAX_ATTEMPTS,
} from '../lib/telegram-outbox-policy.ts';

const now = Date.parse('2026-08-28T12:00:00.000Z');
const boundary = now - RUNTIME_RETENTION_MAX_AGE_MS;
const stale = now - RUNTIME_RETENTION_MAX_AGE_MS - 1;
const fresh = now - 60_000;

const miniflare = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok") } }',
  d1Databases: { DB: crypto.randomUUID() },
});

try {
  const db = await miniflare.getD1Database('DB');
  await db.batch([
    db.prepare(`CREATE TABLE attempts (
      id TEXT PRIMARY KEY,
      candidate_name TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    )`),
    db.prepare(`CREATE TABLE answers (
      id INTEGER PRIMARY KEY,
      attempt_id TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE attempt_questions (
      attempt_id TEXT NOT NULL,
      question_id INTEGER NOT NULL,
      PRIMARY KEY (attempt_id, question_id)
    )`),
    db.prepare(`CREATE TABLE telegram_outbox (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      payload_text TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      lease_token TEXT,
      lease_until INTEGER,
      last_error_code TEXT
    )`),
  ]);

  const insertAttempt = db.prepare(`INSERT INTO attempts (
    id, candidate_name, status, started_at, completed_at
  ) VALUES (?, ?, ?, ?, ?)`);
  await db.batch([
    insertAttempt.bind('completed-old', 'Completed Old', 'completed', stale, stale),
    insertAttempt.bind('completed-pending', 'Completed Pending', 'completed', stale, stale),
    insertAttempt.bind('active-old', 'Active Old', 'active', stale, null),
    insertAttempt.bind('active-boundary', 'Active Boundary', 'active', boundary, null),
    insertAttempt.bind('aborted-old', 'Aborted Old', 'aborted', stale, stale),
    insertAttempt.bind('active-fresh', 'Active Fresh', 'active', fresh, null),
    insertAttempt.bind('aborted-fresh', 'Aborted Fresh', 'aborted', fresh, fresh),
  ]);

  await db.batch([
    db.prepare("INSERT INTO answers (id, attempt_id) VALUES (1, 'completed-old')"),
    db.prepare("INSERT INTO answers (id, attempt_id) VALUES (2, 'active-old')"),
    db.prepare("INSERT INTO answers (id, attempt_id) VALUES (3, 'aborted-old')"),
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id) VALUES ('completed-old', 1)"),
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id) VALUES ('active-old', 1)"),
    db.prepare("INSERT INTO attempt_questions (attempt_id, question_id) VALUES ('aborted-old', 1)"),
  ]);

  const insertOutbox = db.prepare(`INSERT INTO telegram_outbox (
    id, attempt_id, payload_text, status, attempt_count, created_at, lease_token, lease_until
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  await db.batch([
    insertOutbox.bind('sent-fresh', 'completed-old', 'sent-secret', 'sent', 1, fresh, null, null),
    insertOutbox.bind('dead-fresh', 'completed-old', 'dead-secret', 'dead', 1, fresh, null, null),
    insertOutbox.bind(
      'pending-old', 'completed-pending', 'expired-secret', 'pending', 1, stale, null, null,
    ),
    insertOutbox.bind(
      'pending-completed-fresh', 'completed-pending', 'restore-completed',
      'pending', 1, fresh, null, null,
    ),
    insertOutbox.bind(
      'pending-exhausted', 'active-fresh', 'exhausted-secret', 'pending',
      TELEGRAM_MAX_ATTEMPTS, fresh, null, null,
    ),
    insertOutbox.bind(
      'sending-old', 'active-fresh', 'sending-secret', 'sending', 1, stale, 'lease', now + 1_000,
    ),
    insertOutbox.bind(
      'pending-fresh', 'active-fresh', 'restore-me', 'pending', 1, fresh, null, null,
    ),
    insertOutbox.bind(
      'active-old-child', 'active-old', 'purge-me', 'pending', 1, fresh, null, null,
    ),
    insertOutbox.bind(
      'aborted-old-child', 'aborted-old', 'purge-me-too', 'sent', 1, fresh, null, null,
    ),
  ]);

  await applyRuntimeRetention(db, now);
  await applyRuntimeRetention(db, now);

  const attempts = await db.prepare(`SELECT id, candidate_name
    FROM attempts ORDER BY id`).all<{ id: string; candidate_name: string | null }>();
  assert.deepEqual(attempts.results, [
    { id: 'aborted-fresh', candidate_name: null },
    { id: 'active-fresh', candidate_name: 'Active Fresh' },
    { id: 'completed-old', candidate_name: null },
    { id: 'completed-pending', candidate_name: null },
  ]);

  const completedChildren = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM answers WHERE attempt_id = 'completed-old') AS answers,
    (SELECT COUNT(*) FROM attempt_questions WHERE attempt_id = 'completed-old') AS ledger`)
    .first<{ answers: number; ledger: number }>();
  assert.deepEqual(completedChildren, { answers: 1, ledger: 1 });

  const purgedChildren = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM answers WHERE attempt_id IN ('active-old', 'aborted-old')) AS answers,
    (SELECT COUNT(*) FROM attempt_questions
      WHERE attempt_id IN ('active-old', 'aborted-old')) AS ledger,
    (SELECT COUNT(*) FROM telegram_outbox
      WHERE attempt_id IN ('active-old', 'aborted-old')) AS outbox`)
    .first<{ answers: number; ledger: number; outbox: number }>();
  assert.deepEqual(purgedChildren, { answers: 0, ledger: 0, outbox: 0 });

  const outbox = await db.prepare(`SELECT id, status, payload_text, last_error_code
    FROM telegram_outbox ORDER BY id`).all<{
      id: string;
      status: string;
      payload_text: string;
      last_error_code: string | null;
    }>();
  assert.deepEqual(outbox.results, [
    { id: 'dead-fresh', status: 'dead', payload_text: '', last_error_code: null },
    {
      id: 'pending-completed-fresh', status: 'pending', payload_text: 'restore-completed',
      last_error_code: null,
    },
    {
      id: 'pending-exhausted', status: 'dead', payload_text: '',
      last_error_code: 'retry_exhausted',
    },
    { id: 'pending-fresh', status: 'pending', payload_text: 'restore-me', last_error_code: null },
    {
      id: 'pending-old', status: 'dead', payload_text: '',
      last_error_code: 'retry_exhausted',
    },
    {
      id: 'sending-old', status: 'dead', payload_text: '',
      last_error_code: 'retry_exhausted',
    },
    { id: 'sent-fresh', status: 'sent', payload_text: '', last_error_code: null },
  ]);

  console.log('runtime retention tests: PASS');
} finally {
  await miniflare.dispose();
}
