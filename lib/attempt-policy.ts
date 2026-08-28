import { BASE_MAX_SCORE, type QuestionKind } from './scoring.ts';
import {
  BALANCED_TEST_CONFIG_ID,
  BALANCED_TEST_PROFILE_ID,
  BALANCED_TEST_SELECTION_VERSION,
  SCORING_VERSION,
  TEST_CONFIG,
  TEST_CONFIG_ID,
  TEST_PROFILE_ID,
} from './test-config.ts';

export const ATTEMPT_VERSION_UNSUPPORTED_CODE = 'attempt_version_unsupported';

export function classifyQuestion(
  questionId: number,
  baseQuestionIds: ReadonlySet<number>,
): QuestionKind {
  return baseQuestionIds.has(questionId) ? 'base' : 'additional';
}

export function countAdditionalQuestions(
  baseQuestionIds: ReadonlySet<number>,
  askedQuestionIds: readonly number[],
  pendingQuestionIds: readonly number[],
) {
  return new Set(
    [...askedQuestionIds, ...pendingQuestionIds]
      .filter((questionId) => !baseQuestionIds.has(questionId)),
  ).size;
}

export function shouldCreateAdditionalQuestion(input: {
  questionKind: QuestionKind;
  correct: boolean;
  totalExpired: boolean;
  additionalQuestionCount: number;
}) {
  return input.questionKind === 'base'
    && !input.correct
    && !input.totalExpired
    && input.additionalQuestionCount < TEST_CONFIG.maxAdditionalQuestions;
}

export function isUnsupportedActiveAttempt(attempt: {
  status: string;
  base_max_score: number;
  scoring_version?: number;
  test_config_id?: string;
  test_profile_id?: string;
  selection_version?: number;
}) {
  if (attempt.status !== 'active') return false;
  const supportedProfile = (
    attempt.selection_version === 1 && attempt.test_profile_id === TEST_PROFILE_ID
  ) || (
    attempt.selection_version === BALANCED_TEST_SELECTION_VERSION
    && attempt.test_profile_id === BALANCED_TEST_PROFILE_ID
  );
  const expectedConfigId = attempt.selection_version === BALANCED_TEST_SELECTION_VERSION
    ? BALANCED_TEST_CONFIG_ID
    : TEST_CONFIG_ID;
  return attempt.base_max_score !== BASE_MAX_SCORE
    || attempt.scoring_version !== SCORING_VERSION
    || attempt.test_config_id !== expectedConfigId
    || !supportedProfile;
}
