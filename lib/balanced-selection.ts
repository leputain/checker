import { selectUniqueQuestionPlan, type SelectableQuestion } from './question-selection.ts';
import {
  BALANCED_TEST_PROFILE_ID,
  BALANCED_TEST_SELECTION_STRATEGY,
  BALANCED_TEST_SELECTION_VERSION,
  GENERAL_TOPIC_PLAN,
  LEGACY_SELECTION_STRATEGY,
  type Difficulty,
} from './test-config.ts';

export const BALANCED_PROFILE_ID = BALANCED_TEST_PROFILE_ID;
export const BALANCED_SELECTION_VERSION = BALANCED_TEST_SELECTION_VERSION;
export const BALANCED_SELECTION_STRATEGY = BALANCED_TEST_SELECTION_STRATEGY;
export { LEGACY_SELECTION_STRATEGY };

export { GENERAL_TOPIC_PLAN };

export type BalancedQuestion = SelectableQuestion & {
  topic: string;
};

export type QuestionExposure = {
  presentationCount: number;
  lastPresentedAt: number | null;
};

export type SelectionResult<T> = {
  questions: T[];
  coverageScore: number | null;
  strategy: typeof BALANCED_SELECTION_STRATEGY | typeof LEGACY_SELECTION_STRATEGY;
  selectionVersion: 1 | typeof BALANCED_SELECTION_VERSION;
  usedFallback: boolean;
};

type SelectionOptions = {
  iterations?: number;
  reservePerDifficulty?: number;
  nowMs?: number;
  random?: () => number;
};

const DAY_MS = 86_400_000;

function randomUnit(random: () => number) {
  const value = random();
  return Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, value));
}

function exposureWeight(exposure: QuestionExposure | undefined, nowMs: number) {
  const count = Math.max(0, exposure?.presentationCount ?? 0);
  const ageDays = exposure?.lastPresentedAt == null
    ? 365
    : Math.max(0, (nowMs - exposure.lastPresentedAt) / DAY_MS);
  const frequencyBoost = 1 / Math.sqrt(1 + count);
  const recencyBoost = 0.4 + Math.min(1.6, ageDays / 30);
  return Math.max(0.01, frequencyBoost * recencyBoost);
}

function weightedOrder<T extends BalancedQuestion>(
  candidates: readonly T[],
  exposureByQuestionId: ReadonlyMap<number, QuestionExposure>,
  nowMs: number,
  random: () => number,
) {
  return candidates
    .map((question) => ({
      question,
      priority: -Math.log(randomUnit(random)) /
        exposureWeight(exposureByQuestionId.get(question.id), nowMs),
    }))
    .sort((left, right) => left.priority - right.priority)
    .map(({ question }) => question);
}

function topicFit<T extends BalancedQuestion>(questions: readonly T[]) {
  const counts = new Map<string, number>();
  for (const question of questions) counts.set(question.topic, (counts.get(question.topic) ?? 0) + 1);
  const plannedCount = Object.values(GENERAL_TOPIC_PLAN).reduce((sum, count) => sum + count, 0);
  const deviation = Object.entries(GENERAL_TOPIC_PLAN).reduce(
    (sum, [topic, expected]) => sum + Math.abs((counts.get(topic) ?? 0) - expected),
    0,
  );
  const unexpected = [...counts.entries()].reduce(
    (sum, [topic, count]) => sum + (topic in GENERAL_TOPIC_PLAN ? 0 : count),
    0,
  );
  return Math.max(0, 1 - (deviation + unexpected) / (plannedCount * 2));
}

function hasExactTopicPlan<T extends BalancedQuestion>(questions: readonly T[]) {
  const counts = new Map<string, number>();
  for (const question of questions) counts.set(question.topic, (counts.get(question.topic) ?? 0) + 1);
  if (counts.size !== Object.keys(GENERAL_TOPIC_PLAN).length) return false;
  return Object.entries(GENERAL_TOPIC_PLAN).every(
    ([topic, expected]) => counts.get(topic) === expected,
  );
}

function exposureHealth<T extends BalancedQuestion>(
  questions: readonly T[],
  exposureByQuestionId: ReadonlyMap<number, QuestionExposure>,
  nowMs: number,
) {
  if (questions.length === 0) return 0;
  let frequencyTotal = 0;
  let recencyTotal = 0;
  for (const question of questions) {
    const exposure = exposureByQuestionId.get(question.id);
    const count = Math.max(0, exposure?.presentationCount ?? 0);
    const ageDays = exposure?.lastPresentedAt == null
      ? 365
      : Math.max(0, (nowMs - exposure.lastPresentedAt) / DAY_MS);
    frequencyTotal += 1 / (1 + count);
    recencyTotal += Math.min(1, ageDays / 30);
  }
  return {
    frequency: frequencyTotal / questions.length,
    recency: recencyTotal / questions.length,
  };
}

export function calculateCoverageScore<T extends BalancedQuestion>(
  questions: readonly T[],
  exposureByQuestionId: ReadonlyMap<number, QuestionExposure>,
  nowMs = Date.now(),
) {
  const exposure = exposureHealth(questions, exposureByQuestionId, nowMs);
  if (typeof exposure === 'number') return 0;
  const score = topicFit(questions) * 50 + exposure.frequency * 35 + exposure.recency * 15;
  return Math.round(Math.max(0, Math.min(100, score)) * 100) / 100;
}

/**
 * Builds several valid difficulty/dedupe plans and chooses the least exposed,
 * closest-to-quota set. The legacy plan is returned when no valid set exists.
 */
export function selectBalancedQuestionPlan<T extends BalancedQuestion>(
  candidates: readonly T[],
  difficultyPlan: Readonly<Record<Difficulty, number>>,
  exposureByQuestionId: ReadonlyMap<number, QuestionExposure>,
  options: SelectionOptions = {},
): SelectionResult<T> | null {
  const iterations = Math.max(1, Math.min(200, options.iterations ?? 200));
  const reservePerDifficulty = options.reservePerDifficulty ?? 0;
  const nowMs = options.nowMs ?? Date.now();
  const random = options.random ?? Math.random;
  let best: { questions: T[]; coverageScore: number } | null = null;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const ordered = weightedOrder(candidates, exposureByQuestionId, nowMs, random);
    const questions = selectUniqueQuestionPlan(ordered, difficultyPlan, reservePerDifficulty);
    if (!questions) continue;
    if (!hasExactTopicPlan(questions)) continue;
    const coverageScore = calculateCoverageScore(questions, exposureByQuestionId, nowMs);
    if (!best || coverageScore > best.coverageScore) best = { questions, coverageScore };
  }

  if (best) {
    return {
      ...best,
      strategy: BALANCED_SELECTION_STRATEGY,
      selectionVersion: BALANCED_SELECTION_VERSION,
      usedFallback: false,
    };
  }

  const fallback = selectUniqueQuestionPlan(candidates, difficultyPlan, reservePerDifficulty);
  return fallback
    ? {
        questions: fallback,
        coverageScore: null,
        strategy: LEGACY_SELECTION_STRATEGY,
        selectionVersion: 1,
        usedFallback: true,
      }
    : null;
}
