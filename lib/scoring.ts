import { DIFFICULTIES, TEST_CONFIG } from './test-config.ts';

export type Verdict = 'PASS' | 'REVIEW' | 'FAIL';
export type QuestionKind = 'base' | 'additional';

export function questionScoreValue(unitWeight: number, questionKind: QuestionKind) {
  const multiplier = questionKind === 'base'
    ? TEST_CONFIG.baseQuestionMultiplier
    : TEST_CONFIG.additionalQuestionMultiplier;
  return unitWeight * multiplier;
}

export const BASE_MAX_SCORE = DIFFICULTIES.reduce(
  (total, difficulty) => total
    + TEST_CONFIG.plan[difficulty]
      * questionScoreValue(TEST_CONFIG.weights[difficulty], 'base'),
  0,
);

export function calculateScore(
  previousScore: number,
  questionValue: number,
  baseMaxScore: number,
  correct: boolean,
) {
  const boundedPreviousScore = Math.max(0, Math.min(baseMaxScore, previousScore));
  if (!correct) return boundedPreviousScore;
  return Math.min(baseMaxScore, boundedPreviousScore + questionValue);
}

export function calculateAccuracy(correctCount: number, wrongCount: number) {
  const answeredCount = correctCount + wrongCount;
  return answeredCount ? Math.round((correctCount / answeredCount) * 100) : 0;
}

export function calculateVerdict(
  score: number,
  accuracy: number,
): Verdict {
  if (
    score >= TEST_CONFIG.verdict.passScore &&
    accuracy >= TEST_CONFIG.verdict.passAccuracy
  ) {
    return 'PASS';
  }
  if (score >= TEST_CONFIG.verdict.reviewScore) return 'REVIEW';
  return 'FAIL';
}
