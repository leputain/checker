import { NextResponse } from 'next/server';
import { telegramNotificationPolicy, telegramReadiness } from '@/db/telegram-outbox';
import {
  attemptPayload,
  database,
  ensureQuestionBankReady,
  ensureSchema,
  findAttemptByStartKey,
  publicAlias,
  sha256Hex,
} from '@/db/runtime';
import { selectUniqueQuestionPlan } from '@/lib/question-selection.ts';
import { progressTelegramMessage } from '@/lib/telegram-messages.ts';
import { candidateKey } from '@/lib/candidate-key.ts';
import { BASE_QUESTION_COUNT, DIFFICULTIES, TEST_CONFIG } from '@/lib/test-config.ts';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };
const START_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export async function POST(request: Request) {
  try {
    await ensureSchema();
    const body = (await request.json()) as { name?: string; startKey?: string; token?: string };
    const startKey = body.startKey?.trim() ?? '';
    const token = body.token?.trim() ?? '';
    if (!START_KEY_PATTERN.test(startKey) || !TOKEN_PATTERN.test(token)) {
      return NextResponse.json(
        { error: 'Некорректные параметры запуска.' },
        { status: 400, headers: NO_STORE },
      );
    }

    const tokenHash = await sha256Hex(token);
    const existing = await findAttemptByStartKey(startKey);
    if (existing) {
      if (existing.token_hash !== tokenHash) {
        return NextResponse.json(
          { error: 'Конфликт параметров запуска.' },
          { status: 409, headers: NO_STORE },
        );
      }
      return NextResponse.json(await attemptPayload(existing), { headers: NO_STORE });
    }

    const name = body.name?.trim().replace(/\s+/g, ' ');
    if (!name || name.length < 2 || name.length > 80) {
      return NextResponse.json(
        { error: body.name === undefined ? 'Попытка запуска не найдена.' : 'Имя должно содержать от 2 до 80 символов.' },
        { status: body.name === undefined ? 404 : 400, headers: NO_STORE },
      );
    }

    const telegram = await telegramReadiness();
    if (!telegram.ready) {
      return NextResponse.json(
        { error: 'Сервис уведомлений не настроен. Обратитесь к администратору.' },
        { status: 503, headers: NO_STORE },
      );
    }

    const bankRevision = await ensureQuestionBankReady();
    const db = database();
    const candidates: Array<{
      id: number;
      weight: number;
      dedupe_key: string;
      difficulty: typeof DIFFICULTIES[number];
    }> = [];
    for (const difficulty of DIFFICULTIES) {
      const result = await db
        .prepare(
          `SELECT id, weight, dedupe_key FROM questions
           WHERE active = 1 AND difficulty = ? ORDER BY RANDOM()`,
        )
        .bind(difficulty)
        .all<{ id: number; weight: number; dedupe_key: string }>();
      for (const question of result.results) {
        candidates.push({ ...question, difficulty });
      }
    }
    const selected = selectUniqueQuestionPlan(candidates, TEST_CONFIG.plan, 1);
    if (!selected || selected.length < BASE_QUESTION_COUNT) {
      return NextResponse.json(
        { error: 'В банке недостаточно активных вопросов.' },
        { status: 503, headers: NO_STORE },
      );
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const identityKey = await candidateKey(name);
    const baseQuestionIds = selected.map((question) => question.id);
    const baseMaxScore = selected.reduce((sum, question) => sum + question.weight, 0);
    const [first, ...pending] = baseQuestionIds;
    const insertStatement = db
      .prepare(
        `INSERT INTO attempts (
          id, token_hash, start_key, candidate_name, candidate_key, public_alias, bank_revision,
          status, started_at, total_deadline_at, current_question_started_at, question_deadline_at,
          current_question_id, pending_question_ids, asked_question_ids,
          base_question_ids, base_max_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(start_key) DO NOTHING`,
      )
      .bind(
        id,
        tokenHash,
        startKey,
        name,
        identityKey,
        publicAlias(name),
        bankRevision,
        now,
        now + TEST_CONFIG.totalTimeSeconds * 1_000,
        now,
        now + TEST_CONFIG.questionTimeSeconds * 1_000,
        first,
        JSON.stringify(pending),
        JSON.stringify([first]),
        JSON.stringify(baseQuestionIds),
        baseMaxScore,
      );
    const statements: D1PreparedStatement[] = [insertStatement];
    const notificationPolicy = telegramNotificationPolicy();
    if (notificationPolicy.enabled && notificationPolicy.createProgressCard) {
      const eventId = `started-${id}`;
      const message = progressTelegramMessage({
        attemptId: id,
        candidateName: name,
        state: 'started',
        answeredCount: 0,
        totalQuestions: baseQuestionIds.length,
        correctCount: 0,
        wrongCount: 0,
        score: 0,
        baseMaxScore,
        totalRemainingSeconds: TEST_CONFIG.totalTimeSeconds,
      });
      statements.push(
        db.prepare(`INSERT INTO telegram_outbox (
          id, attempt_id, question_id, event_type, payload_text, delivery_method,
          parse_mode, silent, status, attempt_count, next_attempt_at, created_at
        ) SELECT ?, id, NULL, 'started', ?, 'send', 'HTML', 1, 'pending', 0, ?, ?
          FROM attempts WHERE id = ? AND status = 'active'
          ON CONFLICT(id) DO NOTHING`)
          .bind(eventId, message, now, now, id),
      );
    }
    const results = await db.batch(statements);
    const insert = results[0];

    const attempt = await findAttemptByStartKey(startKey);
    if (!attempt || attempt.token_hash !== tokenHash) {
      return NextResponse.json(
        { error: 'Конфликт параметров запуска.' },
        { status: 409, headers: NO_STORE },
      );
    }
    return NextResponse.json(await attemptPayload(attempt), {
      status: (insert.meta.changes ?? 0) > 0 ? 201 : 200,
      headers: NO_STORE,
    });
  } catch {
    console.error('attempt_start_failed');
    return NextResponse.json(
      { error: 'Не удалось подготовить тест.' },
      { status: 500, headers: NO_STORE },
    );
  }
}
