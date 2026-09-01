import type { Difficulty } from './test-config.ts';

export const SECURITY_CHALLENGE_CONFIG = {
  totalTimeSeconds: 15 * 60,
  questionTimeSeconds: 60,
  minimumRankedQuestions: 5,
  categorySelectionKey: 'Информационная безопасность',
  difficultyBlock: [
    'easy', 'easy', 'easy',
    'medium', 'medium', 'medium',
    'hard', 'hard', 'hard',
    'expert',
  ] satisfies Difficulty[],
  weights: {
    easy: 1,
    medium: 2,
    hard: 3,
    expert: 4,
  } satisfies Record<Difficulty, number>,
  scoreScale: 100,
  correctBaseUnits: 300,
} as const;

export const SECURITY_CHALLENGE_SCORING_VERSION = 1;
export const SECURITY_CHALLENGE_CONFIG_ID = 'infosec-survival-15m-v1';
export const SECURITY_CHALLENGE_CONFIG_JSON = JSON.stringify({
  ...SECURITY_CHALLENGE_CONFIG,
  scoringVersion: SECURITY_CHALLENGE_SCORING_VERSION,
  selection: 'deterministic-shuffled-3-3-3-1-lowest-exposure-v1',
  uniqueness: ['question-id', 'dedupe-key'],
});

export type SecurityChallengeCompletionReason =
  | 'manual'
  | 'total_timeout'
  | 'pool_exhausted';

export type SecurityChallengeOutcome =
  | 'pending'
  | 'correct'
  | 'incorrect'
  | 'timeout'
  | 'manual_unanswered';

export function challengeScoreDeltaUnits(
  difficulty: Difficulty,
  choiceCount: number,
  correct: boolean,
) {
  if (!Number.isInteger(choiceCount) || choiceCount < 2 || choiceCount > 6) {
    throw new Error('challenge_choice_count_invalid');
  }
  const weightedUnits = SECURITY_CHALLENGE_CONFIG.correctBaseUnits
    * SECURITY_CHALLENGE_CONFIG.weights[difficulty];
  return correct ? weightedUnits : -(weightedUnits / (choiceCount - 1));
}

export function displayedChallengeScore(scoreUnits: number) {
  return scoreUnits / SECURITY_CHALLENGE_CONFIG.scoreScale;
}

const FORBIDDEN_NICK_CHARACTERS = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export function normalizeChallengeNickname(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function validateChallengeNickname(value: string) {
  const compatibilityNormalized = value.normalize('NFKC');
  if (FORBIDDEN_NICK_CHARACTERS.test(compatibilityNormalized)) return null;
  const nickname = normalizeChallengeNickname(compatibilityNormalized);
  const length = [...nickname].length;
  if (length < 2 || length > 32) return null;
  return nickname;
}

export function normalizedChallengeParticipantIdentity(nickname: string) {
  return normalizeChallengeNickname(nickname).toLocaleLowerCase('ru-RU');
}

export async function challengeParticipantKey(nickname: string) {
  const identity = normalizedChallengeParticipantIdentity(nickname);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`security-challenge:v1:${identity}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
