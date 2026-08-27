import { NextResponse } from 'next/server';
import { database, ensureSchema, type Verdict } from '@/db/runtime';
import { calculateAccuracy, calculateVerdict } from '@/lib/scoring.ts';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET() {
  try {
    await ensureSchema();
    const rows = await database()
      .prepare(
        `SELECT public_alias, verdict, score, base_max_score, correct_count, wrong_count,
          duration_seconds, completed_at
         FROM attempts
         WHERE status = 'completed'
         ORDER BY CASE verdict
           WHEN 'PASS' THEN 0
           WHEN 'REVIEW' THEN 1
           ELSE 2
         END ASC, score DESC, wrong_count ASC, duration_seconds ASC, completed_at ASC
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
        const accuracy = calculateAccuracy(row.correct_count, row.wrong_count);
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
    }, { headers: NO_STORE });
  } catch (error) {
    console.error('leaderboard_failed', error);
    return NextResponse.json(
      { error: 'Не удалось загрузить рейтинг.' },
      { status: 500, headers: NO_STORE },
    );
  }
}
