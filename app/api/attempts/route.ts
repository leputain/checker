import { NextResponse } from 'next/server';
import {
  attemptPayload,
  database,
  ensureDatabase,
  publicAlias,
  sha256Hex,
  type AttemptRow,
  type Difficulty,
} from '@/db/runtime';

const plan: Array<[Difficulty, number]> = [
  ['easy', 2],
  ['medium', 2],
  ['hard', 1],
  ['expert', 1],
];

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = (await request.json()) as { name?: string };
    const name = body.name?.trim().replace(/\s+/g, ' ');
    if (!name || name.length < 2 || name.length > 80) {
      return NextResponse.json(
        { error: 'Имя должно содержать от 2 до 80 символов.' },
        { status: 400 },
      );
    }

    const db = database();
    const selected: Array<{ id: number; weight: number }> = [];
    for (const [difficulty, count] of plan) {
      const result = await db
        .prepare(
          'SELECT id, weight FROM questions WHERE active = 1 AND difficulty = ? ORDER BY RANDOM() LIMIT ?',
        )
        .bind(difficulty, count)
        .all<{ id: number; weight: number }>();
      selected.push(...result.results);
    }
    if (selected.length < 6) {
      return NextResponse.json(
        { error: 'В банке недостаточно активных вопросов.' },
        { status: 503 },
      );
    }

    const id = crypto.randomUUID();
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const now = Date.now();
    const baseQuestionIds = selected.map((question) => question.id);
    const baseMaxScore = selected.reduce((sum, question) => sum + question.weight, 0);
    const [first, ...pending] = baseQuestionIds;

    await db
      .prepare(
        `INSERT INTO attempts (
          id, token_hash, public_alias, status, started_at, total_deadline_at,
          question_deadline_at, current_question_id, pending_question_ids,
          asked_question_ids, base_question_ids, base_max_score
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        await sha256Hex(token),
        publicAlias(name),
        now,
        now + 600_000,
        now + 60_000,
        first,
        JSON.stringify(pending),
        JSON.stringify([first]),
        JSON.stringify(baseQuestionIds),
        baseMaxScore,
      )
      .run();

    const attempt = await db
      .prepare('SELECT * FROM attempts WHERE id = ?')
      .bind(id)
      .first<AttemptRow>();
    return NextResponse.json(await attemptPayload(attempt!, token));
  } catch (error) {
    console.error('attempt_start_failed', error);
    return NextResponse.json({ error: 'Не удалось подготовить тест.' }, { status: 500 });
  }
}
