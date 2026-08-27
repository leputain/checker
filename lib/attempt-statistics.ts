import { calculateAccuracy } from './scoring.ts';
import { DIFFICULTIES, type Difficulty } from './test-config.ts';

export type AttemptStatisticBucket = {
  difficulty: Difficulty;
  topic: string;
  answeredCount: number;
  correctCount: number;
  timeoutCount: number;
  elapsedSeconds: number;
  measuredCount: number;
};

export function summarizeAttemptStatistics(buckets: readonly AttemptStatisticBucket[]) {
  const byDifficulty = new Map<Difficulty, { answeredCount: number; correctCount: number }>();
  const byTopic = new Map<string, { answeredCount: number; correctCount: number }>();
  let timeoutCount = 0;
  let elapsedSeconds = 0;
  let measuredAnswers = 0;

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
    elapsedSeconds += bucket.elapsedSeconds;
    measuredAnswers += bucket.measuredCount;
  }

  return {
    timeoutCount,
    averageAnswerSeconds: measuredAnswers ? Math.round(elapsedSeconds / measuredAnswers) : 0,
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
