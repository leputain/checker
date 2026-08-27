import { NextResponse } from 'next/server';
import { database, ensureSchema, type Verdict } from '@/db/runtime';
import { calculateAccuracy, calculateVerdict } from '@/lib/scoring.ts';
import {
  moscowDayBounds,
  selectBestLeaderboardEntries,
  type LeaderboardPeriod,
} from '@/lib/leaderboard.ts';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET(request: Request) {
  try {
    await ensureSchema();
    const requestedPeriod = new URL(request.url).searchParams.get('period');
    if (requestedPeriod !== null && requestedPeriod !== 'today' && requestedPeriod !== 'all') {
      return NextResponse.json(
        { error: 'Некорректный период рейтинга.' },
        { status: 400, headers: NO_STORE },
      );
    }
    const period: LeaderboardPeriod = requestedPeriod ?? 'all';
    const today = period === 'today' ? moscowDayBounds() : null;
    const statement = database().prepare(
      `SELECT id, candidate_key, public_alias, verdict, score, base_max_score,
        correct_count, wrong_count, duration_seconds, completed_at
       FROM attempts
       WHERE status = 'completed'
         AND (? IS NULL OR (completed_at >= ? AND completed_at < ?))`,
    );
    const rows = await statement
      .bind(today?.startMs ?? null, today?.startMs ?? 0, today?.endMs ?? 0)
      .all<{
        id: string;
        candidate_key: string;
        public_alias: string;
        verdict: Verdict | null;
        score: number;
        base_max_score: number;
        correct_count: number;
        wrong_count: number;
        duration_seconds: number;
        completed_at: number;
      }>();

    const entries = rows.results.map((row) => {
        const accuracy = calculateAccuracy(row.correct_count, row.wrong_count);
        return {
          candidateKey: row.candidate_key || `legacy:${row.id}`,
          alias: row.public_alias,
          verdict: row.verdict ?? calculateVerdict(row.score, row.base_max_score, accuracy),
          score: row.score,
          baseMaxScore: row.base_max_score,
          accuracy,
          wrongCount: row.wrong_count,
          durationSeconds: row.duration_seconds,
          completedAt: new Date(row.completed_at).toISOString(),
        };
      });

    return NextResponse.json({
      entries: selectBestLeaderboardEntries(entries),
      period,
    }, { headers: NO_STORE });
  } catch (error) {
    console.error('leaderboard_failed', error);
    return NextResponse.json(
      { error: 'Не удалось загрузить рейтинг.' },
      { status: 500, headers: NO_STORE },
    );
  }
}
