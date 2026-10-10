import { calculateAccuracy, type QuestionKind } from './scoring.ts';
import { DIFFICULTIES, type Difficulty } from './test-config.ts';

export type AttemptStatisticBucket = {
  questionKind: QuestionKind;
  difficulty: Difficulty;
  topic: string;
  answeredCount: number;
  correctCount: number;
  timeoutCount: number;
  elapsedSeconds: number;
  measuredCount: number;
};

export type QuestionGroupStats = {
  assignedCount: number;
  presentedCount: number;
  resolvedCount: number;
  correctCount: number;
  incorrectCount: number;
  timeoutCount: number;
  earnedScore: number;
  penaltyScore: number;
  maxEarnableScore: number;
};

export type AttemptBreakdownFact = {
  questionKind: QuestionKind;
  assigned: boolean;
  presented: boolean;
  resolved: boolean;
  correct: boolean;
  timedOut: boolean;
  awardedScore: number;
  penaltyScore?: number;
  scoreValue: number;
};

export type AttemptFactsValidationOptions = {
  expectedBaseAssigned: number;
  maxAdditionalAssigned: number;
  expectedBaseMaxScore: number;
  attemptScore: number;
  scoringVersion?: number;
};

function emptyQuestionGroupStats(): QuestionGroupStats {
  return {
    assignedCount: 0,
    presentedCount: 0,
    resolvedCount: 0,
    correctCount: 0,
    incorrectCount: 0,
    timeoutCount: 0,
    earnedScore: 0,
    penaltyScore: 0,
    maxEarnableScore: 0,
  };
}

/**
 * Summarizes persisted assignment/presentation/answer facts. For legacy rows
 * callers may pass only facts they can prove; the payload then marks the
 * resulting numeric values as lower bounds via statisticsCompleteness.
 */
export function summarizeAttemptBreakdown(facts: readonly AttemptBreakdownFact[]) {
  const result = {
    base: emptyQuestionGroupStats(),
    additional: emptyQuestionGroupStats(),
  };
  for (const fact of facts) {
    const group = result[fact.questionKind];
    group.assignedCount += fact.assigned ? 1 : 0;
    group.presentedCount += fact.presented ? 1 : 0;
    group.resolvedCount += fact.resolved ? 1 : 0;
    group.correctCount += fact.resolved && fact.correct ? 1 : 0;
    group.timeoutCount += fact.resolved && fact.timedOut ? 1 : 0;
    group.incorrectCount += fact.resolved && !fact.correct && !fact.timedOut ? 1 : 0;
    group.earnedScore += fact.resolved ? Math.max(0, fact.awardedScore) : 0;
    group.penaltyScore += fact.resolved ? Math.max(0, fact.penaltyScore ?? 0) : 0;
    group.maxEarnableScore += fact.assigned ? Math.max(0, fact.scoreValue) : 0;
  }
  return result;
}

export function validateAttemptFacts(
  facts: readonly AttemptBreakdownFact[],
  options: AttemptFactsValidationOptions,
) {
  const breakdown = summarizeAttemptBreakdown(facts);
  const errors: string[] = [];
  if (facts.some((fact) => (
    !Number.isInteger(fact.scoreValue) || fact.scoreValue <= 0
    || !Number.isInteger(fact.awardedScore) || fact.awardedScore < 0
    || fact.awardedScore > fact.scoreValue
    || !Number.isInteger(fact.penaltyScore ?? 0) || (fact.penaltyScore ?? 0) < 0
  ))) {
    errors.push('score_fact_invalid');
  }
  const scoringVersion = options.scoringVersion ?? 2;
  if (scoringVersion === 3) {
    if (facts.some((fact) => {
      const expectedAward = fact.resolved && fact.correct ? fact.scoreValue : 0;
      const expectedPenalty = fact.resolved && fact.presented && !fact.correct
        ? fact.scoreValue / (fact.questionKind === 'base' ? 2 : 1)
        : 0;
      return fact.awardedScore !== expectedAward
        || (fact.penaltyScore ?? 0) !== expectedPenalty;
    })) errors.push('scoring_v3_fact_mismatch');
  } else if (facts.some((fact) => (fact.penaltyScore ?? 0) !== 0)) {
    errors.push('legacy_penalty_nonzero');
  }
  const validateGroup = (name: 'base' | 'additional') => {
    const group = breakdown[name];
    if (group.presentedCount > group.assignedCount) errors.push(`${name}_presented_gt_assigned`);
    if (group.resolvedCount > group.assignedCount) errors.push(`${name}_resolved_gt_assigned`);
    if (
      group.correctCount + group.incorrectCount + group.timeoutCount !== group.resolvedCount
    ) {
      errors.push(`${name}_outcome_partition_invalid`);
    }
  };
  validateGroup('base');
  validateGroup('additional');
  if (breakdown.base.assignedCount !== options.expectedBaseAssigned) {
    errors.push('base_assigned_invalid');
  }
  if (breakdown.additional.assignedCount > options.maxAdditionalAssigned) {
    errors.push('additional_assigned_exceeded');
  }
  if (breakdown.base.maxEarnableScore !== options.expectedBaseMaxScore) {
    errors.push('base_max_score_invalid');
  }
  const earned = breakdown.base.earnedScore + breakdown.additional.earnedScore;
  const penalty = breakdown.base.penaltyScore + breakdown.additional.penaltyScore;
  const expectedScore = scoringVersion === 3
    ? Math.max(0, Math.min(options.expectedBaseMaxScore, earned - penalty))
    : earned;
  if (expectedScore !== options.attemptScore) {
    errors.push('awarded_score_sum_mismatch');
  }
  return { valid: errors.length === 0, errors, breakdown };
}

export function summarizeAttemptStatistics(buckets: readonly AttemptStatisticBucket[]) {
  const byDifficulty = new Map<Difficulty, { answeredCount: number; correctCount: number }>();
  const byTopic = new Map<string, { answeredCount: number; correctCount: number }>();
  let timeoutCount = 0;
  let elapsedSeconds = 0;
  let measuredAnswers = 0;
  let baseAnsweredCount = 0;
  let baseCorrectCount = 0;
  let additionalAnsweredCount = 0;
  let additionalCorrectCount = 0;

  for (const bucket of buckets) {
    const difficulty = byDifficulty.get(bucket.difficulty) ?? {
      answeredCount: 0,
      correctCount: 0,
    };
    difficulty.answeredCount += bucket.answeredCount;
    difficulty.correctCount += bucket.correctCount;
    byDifficulty.set(bucket.difficulty, difficulty);

    const topic = byTopic.get(bucket.topic) ?? { answeredCount: 0, correctCount: 0 };
    topic.answeredCount += bucket.answeredCount;
    topic.correctCount += bucket.correctCount;
    byTopic.set(bucket.topic, topic);

    timeoutCount += bucket.timeoutCount;
    elapsedSeconds += bucket.measuredCount > 0 ? bucket.elapsedSeconds : 0;
    measuredAnswers += bucket.measuredCount;
    if (bucket.questionKind === 'base') {
      baseAnsweredCount += bucket.answeredCount;
      baseCorrectCount += bucket.correctCount;
    } else {
      additionalAnsweredCount += bucket.answeredCount;
      additionalCorrectCount += bucket.correctCount;
    }
  }

  return {
    timeoutCount,
    averageAnswerSeconds: measuredAnswers ? Math.round(elapsedSeconds / measuredAnswers) : 0,
    baseAnsweredCount,
    baseCorrectCount,
    additionalAnsweredCount,
    additionalCorrectCount,
    difficultyStats: DIFFICULTIES.flatMap((difficulty) => {
      const stats = byDifficulty.get(difficulty);
      return stats
        ? [{
            difficulty,
            answeredCount: stats.answeredCount,
            correctCount: stats.correctCount,
            accuracy: calculateAccuracy(stats.correctCount, stats.answeredCount - stats.correctCount),
          }]
        : [];
    }),
    topicStats: [...byTopic]
      .sort(([left], [right]) => left.localeCompare(right, 'ru-RU'))
      .map(([topic, stats]) => ({
        topic,
        answeredCount: stats.answeredCount,
        correctCount: stats.correctCount,
        accuracy: calculateAccuracy(stats.correctCount, stats.answeredCount - stats.correctCount),
      })),
  };
}
