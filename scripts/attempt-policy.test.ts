import assert from 'node:assert/strict';
import {
  ATTEMPT_VERSION_UNSUPPORTED_CODE,
  classifyQuestion,
  countAdditionalQuestions,
  isUnsupportedActiveAttempt,
  shouldCreateAdditionalQuestion,
} from '../lib/attempt-policy.ts';
import { BASE_MAX_SCORE } from '../lib/scoring.ts';
import {
  LEGACY_SELECTION_VERSION,
  LEGACY_SCORING_VERSION,
  LEGACY_V2_TEST_CONFIG_ID,
  LEGACY_V2_BALANCED_TEST_CONFIG_ID,
  BALANCED_TEST_CONFIG_ID,
  BALANCED_TEST_PROFILE_ID,
  BALANCED_TEST_SELECTION_VERSION,
  SCORING_VERSION,
  TEST_CONFIG,
  TEST_CONFIG_ID,
  TEST_PROFILE_ID,
} from '../lib/test-config.ts';

const baseQuestionIds = new Set(Array.from({ length: 20 }, (_, index) => index + 1));

assert.equal(classifyQuestion(1, baseQuestionIds), 'base');
assert.equal(classifyQuestion(20, baseQuestionIds), 'base');
assert.equal(
  classifyQuestion(21, baseQuestionIds),
  'additional',
  'question kind must come from base ID membership rather than queue position',
);

assert.equal(
  countAdditionalQuestions(baseQuestionIds, [1, 2, 21, 21], [3, 22, 22]),
  2,
  'asked and pending additional questions must be counted once by ID',
);

const eligible = {
  questionKind: 'base' as const,
  correct: false,
  totalExpired: false,
  additionalQuestionCount: 0,
};
assert.equal(shouldCreateAdditionalQuestion(eligible), true);
assert.equal(shouldCreateAdditionalQuestion({ ...eligible, correct: true }), false);
assert.equal(
  shouldCreateAdditionalQuestion({ ...eligible, questionKind: 'additional' }),
  false,
  'an incorrect additional question must not create a remedial chain',
);
assert.equal(shouldCreateAdditionalQuestion({ ...eligible, totalExpired: true }), false);
assert.equal(
  shouldCreateAdditionalQuestion({
    ...eligible,
    additionalQuestionCount: TEST_CONFIG.maxAdditionalQuestions - 1,
  }),
  true,
);
assert.equal(
  shouldCreateAdditionalQuestion({
    ...eligible,
    additionalQuestionCount: TEST_CONFIG.maxAdditionalQuestions,
  }),
  false,
  'no more than ten additional questions may be scheduled',
);

assert.equal(isUnsupportedActiveAttempt({ status: 'active', base_max_score: 50 }), true);
assert.equal(
  isUnsupportedActiveAttempt({ status: 'completed', base_max_score: 50 }),
  false,
  'completed legacy attempts remain readable without recalculation',
);
assert.equal(
  isUnsupportedActiveAttempt({
    status: 'active',
    base_max_score: BASE_MAX_SCORE,
    scoring_version: SCORING_VERSION,
    test_config_id: TEST_CONFIG_ID,
    test_profile_id: TEST_PROFILE_ID,
    selection_version: LEGACY_SELECTION_VERSION,
  }),
  false,
);
assert.equal(
  isUnsupportedActiveAttempt({
    status: 'active',
    base_max_score: BASE_MAX_SCORE,
    scoring_version: 0,
    test_config_id: 'legacy-unknown',
    test_profile_id: 'legacy-unknown',
    selection_version: 0,
  }),
  true,
  'an active row without persisted model identity must not be resumed',
);
assert.equal(ATTEMPT_VERSION_UNSUPPORTED_CODE, 'attempt_version_unsupported');

for (const scoringVersion of [LEGACY_SCORING_VERSION, SCORING_VERSION]) {
  for (const balanced of [false, true]) {
    const configId = scoringVersion === LEGACY_SCORING_VERSION
      ? (balanced ? LEGACY_V2_BALANCED_TEST_CONFIG_ID : LEGACY_V2_TEST_CONFIG_ID)
      : (balanced ? BALANCED_TEST_CONFIG_ID : TEST_CONFIG_ID);
    const attempt = {
      status: 'active', base_max_score: BASE_MAX_SCORE,
      scoring_version: scoringVersion, test_config_id: configId,
      test_profile_id: balanced ? BALANCED_TEST_PROFILE_ID : TEST_PROFILE_ID,
      selection_version: balanced ? BALANCED_TEST_SELECTION_VERSION : LEGACY_SELECTION_VERSION,
    };
    assert.equal(isUnsupportedActiveAttempt(attempt), false, 'active v2 and v3 preserve their own semantics');
    assert.equal(isUnsupportedActiveAttempt({ ...attempt, scoring_version: 99 }), true);
    assert.equal(isUnsupportedActiveAttempt({
      ...attempt,
      scoring_version: scoringVersion === SCORING_VERSION ? LEGACY_SCORING_VERSION : SCORING_VERSION,
    }), true, 'a config hash cannot be reused across scoring versions');
    assert.equal(isUnsupportedActiveAttempt({ ...attempt, test_profile_id: 'unknown' }), true);
  }
}

console.log('attempt policy tests: PASS');
