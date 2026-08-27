import { NextResponse } from 'next/server';
import {
  attemptPayload,
  calculateVerdict,
  choicePermutation,
  database,
  ensureDatabase,
  findAttempt,
  findQuestion,
  verifyAttempt,
} from '@/db/runtime';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await ensureDatabase();
    const { id } = await context.params;
    const body = (await request.json()) as {
      token?: string;
      questionId?: number;
      choiceIndex?: number | null;
    };
    const attempt = await verifyAttempt(id, body.token ?? '');
    if (!attempt) {
      return NextResponse.json({ error: 'Попытка не найдена.' }, { status: 404 });
    }
    if (attempt.status === 'completed') {
      return NextResponse.json(await attemptPayload(attempt));
    }

    if (attempt.current_question_id !== body.questionId) {
      const processed = await database()
        .prepare('SELECT id FROM answers WHERE attempt_id = ? AND question_id = ?')
        .bind(attempt.id, body.questionId ?? -1)
        .first<{ id: number }>();
      if (processed) {
        const current = await findAttempt(attempt.id);
        return NextResponse.json(await attemptPayload(current!));
      }
      return NextResponse.json({ error: 'Вопрос не относится к текущей попытке.' }, { status: 409 });
    }

    const question = await findQuestion(attempt.current_question_id);
    if (!question) {
      return NextResponse.json({ error: 'Вопрос недоступен.' }, { status: 409 });
    }
    const choices = JSON.parse(question.choices_json) as string[];
    const selected = body.choiceIndex ?? null;
    if (selected !== null && (!Number.isInteger(selected) || selected < 0 || selected >= choices.length)) {
      return NextResponse.json({ error: 'Некорректный вариант ответа.' }, { status: 400 });
    }

    const now = Date.now();
    const timedOut = now > attempt.question_deadline_at || now >= attempt.total_deadline_at;
    const permutation = await choicePermutation(attempt.id, question.id, choices.length);
    const originalIndex = selected === null ? null : permutation[selected];
    const correct = !timedOut && originalIndex === question.correct_index;
    const pending = JSON.parse(attempt.pending_question_ids) as number[];
    const asked = JSON.parse(attempt.asked_question_ids) as number[];
    const baseQuestionIds = JSON.parse(attempt.base_question_ids) as number[];

    if (!correct && now < attempt.total_deadline_at) {
      const excluded = [...asked, ...pending];
      const placeholders = excluded.map(() => '?').join(',');
      const sql = `SELECT id FROM questions WHERE active = 1 AND difficulty = ? ${
        excluded.length ? `AND id NOT IN (${placeholders})` : ''
      } ORDER BY RANDOM() LIMIT 1`;
      const replacement = await database()
        .prepare(sql)
        .bind(question.difficulty, ...excluded)
        .first<{ id: number }>();
      if (replacement) pending.push(replacement.id);
    }

    const nextId = now < attempt.total_deadline_at ? (pending.shift() ?? null) : null;
    const completed = nextId === null;
    const isBaseQuestion = baseQuestionIds.includes(question.id);
    const score = attempt.score + (correct && isBaseQuestion ? question.weight : 0);
    const correctCount = attempt.correct_count + (correct ? 1 : 0);
    const wrongCount = attempt.wrong_count + (correct ? 0 : 1);
    const answeredCount = correctCount + wrongCount;
    const accuracy = Math.round((correctCount / answeredCount) * 100);
    const verdict = completed
      ? calculateVerdict(score, attempt.base_max_score, accuracy)
      : null;
    if (nextId) asked.push(nextId);

    const db = database();
    const results = await db.batch([
      db
        .prepare(
          'INSERT OR IGNORE INTO answers (attempt_id, question_id, selected_index, is_correct, answered_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(attempt.id, question.id, selected, correct ? 1 : 0, now),
      db
        .prepare(
          `UPDATE attempts SET status = ?, current_question_id = ?, pending_question_ids = ?,
            asked_question_ids = ?, score = ?, correct_count = ?, wrong_count = ?,
            question_deadline_at = ?, verdict = ?, completed_at = ?, duration_seconds = ?
           WHERE id = ? AND current_question_id = ? AND status = 'active'
             AND EXISTS (SELECT 1 FROM answers WHERE attempt_id = ? AND question_id = ?)`,
        )
        .bind(
          completed ? 'completed' : 'active',
          nextId,
          JSON.stringify(pending),
          JSON.stringify(asked),
          score,
          correctCount,
          wrongCount,
          nextId ? Math.min(now + 60_000, attempt.total_deadline_at) : now,
          verdict,
          completed ? now : null,
          completed ? Math.min(600, Math.ceil((now - attempt.started_at) / 1000)) : null,
          attempt.id,
          question.id,
          attempt.id,
          question.id,
        ),
    ]);

    if ((results[1].meta.changes ?? 0) === 0) {
      const current = await findAttempt(attempt.id);
      return NextResponse.json(await attemptPayload(current!));
    }
    const updated = await findAttempt(attempt.id);
    return NextResponse.json(await attemptPayload(updated!));
  } catch (error) {
    console.error('answer_failed', error);
    return NextResponse.json({ error: 'Не удалось сохранить ответ.' }, { status: 500 });
  }
}
