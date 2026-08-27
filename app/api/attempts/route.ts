import { NextResponse } from 'next/server';
import { telegramReadiness } from '@/db/telegram-outbox';
import {
  attemptPayload,
  database,
  ensureQuestionBankReady,
  ensureSchema,
  findAttemptByStartKey,
  publicAlias,
  sha256Hex,
} from '@/db/runtime';
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
    const selected: Array<{ id: number; weight: number }> = [];
    for (const difficulty of DIFFICULTIES) {
      const result = await db
        .prepare(
          'SELECT id, weight FROM questions WHERE active = 1 AND difficulty = ? ORDER BY RANDOM() LIMIT ?',
        )
        .bind(difficulty, TEST_CONFIG.plan[difficulty])
        .all<{ id: number; weight: number }>();
      selected.push(...result.results);
    }
    if (selected.length < BASE_QUESTION_COUNT) {
      return NextResponse.json(
        { error: 'В банке недостаточно активных вопросов.' },
        { status: 503, headers: NO_STORE },
      );
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const baseQuestionIds = selected.map((question) => question.id);
    const baseMaxScore = selected.reduce((sum, question) => sum + question.weight, 0);
    const [first, ...pending] = baseQuestionIds;
    const insert = await db
      .prepare(
        `INSERT INTO attempts (
          id, token_hash, start_key, candidate_name, public_alias, bank_revision,
          status, started_at, total_deadline_at, current_question_started_at, question_deadline_at,
          current_question_id, pending_question_ids, asked_question_ids,
          base_question_ids, base_max_score
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(start_key) DO NOTHING`,
      )
      .bind(
        id,
        tokenHash,
        startKey,
        name,
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
      )
      .run();

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
