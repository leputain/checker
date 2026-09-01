import { env } from 'cloudflare:workers';
import {
  SecurityChallengeConflictError,
  saveSecurityChallengeFeedback,
  verifySecurityChallengeAttempt,
} from '@/db/security-challenge.ts';
import { readFeatureFlags } from '@/lib/feature-flags.ts';
import {
  challengeBearerToken,
  challengeJson,
  readChallengeJson,
} from '@/lib/security-challenge-http.ts';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!readFeatureFlags(env).securityChallenge) return challengeJson({ error: 'not_found' }, { status: 404 });
  try {
    const { id } = await context.params;
    const body = await readChallengeJson<{ eventId?: number; comment?: string }>(request);
    const comment = body.comment?.trim() ?? '';
    if (!Number.isInteger(body.eventId) || comment.length < 3 || comment.length > 1_000) {
      return challengeJson({ error: 'Комментарий должен содержать от 3 до 1000 символов.' }, { status: 400 });
    }
    const attempt = await verifySecurityChallengeAttempt(id, challengeBearerToken(request));
    if (!attempt) return challengeJson({ error: 'Попытка не найдена.' }, { status: 404 });
    return challengeJson(await saveSecurityChallengeFeedback(attempt, body.eventId as number, comment));
  } catch (error) {
    if (error instanceof SecurityChallengeConflictError) {
      return challengeJson({ error: error.message }, { status: 409 });
    }
    if (error instanceof SyntaxError || (error instanceof Error && error.message === 'body_too_large')) {
      return challengeJson({ error: 'Некорректный запрос.' }, { status: 400 });
    }
    console.error('security_challenge_feedback_failed');
    return challengeJson({ error: 'Не удалось отправить комментарий.' }, { status: 500 });
  }
}
