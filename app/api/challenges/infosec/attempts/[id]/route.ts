import { env } from 'cloudflare:workers';
import {
  securityChallengeAttemptPayload,
  settleSecurityChallengeAttempt,
  verifySecurityChallengeAttempt,
} from '@/db/security-challenge.ts';
import { readFeatureFlags } from '@/lib/feature-flags.ts';
import {
  CHALLENGE_ATTEMPT_ID_PATTERN,
  challengeBearerToken,
  challengeJson,
} from '@/lib/security-challenge-http.ts';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!readFeatureFlags(env).securityChallenge) return challengeJson({ error: 'not_found' }, { status: 404 });
  try {
    const { id } = await context.params;
    if (!CHALLENGE_ATTEMPT_ID_PATTERN.test(id)) return challengeJson({ error: 'not_found' }, { status: 404 });
    const attempt = await verifySecurityChallengeAttempt(id, challengeBearerToken(request));
    if (!attempt) return challengeJson({ error: 'Попытка не найдена.' }, { status: 404 });
    return challengeJson(await securityChallengeAttemptPayload(
      await settleSecurityChallengeAttempt(attempt),
    ));
  } catch {
    console.error('security_challenge_restore_failed');
    return challengeJson({ error: 'Не удалось восстановить челлендж.' }, { status: 500 });
  }
}
