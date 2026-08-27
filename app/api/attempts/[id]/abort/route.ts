import { NextResponse } from 'next/server';
import { abortedTelegramMessage } from '@/lib/telegram-messages.ts';
import { shouldQueueTelegramNotifications } from '@/db/telegram-outbox';
import {
  attemptPayload,
  database,
  ensureSchema,
  findAttempt,
  verifyAttempt,
} from '@/db/runtime';
import { TEST_CONFIG } from '@/lib/test-config.ts';

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
    const db = database();
    const statements: D1PreparedStatement[] = [
      db
        .prepare(`UPDATE attempts SET status = 'aborted', current_question_id = NULL,
          pending_question_ids = '[]', verdict = NULL, completed_at = ?, duration_seconds = ?
          WHERE id = ? AND status = 'active'`)
        .bind(now, durationSeconds, attempt.id),
    ];

    if (shouldQueueTelegramNotifications()) {
      const eventId = `aborted-${attempt.id}`;
      const message = abortedTelegramMessage({
        eventId,
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
          .prepare(`INSERT OR IGNORE INTO telegram_outbox (
            id, attempt_id, question_id, event_type, payload_text, status,
            attempt_count, next_attempt_at, created_at
          ) SELECT ?, id, NULL, 'aborted', ?, 'pending', 0, ?, ?
            FROM attempts WHERE id = ? AND status = 'aborted'`)
          .bind(eventId, message, now, now, attempt.id),
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
