import { NextResponse } from 'next/server';
import { env } from 'cloudflare:workers';
import { database, ensureQuestionBankReady, type Verdict } from '@/db/runtime';
import { BASE_MAX_SCORE, calculateAccuracy, calculateVerdict } from '@/lib/scoring.ts';
import {
  BALANCED_TEST_CONFIG_ID,
  BALANCED_TEST_PROFILE_ID,
  SCORING_VERSION,
  TEST_CONFIG_ID,
  TEST_PROFILE_ID,
} from '@/lib/test-config.ts';
import { readFeatureFlags } from '@/lib/feature-flags.ts';
import {
  LEADERBOARD_ATTEMPTS_SQL,
  moscowDayBounds,
  selectBestLeaderboardEntries,
  type LeaderboardPeriod,
} from '@/lib/leaderboard.ts';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET(request: Request) {
  try {
    const bankRevision = await ensureQuestionBankReady();
    const searchParams = new URL(request.url).searchParams;
    const requestedPeriod = searchParams.get('period');
    if (requestedPeriod !== null && requestedPeriod !== 'today' && requestedPeriod !== 'all') {
      return NextResponse.json(
        { error: 'Некорректный период рейтинга.' },
        { status: 400, headers: NO_STORE },
      );
    }
    const period: LeaderboardPeriod = requestedPeriod ?? 'all';
    const defaultProfile = readFeatureFlags(env).balancedSelection
      ? BALANCED_TEST_PROFILE_ID
      : TEST_PROFILE_ID;
    const requestedProfile = searchParams.get('profile') ?? defaultProfile;
    if (requestedProfile !== TEST_PROFILE_ID && requestedProfile !== BALANCED_TEST_PROFILE_ID) {
      return NextResponse.json(
        { error: 'Некорректный профиль рейтинга.' },
        { status: 400, headers: NO_STORE },
      );
    }
    const testConfigId = requestedProfile === BALANCED_TEST_PROFILE_ID
      ? BALANCED_TEST_CONFIG_ID
      : TEST_CONFIG_ID;
    const today = period === 'today' ? moscowDayBounds() : null;
    const statement = database().prepare(LEADERBOARD_ATTEMPTS_SQL);
    const rows = await statement
      .bind(
        BASE_MAX_SCORE,
        SCORING_VERSION,
        testConfigId,
        requestedProfile,
        bankRevision,
        today?.startMs ?? null,
        today?.startMs ?? 0,
        today?.endMs ?? 0,
      )
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
          verdict: row.verdict ?? calculateVerdict(row.score, accuracy),
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
      cohort: {
        scoringVersion: SCORING_VERSION,
        testConfigId,
        testProfileId: requestedProfile,
        bankRevision,
      },
    }, { headers: NO_STORE });
  } catch (error) {
    console.error('leaderboard_failed', error);
    return NextResponse.json(
      { error: 'Не удалось загрузить рейтинг.' },
      { status: 500, headers: NO_STORE },
    );
  }
}
