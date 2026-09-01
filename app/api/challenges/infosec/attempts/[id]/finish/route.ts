import { env } from 'cloudflare:workers';
import {
  finishSecurityChallengeAttempt,
  securityChallengeAttemptPayload,
  verifySecurityChallengeAttempt,
} from '@/db/security-challenge.ts';
import { readFeatureFlags } from '@/lib/feature-flags.ts';
import { challengeBearerToken, challengeJson } from '@/lib/security-challenge-http.ts';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!readFeatureFlags(env).securityChallenge) return challengeJson({ error: 'not_found' }, { status: 404 });
  try {
    const { id } = await context.params;
    const attempt = await verifySecurityChallengeAttempt(id, challengeBearerToken(request));
    if (!attempt) return challengeJson({ error: 'Попытка не найдена.' }, { status: 404 });
    return challengeJson(await securityChallengeAttemptPayload(
      await finishSecurityChallengeAttempt(attempt),
    ));
  } catch {
    console.error('security_challenge_finish_failed');
    return challengeJson({ error: 'Не удалось завершить челлендж.' }, { status: 500 });
  }
}
