import { env } from 'cloudflare:workers';
import {
  SecurityChallengeConflictError,
  SecurityChallengeInvalidChoiceError,
  answerSecurityChallengeQuestion,
  securityChallengeAttemptPayload,
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
    const body = await readChallengeJson<{ questionId?: number; choiceIndex?: number | null }>(request);
    if (!Number.isInteger(body.questionId) || body.choiceIndex === undefined) {
      return challengeJson({ error: 'Некорректный ответ.' }, { status: 400 });
    }
    const attempt = await verifySecurityChallengeAttempt(id, challengeBearerToken(request));
    if (!attempt) return challengeJson({ error: 'Попытка не найдена.' }, { status: 404 });
    const updated = await answerSecurityChallengeQuestion(
      attempt,
      body.questionId as number,
      body.choiceIndex,
    );
    return challengeJson(await securityChallengeAttemptPayload(updated));
  } catch (error) {
    if (error instanceof SecurityChallengeInvalidChoiceError) {
      return challengeJson({ error: error.message }, { status: 400 });
    }
    if (error instanceof SecurityChallengeConflictError) {
      return challengeJson({ error: error.message }, { status: 409 });
    }
    if (error instanceof SyntaxError || (error instanceof Error && error.message === 'body_too_large')) {
      return challengeJson({ error: 'Некорректный запрос.' }, { status: 400 });
    }
    console.error('security_challenge_answer_failed');
    return challengeJson({ error: 'Не удалось сохранить ответ.' }, { status: 500 });
  }
}
