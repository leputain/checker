export const TELEGRAM_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000] as const;
export const TELEGRAM_MAX_ATTEMPTS = 10;
export const TELEGRAM_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const TELEGRAM_LEASE_MS = 30_000;
export const TELEGRAM_GROUP_MIN_INTERVAL_MS = 3_100;

export const OUTBOX_CLAIM_SQL = `UPDATE telegram_outbox
  SET status = 'sending', attempt_count = attempt_count + 1,
    lease_token = ?, lease_until = ?, next_attempt_at = ?
  WHERE id = (
    SELECT id FROM telegram_outbox
    WHERE attempt_id = ?
      AND attempt_count < ?
      AND created_at >= ?
      AND ((status = 'pending' AND next_attempt_at <= ?)
        OR (status = 'sending' AND lease_until <= ?))
      AND NOT EXISTS (
        SELECT 1 FROM telegram_outbox AS in_flight
        WHERE in_flight.status = 'sending' AND in_flight.lease_until > ?
      )
      AND COALESCE((SELECT MAX(sent_at) FROM telegram_outbox), 0) <= ?
      AND NOT EXISTS (
        SELECT 1 FROM telegram_outbox AS older
        WHERE older.attempt_id = telegram_outbox.attempt_id
          AND older.status IN ('pending','sending')
          AND (older.created_at < telegram_outbox.created_at
            OR (older.created_at = telegram_outbox.created_at AND older.id < telegram_outbox.id))
      )
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  )
  RETURNING *`;

export function outboxClaimBindings(attemptId: string, leaseToken: string, now: number) {
  return [
    leaseToken,
    now + TELEGRAM_LEASE_MS,
    now + TELEGRAM_LEASE_MS,
    attemptId,
    TELEGRAM_MAX_ATTEMPTS,
    now - TELEGRAM_MAX_AGE_MS,
    now,
    now,
    now,
    now - TELEGRAM_GROUP_MIN_INTERVAL_MS,
  ] as const;
}

export const OUTBOX_MAINTENANCE_NEXT_ATTEMPT_SQL = `SELECT candidate.attempt_id
  FROM telegram_outbox AS candidate
  WHERE candidate.attempt_count < ?
    AND candidate.created_at >= ?
    AND ((candidate.status = 'pending' AND candidate.next_attempt_at <= ?)
      OR (candidate.status = 'sending' AND candidate.lease_until <= ?))
    AND NOT EXISTS (
      SELECT 1 FROM telegram_outbox AS in_flight
      WHERE in_flight.status = 'sending' AND in_flight.lease_until > ?
    )
    AND COALESCE((SELECT MAX(sent_at) FROM telegram_outbox), 0) <= ?
    AND NOT EXISTS (
      SELECT 1 FROM telegram_outbox AS older
      WHERE older.attempt_id = candidate.attempt_id
        AND older.status IN ('pending','sending')
        AND (older.created_at < candidate.created_at
          OR (older.created_at = candidate.created_at AND older.id < candidate.id))
    )
  ORDER BY candidate.created_at ASC, candidate.id ASC
  LIMIT 1`;

export function outboxMaintenanceBindings(now: number) {
  return [
    TELEGRAM_MAX_ATTEMPTS,
    now - TELEGRAM_MAX_AGE_MS,
    now,
    now,
    now,
    now - TELEGRAM_GROUP_MIN_INTERVAL_MS,
  ] as const;
}
