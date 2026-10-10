import {
  BASE_QUESTION_COUNT,
  DIFFICULTIES,
  LEGACY_PASS_ACCURACY,
  LEGACY_SCORING_VERSION,
  SCORING_VERSION,
  TEST_CONFIG,
} from './test-config.ts';

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

/** @deprecated Additive v2 only. Use ledger totals with calculateNetScore for v3. */
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

/** Correctness includes deadline handling; shown timeouts arrive as correct=false. */
export function calculatePenalty(
  scoreValue: number,
  questionKind: QuestionKind,
  correct: boolean,
  presented: boolean,
  scoringVersion: number = SCORING_VERSION,
) {
  if (scoringVersion === LEGACY_SCORING_VERSION) return 0;
  if (scoringVersion !== SCORING_VERSION) throw new RangeError('Unsupported scoring version.');
  if (!Number.isSafeInteger(scoreValue) || scoreValue <= 0) {
    throw new RangeError('Question score must be a positive safe integer.');
  }
  if (correct || !presented) return 0;
  const multiplier = questionKind === 'base'
    ? TEST_CONFIG.scoringPolicy.baseIncorrectPenaltyMultiplier
    : TEST_CONFIG.scoringPolicy.additionalIncorrectPenaltyMultiplier;
  const penalty = scoreValue * multiplier;
  if (!Number.isSafeInteger(penalty)) throw new RangeError('Penalty must be a safe integer.');
  return penalty;
}

/** Keep earned and penalty totals independently; never clamp a running net balance. */
export function calculateNetScore(earnedScore: number, penaltyScore: number, baseMaxScore: number) {
  if (
    !Number.isSafeInteger(earnedScore) || earnedScore < 0
    || !Number.isSafeInteger(penaltyScore) || penaltyScore < 0
    || !Number.isSafeInteger(baseMaxScore) || baseMaxScore <= 0
  ) {
    throw new RangeError('Score totals must be nonnegative safe integers with a positive maximum.');
  }
  return Math.max(0, Math.min(baseMaxScore, earnedScore - penaltyScore));
}

export function calculateAccuracy(correctCount: number, wrongCount: number) {
  const answeredCount = correctCount + wrongCount;
  return answeredCount ? Math.round((correctCount / answeredCount) * 100) : 0;
}

export function calculateVerdict(
  score: number,
  accuracy: number,
  baseCorrectCount?: number,
  scoringVersion: number = SCORING_VERSION,
): Verdict {
  if (!Number.isFinite(score)) return 'FAIL';
  const eligibleForPass = scoringVersion === LEGACY_SCORING_VERSION
    ? accuracy >= LEGACY_PASS_ACCURACY
    : scoringVersion === SCORING_VERSION
      && Number.isInteger(baseCorrectCount)
      && baseCorrectCount! >= TEST_CONFIG.verdict.passBaseCorrect
      && baseCorrectCount! <= BASE_QUESTION_COUNT;
  if (score >= TEST_CONFIG.verdict.passScore && eligibleForPass) {
    return 'PASS';
  }
  if (score >= TEST_CONFIG.verdict.reviewScore) return 'REVIEW';
  return 'FAIL';
}
