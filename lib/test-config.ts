export const TEST_CONFIG = {
  totalTimeSeconds: 600,
  questionTimeSeconds: 30,
  questionStatsMinSample: 5,
  plan: {
    easy: 5,
    medium: 7,
    hard: 7,
    expert: 1,
  },
  weights: {
    easy: 1,
    medium: 2,
    hard: 3,
    expert: 10,
  },
  baseQuestionMultiplier: 2,
  additionalQuestionMultiplier: 1,
  maxAdditionalQuestions: 10,
  verdict: {
    passScore: 80,
    passAccuracy: 70,
    reviewScore: 50,
  },
} as const;

/**
 * Persisted scoring/model identity. These values are part of the analytics
 * contract and must be bumped instead of being silently re-used when the
 * corresponding semantics change.
 */
export const SCORING_VERSION = 2;
export const ANALYTICS_FACTS_VERSION = 1;
export const TEST_PROFILE_ID = 'general-v1';
export const REMEDIAL_POLICY_VERSION = 2;
export const LEGACY_SELECTION_VERSION = 1;
export const LEGACY_SELECTION_STRATEGY = 'random-difficulty-quota-v1';
export const BALANCED_TEST_PROFILE_ID = 'general-balanced-v2';
export const BALANCED_TEST_SELECTION_VERSION = 2;
export const BALANCED_TEST_SELECTION_STRATEGY = 'coverage-weighted-v2';
export const GENERAL_TOPIC_PLAN = {
  'Сети': 5,
  'Linux': 5,
  'Windows и AD': 5,
  'Информационная безопасность': 5,
} as const;

const REMEDIAL_POLICY_SNAPSHOT = {
  version: REMEDIAL_POLICY_VERSION,
  sourceQuestionKind: 'base',
  maxAdditionalQuestions: TEST_CONFIG.maxAdditionalQuestions,
  allowChains: false,
  queuePlacement: 'after-base',
  difficultyPolicy: 'same',
  topicPolicy: 'prefer-same',
  uniqueness: ['question-id', 'dedupe-key'],
} as const;

export const TEST_CONFIG_SNAPSHOT = {
  scoringVersion: SCORING_VERSION,
  testProfileId: TEST_PROFILE_ID,
  remedialPolicy: REMEDIAL_POLICY_SNAPSHOT,
  selectionPolicy: {
    version: LEGACY_SELECTION_VERSION,
    strategy: LEGACY_SELECTION_STRATEGY,
    reservePerDifficulty: 1,
  },
  totalTimeSeconds: TEST_CONFIG.totalTimeSeconds,
  questionTimeSeconds: TEST_CONFIG.questionTimeSeconds,
  plan: TEST_CONFIG.plan,
  weights: TEST_CONFIG.weights,
  baseQuestionMultiplier: TEST_CONFIG.baseQuestionMultiplier,
  additionalQuestionMultiplier: TEST_CONFIG.additionalQuestionMultiplier,
  maxAdditionalQuestions: TEST_CONFIG.maxAdditionalQuestions,
  verdict: TEST_CONFIG.verdict,
} as const;

/** Canonical JSON is deliberately ordered and covered by a fixed SHA-256 id. */
export const TEST_CONFIG_JSON = JSON.stringify(TEST_CONFIG_SNAPSHOT);
export const TEST_CONFIG_ID = '8c50cc5d8d7b8b0c738b1357d0acbfef0242e3600a2fe140aa2b2b8d375c76da';

export const BALANCED_TEST_CONFIG_SNAPSHOT = {
  ...TEST_CONFIG_SNAPSHOT,
  testProfileId: BALANCED_TEST_PROFILE_ID,
  selectionPolicy: {
    version: BALANCED_TEST_SELECTION_VERSION,
    strategy: BALANCED_TEST_SELECTION_STRATEGY,
    reservePerDifficulty: 1,
    iterations: 200,
    topicPlan: GENERAL_TOPIC_PLAN,
    coverageWeights: { topicFit: 50, frequency: 35, recency: 15 },
    recencyWindowDays: 30,
  },
} as const;
export const BALANCED_TEST_CONFIG_JSON = JSON.stringify(BALANCED_TEST_CONFIG_SNAPSHOT);
export const BALANCED_TEST_CONFIG_ID = '073e57b6087c34e14c697d4f22d4fb4add5f82525e8799e3c58e7a9c99b8fd63';

export type Difficulty = keyof typeof TEST_CONFIG.plan;

export const DIFFICULTIES = Object.keys(TEST_CONFIG.plan) as Difficulty[];

export const BASE_QUESTION_COUNT = DIFFICULTIES.reduce(
  (total, difficulty) => total + TEST_CONFIG.plan[difficulty],
  0,
);
