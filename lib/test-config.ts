export const TEST_CONFIG = {
  totalTimeSeconds: 600,
  questionTimeSeconds: 30,
  questionStatsMinSample: 5,
  plan: {
    easy: 7,
    medium: 7,
    hard: 5,
    expert: 1,
  },
  weights: {
    easy: 1,
    medium: 2,
    hard: 3,
    expert: 10,
  },
  verdict: {
    passScorePercent: 70,
    passAccuracy: 70,
    reviewScorePercent: 50,
    reviewAccuracy: 60,
  },
} as const;

export type Difficulty = keyof typeof TEST_CONFIG.plan;

export const DIFFICULTIES = Object.keys(TEST_CONFIG.plan) as Difficulty[];

export const BASE_QUESTION_COUNT = DIFFICULTIES.reduce(
  (total, difficulty) => total + TEST_CONFIG.plan[difficulty],
  0,
);
