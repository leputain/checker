import { env } from 'cloudflare:workers';
import {
  SecurityChallengeConflictError,
  SecurityChallengePoolError,
  challengeNormalizedNicknameForStorage,
  createSecurityChallengeAttempt,
  securityChallengeAttemptPayload,
} from '@/db/security-challenge.ts';
import { readFeatureFlags } from '@/lib/feature-flags.ts';
import { validateChallengeNickname } from '@/lib/security-challenge-config.ts';
import {
  CHALLENGE_START_KEY_PATTERN,
  CHALLENGE_TOKEN_PATTERN,
  challengeJson,
  readChallengeJson,
} from '@/lib/security-challenge-http.ts';

export async function POST(request: Request) {
  if (!readFeatureFlags(env).securityChallenge) return challengeJson({ error: 'not_found' }, { status: 404 });
  try {
    const body = await readChallengeJson<{ nickname?: string; startKey?: string; token?: string }>(request);
    const startKey = body.startKey?.trim() ?? '';
    const token = body.token?.trim() ?? '';
    const nickname = typeof body.nickname === 'string'
      ? validateChallengeNickname(body.nickname)
      : null;
    if (!nickname || !CHALLENGE_START_KEY_PATTERN.test(startKey) || !CHALLENGE_TOKEN_PATTERN.test(token)) {
      return challengeJson({ error: 'Некорректные параметры запуска.' }, { status: 400 });
    }
    const attempt = await createSecurityChallengeAttempt({
      nickname,
      normalizedNickname: challengeNormalizedNicknameForStorage(nickname),
      startKey,
      token,
    });
    return challengeJson(await securityChallengeAttemptPayload(attempt), { status: 201 });
  } catch (error) {
    if (error instanceof SecurityChallengeConflictError) {
      return challengeJson({ error: error.message }, { status: 409 });
    }
    if (error instanceof SecurityChallengePoolError) {
      return challengeJson({ error: error.message }, { status: 503 });
    }
    if (error instanceof SyntaxError || (error instanceof Error && error.message === 'body_too_large')) {
      return challengeJson({ error: 'Некорректный запрос.' }, { status: 400 });
    }
    console.error('security_challenge_start_failed');
    return challengeJson({ error: 'Не удалось запустить челлендж.' }, { status: 500 });
  }
}
