import { env } from 'cloudflare:workers';
import { sendTelegramMessage } from '@/lib/telegram-client.ts';
import type { TelegramDeliveryMethod } from '@/lib/telegram-client.ts';
import {
  normalizeTelegramReportMode,
  telegramReportPolicy,
} from '@/lib/telegram-report-policy.ts';
import { isTelegramRuntimeConfigReady } from '@/lib/telegram-runtime-config.ts';
import {
  OUTBOX_CLAIM_SQL,
  OUTBOX_MAINTENANCE_NEXT_ATTEMPT_SQL,
  outboxClaimBindings,
  outboxMaintenanceBindings,
  TELEGRAM_GROUP_MIN_INTERVAL_MS,
  TELEGRAM_MAX_AGE_MS,
  TELEGRAM_MAX_ATTEMPTS,
  TELEGRAM_RETRY_DELAYS_MS,
} from '@/lib/telegram-outbox-policy.ts';
import { database, sha256Hex } from './runtime';

type OutboxRow = {
  id: string;
  attempt_id: string;
  question_id: number | null;
  event_type: 'started' | 'progress' | 'answer' | 'completed' | 'aborted';
  payload_text: string;
  delivery_method: TelegramDeliveryMethod;
  parse_mode: string | null;
  silent: number;
  status: 'pending' | 'sending' | 'sent' | 'dead';
  attempt_count: number;
  next_attempt_at: number;
  lease_token: string | null;
  lease_until: number | null;
  created_at: number;
};

export function telegramRuntimeConfig() {
  const enabled = env.TELEGRAM_ENABLED !== '0';
  const required = env.TELEGRAM_REQUIRED !== '0';
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  const chatId = env.TELEGRAM_CHAT_ID?.trim() ?? '';
  const configStatus = env.TELEGRAM_CONFIG_STATUS?.trim().toLowerCase() ?? 'missing';
  const reportMode = normalizeTelegramReportMode(env.TELEGRAM_REPORT_MODE);
  return {
    enabled,
    required,
    configured: isTelegramRuntimeConfigReady({ status: configStatus, botToken, chatId }),
    botToken,
    chatId,
    reportMode,
  };
}

export function telegramNotificationPolicy() {
  const config = telegramRuntimeConfig();
  return {
    enabled: config.enabled,
    mode: config.reportMode,
    ...telegramReportPolicy(config.reportMode),
  };
}

async function configFingerprint(botToken: string, chatId: string) {
  return sha256Hex(`${botToken}\u0000${chatId}`);
}

export async function telegramReadiness() {
  const config = telegramRuntimeConfig();
  if (!config.enabled) return { ready: true, status: 'disabled' as const };
  if (!config.configured) {
    return {
      ready: !config.required,
      status: 'misconfigured' as const,
      code: 'telegram_misconfigured',
    };
  }
  const fingerprint = await configFingerprint(config.botToken, config.chatId);
  const state = await database()
    .prepare('SELECT config_fingerprint, status FROM telegram_delivery_state WHERE id = 1')
    .first<{ config_fingerprint: string; status: string }>();
  if (state?.config_fingerprint === fingerprint && state.status === 'misconfigured') {
    return { ready: !config.required, status: 'misconfigured' as const, code: 'telegram_misconfigured' };
  }
  return { ready: true, status: state?.status === 'degraded' ? 'degraded' as const : 'configured' as const };
}

async function recordDeliveryState(
  fingerprint: string,
  status: 'ready' | 'degraded' | 'misconfigured',
  errorCode: string | null,
) {
  await database()
    .prepare(`INSERT INTO telegram_delivery_state (
      id, config_fingerprint, status, error_code, updated_at
    ) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET config_fingerprint = excluded.config_fingerprint,
      status = excluded.status, error_code = excluded.error_code, updated_at = excluded.updated_at`)
    .bind(fingerprint, status, errorCode, Date.now())
    .run();
}

async function claimNext(attemptId: string, now: number) {
  const leaseToken = crypto.randomUUID();
  const row = await database()
    .prepare(OUTBOX_CLAIM_SQL)
    .bind(...outboxClaimBindings(attemptId, leaseToken, now))
    .first<OutboxRow>();
  return row ? { row, leaseToken } : null;
}

function retryDelay(attemptCount: number) {
  return TELEGRAM_RETRY_DELAYS_MS[
    Math.min(attemptCount - 1, TELEGRAM_RETRY_DELAYS_MS.length - 1)
  ];
}

async function pendingState(attemptId: string, now = Date.now()) {
  const row = await database()
    .prepare(`SELECT COUNT(*) AS count, MIN(next_attempt_at) AS next_attempt_at
      FROM telegram_outbox
      WHERE attempt_id = ? AND status IN ('pending','sending')`)
    .bind(attemptId)
    .first<{ count: number; next_attempt_at: number | null }>();
  const pending = (row?.count ?? 0) > 0;
  if (!pending) return { pending: false, nextAttemptAt: null };
  const group = await database()
    .prepare(`SELECT
      COALESCE(MAX(CASE WHEN status = 'sending' AND lease_until > ? THEN lease_until END), 0) AS lease_until,
      COALESCE(MAX(sent_at), 0) AS last_sent_at
      FROM telegram_outbox`)
    .bind(now)
    .first<{ lease_until: number; last_sent_at: number }>();
  const groupReadyAt = Math.max(
    (group?.last_sent_at ?? 0) + TELEGRAM_GROUP_MIN_INTERVAL_MS,
    group?.lease_until ?? 0,
  );
  return {
    pending: true,
    nextAttemptAt: Math.max(row?.next_attempt_at ?? now, groupReadyAt),
  };
}

async function cleanupPrivateData(now: number) {
  const cutoff = now - TELEGRAM_MAX_AGE_MS;
  const db = database();
  await db.batch([
    db
      .prepare(`UPDATE telegram_outbox SET status = 'dead', last_error_code = 'retry_exhausted',
        payload_text = '', lease_token = NULL, lease_until = NULL
        WHERE status IN ('pending','sending')
          AND (attempt_count >= ? OR created_at < ?)`)
      .bind(TELEGRAM_MAX_ATTEMPTS, cutoff),
    db
      .prepare("UPDATE telegram_outbox SET payload_text = '' WHERE created_at < ? AND payload_text != ''")
      .bind(cutoff),
    db
      .prepare(`UPDATE attempts SET candidate_name = NULL
        WHERE candidate_name IS NOT NULL AND (
          started_at < ? OR (status IN ('completed','aborted') AND NOT EXISTS (
            SELECT 1 FROM telegram_outbox
            WHERE telegram_outbox.attempt_id = attempts.id
              AND telegram_outbox.status IN ('pending','sending')
          ))
        )`)
      .bind(cutoff),
  ]);
}

async function cleanupCompletedAttempt(attemptId: string) {
  await database()
    .prepare(`UPDATE attempts SET candidate_name = NULL
      WHERE id = ? AND status IN ('completed','aborted') AND NOT EXISTS (
        SELECT 1 FROM telegram_outbox
        WHERE attempt_id = ? AND status IN ('pending','sending')
      )`)
    .bind(attemptId, attemptId)
    .run();
}

async function disablePendingNotifications(now: number) {
  await database()
    .prepare(`UPDATE telegram_outbox SET status = 'dead', payload_text = '',
      last_error_code = 'telegram_disabled', lease_token = NULL, lease_until = NULL
      WHERE status IN ('pending','sending')`)
    .run();
  await cleanupPrivateData(now);
}

async function nextDueAttemptId(now: number) {
  const row = await database()
    .prepare(OUTBOX_MAINTENANCE_NEXT_ATTEMPT_SQL)
    .bind(...outboxMaintenanceBindings(now))
    .first<{ attempt_id: string }>();
  return row?.attempt_id ?? null;
}

export async function flushAttemptNotifications(attemptId: string) {
  const now = Date.now();
  await cleanupPrivateData(now);
  const config = telegramRuntimeConfig();
  if (!config.enabled) {
    await disablePendingNotifications(now);
    return { delivered: false, pending: false, nextAttemptAt: null };
  }
  if (!config.configured) {
    const state = await pendingState(attemptId, now);
    return {
      delivered: false,
      pending: state.pending,
      nextAttemptAt: state.pending ? Math.max(state.nextAttemptAt ?? now, now + 5_000) : null,
    };
  }

  const claim = await claimNext(attemptId, now);
  if (!claim) {
    await cleanupCompletedAttempt(attemptId);
    return { delivered: false, ...(await pendingState(attemptId, now)) };
  }

  const fingerprint = await configFingerprint(config.botToken, config.chatId);
  const attemptDelivery = await database()
    .prepare('SELECT telegram_root_message_id FROM attempts WHERE id = ?')
    .bind(claim.row.attempt_id)
    .first<{ telegram_root_message_id: number | null }>();
  const rootMessageId = attemptDelivery?.telegram_root_message_id ?? null;
  if (claim.row.delivery_method !== 'send' && rootMessageId === null) {
    await database()
      .prepare(`UPDATE telegram_outbox SET status = 'dead', payload_text = '',
        last_error_code = 'telegram_root_missing', lease_token = NULL, lease_until = NULL
        WHERE id = ? AND lease_token = ?`)
      .bind(claim.row.id, claim.leaseToken)
      .run();
    await cleanupCompletedAttempt(attemptId);
    return { delivered: false, ...(await pendingState(attemptId)) };
  }
  const result = await sendTelegramMessage(
    { botToken: config.botToken, chatId: config.chatId },
    {
      text: claim.row.payload_text,
      deliveryMethod: claim.row.delivery_method,
      parseMode: claim.row.parse_mode === 'HTML' ? 'HTML' : undefined,
      silent: claim.row.silent === 1,
      rootMessageId,
    },
  );

  if (result.ok) {
    const db = database();
    const statements: D1PreparedStatement[] = [
      db.prepare(`UPDATE telegram_outbox SET status = 'sent', payload_text = '',
        telegram_message_id = ?, last_error_code = NULL, sent_at = ?,
        lease_token = NULL, lease_until = NULL
        WHERE id = ? AND lease_token = ?`)
        .bind(result.messageId, Date.now(), claim.row.id, claim.leaseToken),
    ];
    if (claim.row.event_type === 'started') {
      statements.push(
        db.prepare('UPDATE attempts SET telegram_root_message_id = ? WHERE id = ?')
          .bind(result.messageId, claim.row.attempt_id),
      );
    }
    await db.batch(statements);
    await recordDeliveryState(fingerprint, 'ready', null);
  } else if (result.retryable && claim.row.attempt_count < TELEGRAM_MAX_ATTEMPTS) {
    const nextAttemptAt = Date.now() + (result.retryAfterMs ?? retryDelay(claim.row.attempt_count));
    await database()
      .prepare(`UPDATE telegram_outbox SET status = 'pending', next_attempt_at = ?,
        last_error_code = ?, lease_token = NULL, lease_until = NULL
        WHERE id = ? AND lease_token = ?`)
      .bind(nextAttemptAt, result.code, claim.row.id, claim.leaseToken)
      .run();
    await recordDeliveryState(fingerprint, 'degraded', result.code);
  } else {
    await database()
      .prepare(`UPDATE telegram_outbox SET status = 'dead', payload_text = '', last_error_code = ?,
        lease_token = NULL, lease_until = NULL
        WHERE id = ? AND lease_token = ?`)
      .bind(result.code, claim.row.id, claim.leaseToken)
      .run();
    await recordDeliveryState(
      fingerprint,
      result.retryable ? 'degraded' : 'misconfigured',
      result.code,
    );
  }

  await cleanupCompletedAttempt(attemptId);
  return { delivered: result.ok, ...(await pendingState(attemptId)) };
}

export async function maintainTelegramOutbox() {
  const now = Date.now();
  await cleanupPrivateData(now);
  const config = telegramRuntimeConfig();

  if (!config.enabled) {
    await disablePendingNotifications(now);
    return;
  }
  if (!config.configured) return;

  const attemptId = await nextDueAttemptId(now);
  if (attemptId) await flushAttemptNotifications(attemptId);
}
