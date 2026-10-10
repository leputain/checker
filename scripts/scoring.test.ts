import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  BASE_MAX_SCORE,
  calculateAccuracy,
  calculateNetScore,
  calculatePenalty,
  calculateScore,
  calculateVerdict,
  questionScoreValue,
} from '../lib/scoring.ts';
import {
  BASE_QUESTION_COUNT,
  BALANCED_TEST_CONFIG_ID,
  BALANCED_TEST_CONFIG_JSON,
  DIFFICULTIES,
  LEGACY_SCORING_VERSION,
  TEST_CONFIG,
  TEST_CONFIG_ID,
  TEST_CONFIG_JSON,
} from '../lib/test-config.ts';
import {
  summarizeAttemptBreakdown,
  summarizeAttemptStatistics,
  validateAttemptFacts,
} from '../lib/attempt-statistics.ts';

assert.equal(BASE_QUESTION_COUNT, 20);
assert.equal(BASE_MAX_SCORE, 100);
assert.equal(TEST_CONFIG.baseQuestionMultiplier, 2);
assert.equal(TEST_CONFIG.additionalQuestionMultiplier, 1);
assert.equal(TEST_CONFIG.maxAdditionalQuestions, 10);
assert.equal(createHash('sha256').update(TEST_CONFIG_JSON).digest('hex'), TEST_CONFIG_ID);
assert.equal(
  createHash('sha256').update(BALANCED_TEST_CONFIG_JSON).digest('hex'),
  BALANCED_TEST_CONFIG_ID,
);

const expectedValues = {
  easy: { base: 2, additional: 1 },
  medium: { base: 4, additional: 2 },
  hard: { base: 6, additional: 3 },
  expert: { base: 20, additional: 10 },
} as const;

for (const difficulty of DIFFICULTIES) {
  for (const questionKind of ['base', 'additional'] as const) {
    const value = questionScoreValue(TEST_CONFIG.weights[difficulty], questionKind);
    assert.equal(value, expectedValues[difficulty][questionKind]);
    assert.equal(Number.isInteger(value), true);
  }
}

assert.equal(calculateVerdict(80, 70, undefined, LEGACY_SCORING_VERSION), 'PASS');
assert.equal(calculateVerdict(100, 70, undefined, LEGACY_SCORING_VERSION), 'PASS');
assert.equal(calculateVerdict(79, 100, undefined, LEGACY_SCORING_VERSION), 'REVIEW');
assert.equal(calculateVerdict(80, 69, undefined, LEGACY_SCORING_VERSION), 'REVIEW');
assert.equal(calculateVerdict(80, 70, 17), 'PASS');
assert.equal(calculateVerdict(80, 0, 17), 'PASS', 'v3 uses base correct count rather than diluted overall accuracy');
assert.equal(calculateVerdict(100, 100, 16), 'REVIEW');
assert.equal(calculateVerdict(79, 100, 20), 'REVIEW');
assert.equal(calculateVerdict(100, 100), 'REVIEW', 'missing base counts must not produce PASS');
assert.equal(calculateVerdict(100, 100, 21), 'REVIEW', 'invalid base count must not produce PASS');
assert.equal(calculateVerdict(100, 100, 17.5), 'REVIEW');
assert.equal(calculateVerdict(100, 100, 20, 99), 'REVIEW', 'unknown scoring versions fail closed for PASS');
assert.equal(calculateVerdict(Number.NaN, 100, 20), 'FAIL');
assert.equal(calculateVerdict(50, 50), 'REVIEW');
assert.equal(calculateVerdict(49, 100), 'FAIL');
assert.equal(calculateVerdict(0, 100), 'FAIL');

const perfectBaseScore = DIFFICULTIES.reduce(
  (score, difficulty) => score
    + TEST_CONFIG.plan[difficulty]
      * questionScoreValue(TEST_CONFIG.weights[difficulty], 'base'),
  0,
);
assert.equal(perfectBaseScore, 100);

const hardRecovery = calculateScore(
  perfectBaseScore - questionScoreValue(TEST_CONFIG.weights.hard, 'base'),
  questionScoreValue(TEST_CONFIG.weights.hard, 'additional'),
  BASE_MAX_SCORE,
  true,
);
assert.equal(hardRecovery, 97);

const expertRecovery = calculateScore(
  perfectBaseScore - questionScoreValue(TEST_CONFIG.weights.expert, 'base'),
  questionScoreValue(TEST_CONFIG.weights.expert, 'additional'),
  BASE_MAX_SCORE,
  true,
);
assert.equal(expertRecovery, 90);
assert.equal(
  calculateScore(
    perfectBaseScore - questionScoreValue(TEST_CONFIG.weights.expert, 'base'),
    questionScoreValue(TEST_CONFIG.weights.expert, 'additional'),
    BASE_MAX_SCORE,
    false,
  ),
  80,
);
assert.equal(calculateScore(100, 10, BASE_MAX_SCORE, true), 100);
assert.equal(calculateAccuracy(20, 2), 91);

for (const difficulty of DIFFICULTIES) {
  for (const questionKind of ['base', 'additional'] as const) {
    const value = questionScoreValue(TEST_CONFIG.weights[difficulty], questionKind);
    assert.equal(calculatePenalty(value, questionKind, false, true), TEST_CONFIG.weights[difficulty]);
    assert.equal(calculatePenalty(value, questionKind, true, true), 0);
    assert.equal(calculatePenalty(value, questionKind, false, false), 0, 'unshown timeouts have no penalty');
    assert.equal(calculatePenalty(value, questionKind, false, true, LEGACY_SCORING_VERSION), 0);
  }
}
assert.throws(() => calculatePenalty(3, 'base', false, true), RangeError);
assert.throws(() => calculatePenalty(6, 'base', false, true, 99), RangeError);
assert.throws(() => calculateNetScore(-1, 0, 100), RangeError);
assert.throws(() => calculateNetScore(10, Number.NaN, 100), RangeError);
assert.equal(calculateNetScore(0, 10, 100), 0);
assert.equal(calculateNetScore(20, 10, 100), 10, 'an early penalty survives a displayed zero balance');
assert.equal(calculateNetScore(150, 10, 100), 100);
assert.equal(calculateNetScore(10, 10, 100), 0);

const ledgerFacts = [
  { scoreValue: 20, kind: 'base' as const, correct: false },
  { scoreValue: 20, kind: 'base' as const, correct: true },
  { scoreValue: 10, kind: 'additional' as const, correct: true },
];
for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
  const totals = order.reduce((sum, index) => {
    const fact = ledgerFacts[index];
    return {
      earned: sum.earned + (fact.correct ? fact.scoreValue : 0),
      penalty: sum.penalty + calculatePenalty(fact.scoreValue, fact.kind, fact.correct, true),
    };
  }, { earned: 0, penalty: 0 });
  assert.equal(calculateNetScore(totals.earned, totals.penalty, 100), 20, 'ledger score is order independent');
}

// The three formerly identical 90s: expert mistake, five medium mistakes,
// and seven mixed mistakes. All have base earned80, recovery10 and penalty10.
for (const [baseCorrect, verdict] of [[19, 'PASS'], [15, 'REVIEW'], [13, 'REVIEW']] as const) {
  const score = calculateNetScore(80 + 10, 10, 100);
  assert.equal(score, 80);
  assert.equal(calculateVerdict(score, 95, baseCorrect), verdict);
}
assert.equal(calculateNetScore(80, 10 + 10, 100), 60, 'expert base and remedial errors both retain their penalties');

const answerStatistics = summarizeAttemptStatistics([
  {
    questionKind: 'base',
    difficulty: 'easy',
    topic: 'Сети',
    answeredCount: 2,
    correctCount: 1,
    timeoutCount: 1,
    elapsedSeconds: 40,
    measuredCount: 2,
  },
  {
    questionKind: 'additional',
    difficulty: 'medium',
    topic: 'Linux',
    answeredCount: 1,
    correctCount: 0,
    timeoutCount: 1,
    elapsedSeconds: 0,
    measuredCount: 0,
  },
]);
assert.equal(answerStatistics.timeoutCount, 2);
assert.equal(answerStatistics.baseAnsweredCount, 2);
assert.equal(answerStatistics.baseCorrectCount, 1);
assert.equal(answerStatistics.additionalAnsweredCount, 1);
assert.equal(answerStatistics.additionalCorrectCount, 0);
assert.equal(
  answerStatistics.averageAnswerSeconds,
  20,
  'questions skipped at the total deadline must not reduce the measured average',
);
assert.deepEqual(answerStatistics.difficultyStats, [
  { difficulty: 'easy', answeredCount: 2, correctCount: 1, accuracy: 50 },
  { difficulty: 'medium', answeredCount: 1, correctCount: 0, accuracy: 0 },
]);
assert.deepEqual(answerStatistics.topicStats, [
  { topic: 'Сети', answeredCount: 2, correctCount: 1, accuracy: 50 },
  { topic: 'Linux', answeredCount: 1, correctCount: 0, accuracy: 0 },
]);
assert.equal(summarizeAttemptStatistics([
  {
    questionKind: 'base',
    difficulty: 'easy',
    topic: 'Linux',
    answeredCount: 1,
    correctCount: 1,
    timeoutCount: 0,
    elapsedSeconds: 5,
    measuredCount: 1,
  },
  {
    questionKind: 'base',
    difficulty: 'easy',
    topic: 'Linux',
    answeredCount: 1,
    correctCount: 0,
    timeoutCount: 1,
    elapsedSeconds: 30,
    measuredCount: 0,
  },
]).averageAnswerSeconds, 5, 'timeout duration must not pollute submitted-answer timing');

const exactFacts = [
  {
    questionKind: 'base',
    assigned: true,
    presented: true,
    resolved: true,
    correct: true,
    timedOut: false,
    awardedScore: 6,
    scoreValue: 6,
  },
  {
    questionKind: 'base',
    assigned: true,
    presented: false,
    resolved: true,
    correct: false,
    timedOut: true,
    awardedScore: 0,
    scoreValue: 4,
  },
  {
    questionKind: 'additional',
    assigned: true,
    presented: false,
    resolved: false,
    correct: false,
    timedOut: false,
    awardedScore: 0,
    scoreValue: 3,
  },
] as const;
assert.deepEqual(summarizeAttemptBreakdown(exactFacts), {
  base: {
    assignedCount: 2,
    presentedCount: 1,
    resolvedCount: 2,
    correctCount: 1,
    incorrectCount: 0,
    timeoutCount: 1,
    earnedScore: 6,
    penaltyScore: 0,
    maxEarnableScore: 10,
  },
  additional: {
    assignedCount: 1,
    presentedCount: 0,
    resolvedCount: 0,
    correctCount: 0,
    incorrectCount: 0,
    timeoutCount: 0,
    earnedScore: 0,
    penaltyScore: 0,
    maxEarnableScore: 3,
  },
});
assert.equal(validateAttemptFacts(exactFacts, {
  expectedBaseAssigned: 2,
  maxAdditionalAssigned: 1,
  expectedBaseMaxScore: 10,
  attemptScore: 6,
}).valid, true);
assert.deepEqual(validateAttemptFacts(exactFacts, {
  expectedBaseAssigned: 20,
  maxAdditionalAssigned: 10,
  expectedBaseMaxScore: 100,
  attemptScore: 6,
}).errors, ['base_assigned_invalid', 'base_max_score_invalid']);

console.log('scoring tests: PASS');
