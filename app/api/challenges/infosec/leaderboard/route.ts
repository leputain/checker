import { env } from 'cloudflare:workers';
import { securityChallengeLeaderboard } from '@/db/security-challenge.ts';
import { readFeatureFlags } from '@/lib/feature-flags.ts';
import { challengeJson } from '@/lib/security-challenge-http.ts';

export async function GET(request: Request) {
  if (!readFeatureFlags(env).securityChallenge) return challengeJson({ error: 'not_found' }, { status: 404 });
  try {
    const requested = new URL(request.url).searchParams.get('period') ?? 'all';
    if (requested !== 'all' && requested !== 'today') {
      return challengeJson({ error: 'Некорректный период.' }, { status: 400 });
    }
    return challengeJson(await securityChallengeLeaderboard(requested));
  } catch {
    console.error('security_challenge_leaderboard_failed');
    return challengeJson({ error: 'Не удалось загрузить рейтинг.' }, { status: 500 });
  }
}
