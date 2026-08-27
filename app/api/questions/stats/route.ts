import { NextResponse } from 'next/server';
import { database, ensureDatabase } from '@/db/runtime';

export async function GET() {
  try {
    await ensureDatabase();
    const rows = await database()
      .prepare(
        `SELECT q.id, q.prompt, q.topic, q.difficulty, COUNT(a.id) AS shown_count,
          COALESCE(SUM(a.is_correct), 0) AS correct_count
         FROM questions q
         LEFT JOIN answers a ON a.question_id = q.id
         WHERE q.active = 1
         GROUP BY q.id, q.prompt, q.topic, q.difficulty
         ORDER BY shown_count DESC, q.id ASC`,
      )
      .all<{
        id: number;
        prompt: string;
        topic: string;
        difficulty: string;
        shown_count: number;
        correct_count: number;
      }>();

    return NextResponse.json({
      questions: rows.results.map((row) => {
        const correctRate = row.shown_count
          ? Math.round((row.correct_count / row.shown_count) * 100)
          : 0;
        return {
          id: row.id,
          prompt: row.prompt,
          topic: row.topic,
          difficulty: row.difficulty,
          shownCount: row.shown_count,
          correctCount: row.correct_count,
          correctRate,
          wrongRate: row.shown_count ? 100 - correctRate : 0,
        };
      }),
    });
  } catch (error) {
    console.error('question_stats_failed', error);
    return NextResponse.json({ error: 'Не удалось загрузить статистику вопросов.' }, { status: 500 });
  }
}
