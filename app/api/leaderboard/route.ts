import { NextResponse } from 'next/server';
import { calculateVerdict, database, ensureDatabase, type Verdict } from '@/db/runtime';

export async function GET() {
  try {
    await ensureDatabase();
    const rows = await database()
      .prepare(
        `SELECT public_alias, verdict, score, base_max_score, correct_count, wrong_count,
          duration_seconds, completed_at
         FROM attempts
         WHERE status = 'completed'
         ORDER BY score DESC, wrong_count ASC, duration_seconds ASC, completed_at ASC
         LIMIT 20`,
      )
      .all<{
        public_alias: string;
        verdict: Verdict | null;
        score: number;
        base_max_score: number;
        correct_count: number;
        wrong_count: number;
        duration_seconds: number;
        completed_at: number;
      }>();

    return NextResponse.json({
      entries: rows.results.map((row) => {
        const answeredCount = row.correct_count + row.wrong_count;
        const accuracy = Math.round((row.correct_count / Math.max(1, answeredCount)) * 100);
        return {
          alias: row.public_alias,
          verdict: row.verdict ?? calculateVerdict(row.score, row.base_max_score, accuracy),
          score: row.score,
          baseMaxScore: row.base_max_score,
          accuracy,
          wrongCount: row.wrong_count,
          durationSeconds: row.duration_seconds,
          completedAt: new Date(row.completed_at).toISOString(),
        };
      }),
    });
  } catch (error) {
    console.error('leaderboard_failed', error);
    return NextResponse.json({ error: 'Не удалось загрузить рейтинг.' }, { status: 500 });
  }
}
