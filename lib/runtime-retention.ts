import { TELEGRAM_MAX_ATTEMPTS } from './telegram-outbox-policy.ts';

export const RUNTIME_RETENTION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * Privacy and abandoned-attempt retention for the live database.
 *
 * D1 executes a batch atomically. Keeping every mutation in the same batch
 * prevents a half-purged attempt or a payload whose terminal status was saved
 * without the corresponding privacy scrub.
 */
export async function applyRuntimeRetention(
  db: D1Database,
  now = Date.now(),
) {
  const cutoff = now - RUNTIME_RETENTION_MAX_AGE_MS;
  const staleAttempts = `SELECT id FROM attempts
    WHERE (status = 'active' AND started_at <= ?)
      OR (status = 'aborted' AND COALESCE(completed_at, started_at) <= ?)`;
  const deleteChildren = (table: 'answers' | 'attempt_questions' | 'telegram_outbox') => (
    db.prepare(`DELETE FROM ${table} WHERE attempt_id IN (${staleAttempts})`)
      .bind(cutoff, cutoff)
  );

  await db.batch([
    db.prepare(`UPDATE telegram_outbox
      SET status = 'dead', payload_text = '', last_error_code = 'retry_exhausted',
        lease_token = NULL, lease_until = NULL
      WHERE status IN ('pending', 'sending')
        AND (attempt_count >= ? OR created_at <= ?)`)
      .bind(TELEGRAM_MAX_ATTEMPTS, cutoff),
    db.prepare(`UPDATE telegram_outbox
      SET payload_text = ''
      WHERE payload_text != ''
        AND (status IN ('sent', 'dead') OR created_at <= ?)`)
      .bind(cutoff),
    db.prepare(`UPDATE attempts
      SET candidate_name = NULL
      WHERE candidate_name IS NOT NULL
        AND (
          started_at <= ?
          OR (
            status IN ('completed', 'aborted')
            AND NOT EXISTS (
              SELECT 1 FROM telegram_outbox
              WHERE telegram_outbox.attempt_id = attempts.id
                AND telegram_outbox.status IN ('pending', 'sending')
            )
          )
        )`)
      .bind(cutoff),
    deleteChildren('answers'),
    deleteChildren('attempt_questions'),
    deleteChildren('telegram_outbox'),
    db.prepare(`DELETE FROM attempts
      WHERE (status = 'active' AND started_at <= ?)
        OR (status = 'aborted' AND COALESCE(completed_at, started_at) <= ?)`)
      .bind(cutoff, cutoff),
  ]);
}
