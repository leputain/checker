import { TEST_CONFIG } from './test-config.ts';

export type Verdict = 'PASS' | 'REVIEW' | 'FAIL';

export function calculateScore(
  previousScore: number,
  questionWeight: number,
  baseMaxScore: number,
  correct: boolean,
) {
  if (!correct) return previousScore;
  return Math.min(baseMaxScore, previousScore + questionWeight);
}

export function calculateAccuracy(correctCount: number, wrongCount: number) {
  const answeredCount = correctCount + wrongCount;
  return answeredCount ? Math.round((correctCount / answeredCount) * 100) : 0;
}

export function calculateVerdict(
  score: number,
  baseMaxScore: number,
  accuracy: number,
): Verdict {
  const scorePercent = baseMaxScore > 0 ? (score / baseMaxScore) * 100 : 0;
  if (
    scorePercent >= TEST_CONFIG.verdict.passScorePercent &&
    accuracy >= TEST_CONFIG.verdict.passAccuracy
  ) {
    return 'PASS';
  }
  if (
    scorePercent >= TEST_CONFIG.verdict.reviewScorePercent ||
    accuracy >= TEST_CONFIG.verdict.reviewAccuracy
  ) {
    return 'REVIEW';
  }
  return 'FAIL';
}
