import { env } from 'cloudflare:workers';
import {
  SecurityChallengeConflictError,
  securityChallengeReview,
  verifySecurityChallengeAttempt,
} from '@/db/security-challenge.ts';
import { readFeatureFlags } from '@/lib/feature-flags.ts';
import { challengeBearerToken, challengeJson } from '@/lib/security-challenge-http.ts';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!readFeatureFlags(env).securityChallenge) return challengeJson({ error: 'not_found' }, { status: 404 });
  try {
    const { id } = await context.params;
    const attempt = await verifySecurityChallengeAttempt(id, challengeBearerToken(request));
    if (!attempt) return challengeJson({ error: 'Попытка не найдена.' }, { status: 404 });
    return challengeJson({ items: await securityChallengeReview(attempt) });
  } catch (error) {
    if (error instanceof SecurityChallengeConflictError) {
      return challengeJson({ error: error.message }, { status: 409 });
    }
    console.error('security_challenge_review_failed');
    return challengeJson({ error: 'Не удалось загрузить разбор.' }, { status: 500 });
  }
}
