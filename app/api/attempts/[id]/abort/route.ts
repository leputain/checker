import { NextResponse } from 'next/server';
import { abortedTelegramMessage, progressTelegramMessage } from '@/lib/telegram-messages.ts';
import { telegramNotificationPolicy } from '@/db/telegram-outbox';
import {
  attemptPayload,
  database,
  ensureSchema,
  findAttempt,
  verifyAttempt,
} from '@/db/runtime';
import { TEST_CONFIG } from '@/lib/test-config.ts';
import {
  ATTEMPT_VERSION_UNSUPPORTED_CODE,
  isUnsupportedActiveAttempt,
} from '@/lib/attempt-policy.ts';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

function bearerToken(request: Request) {
  const authorization = request.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureSchema();
    const { id } = await context.params;
    const attempt = await verifyAttempt(id, bearerToken(request));
    if (!attempt) {
      return NextResponse.json(
        { error: 'Попытка не найдена.' },
        { status: 404, headers: NO_STORE },
      );
    }
    if (isUnsupportedActiveAttempt(attempt)) {
      return NextResponse.json(
        {
          error: 'Эта активная попытка создана в устаревшей версии теста.',
          code: ATTEMPT_VERSION_UNSUPPORTED_CODE,
        },
        { status: 409, headers: NO_STORE },
      );
    }
    if (attempt.status !== 'active') {
      return NextResponse.json(await attemptPayload(attempt), { headers: NO_STORE });
    }

    const now = Date.now();
    const durationSeconds = Math.min(
      TEST_CONFIG.totalTimeSeconds,
      Math.max(0, Math.ceil((now - attempt.started_at) / 1_000)),
    );
    const answeredCount = attempt.correct_count + attempt.wrong_count;
    const minimumQuestions = (JSON.parse(attempt.base_question_ids) as number[]).length;
    const totalQuestions = new Set([
      ...(JSON.parse(attempt.asked_question_ids) as number[]),
      ...(JSON.parse(attempt.pending_question_ids) as number[]),
    ]).size;
    const db = database();
    const statements: D1PreparedStatement[] = [
      db
        .prepare(`UPDATE attempts SET status = 'aborted', current_question_id = NULL,
          pending_question_ids = '[]', verdict = NULL, completed_at = ?, duration_seconds = ?
          WHERE id = ? AND status = 'active'`)
        .bind(now, durationSeconds, attempt.id),
    ];

    const notificationPolicy = telegramNotificationPolicy();
    if (notificationPolicy.enabled) {
      let eventTime = now;
      if (notificationPolicy.createProgressCard) {
        const progressMessage = progressTelegramMessage({
          attemptId: attempt.id,
          candidateName: attempt.candidate_name ?? attempt.public_alias,
          state: 'aborted',
          answeredCount,
          totalQuestions: Math.max(minimumQuestions, totalQuestions),
          correctCount: attempt.correct_count,
          wrongCount: attempt.wrong_count,
          score: attempt.score,
          baseMaxScore: attempt.base_max_score,
          totalRemainingSeconds: 0,
        });
        const startedEventId = `started-${attempt.id}`;
        const progressEventId = `progress-aborted-${attempt.id}`;
        statements.push(
          db.prepare(`INSERT INTO telegram_outbox (
            id, attempt_id, question_id, event_type, payload_text, delivery_method,
            parse_mode, silent, status, attempt_count, next_attempt_at, created_at
          ) SELECT ?, id, NULL, 'started', ?, 'send', 'HTML', 1, 'pending', 0, ?, ?
            FROM attempts WHERE id = ? AND status = 'aborted'
            ON CONFLICT(id) DO NOTHING`)
            .bind(startedEventId, progressMessage, Math.max(attempt.started_at, now - 1), Math.max(attempt.started_at, now - 1), attempt.id),
          db.prepare(`UPDATE telegram_outbox SET status = 'dead', payload_text = '',
            last_error_code = 'superseded'
            WHERE attempt_id = ? AND event_type = 'progress' AND status = 'pending' AND id != ?
              AND EXISTS (SELECT 1 FROM attempts WHERE id = ? AND status = 'aborted')`)
            .bind(attempt.id, progressEventId, attempt.id),
          db.prepare(`INSERT INTO telegram_outbox (
            id, attempt_id, question_id, event_type, payload_text, delivery_method,
            parse_mode, silent, status, attempt_count, next_attempt_at, created_at
          ) SELECT ?, id, NULL, 'progress', ?, 'edit_root', 'HTML', 1, 'pending', 0, ?, ?
            FROM attempts WHERE id = ? AND status = 'aborted'
            ON CONFLICT(id) DO NOTHING`)
            .bind(progressEventId, progressMessage, now, eventTime, attempt.id),
        );
        eventTime += 1;
      }
      const eventId = `aborted-${attempt.id}`;
      const message = abortedTelegramMessage({
        attemptId: attempt.id,
        candidateName: attempt.candidate_name ?? attempt.public_alias,
        score: attempt.score,
        baseMaxScore: attempt.base_max_score,
        answeredCount,
        minimumQuestions,
        durationSeconds,
        abortedAt: now,
      });
      statements.push(
        db
          .prepare(`INSERT INTO telegram_outbox (
            id, attempt_id, question_id, event_type, payload_text, delivery_method,
            parse_mode, silent, status, attempt_count, next_attempt_at, created_at
          ) SELECT ?, id, NULL, 'aborted', ?, 'send', 'HTML', 0, 'pending', 0, ?, ?
            FROM attempts WHERE id = ? AND status = 'aborted'
            ON CONFLICT(id) DO NOTHING`)
          .bind(eventId, message, now, eventTime, attempt.id),
      );
    }

    await db.batch(statements);
    const updated = await findAttempt(attempt.id);
    if (!updated) throw new Error('Attempt disappeared after abort.');
    return NextResponse.json(await attemptPayload(updated), { headers: NO_STORE });
  } catch {
    console.error('attempt_abort_failed');
    return NextResponse.json(
      { error: 'Не удалось прервать тест.' },
      { status: 500, headers: NO_STORE },
    );
  }
}
