import assert from 'node:assert/strict';
import {
  BALANCED_SELECTION_STRATEGY,
  calculateCoverageScore,
  GENERAL_TOPIC_PLAN,
  selectBalancedQuestionPlan,
  type BalancedQuestion,
  type QuestionExposure,
} from '../lib/balanced-selection.ts';
import { TEST_CONFIG } from '../lib/test-config.ts';

let id = 0;
const questions: BalancedQuestion[] = [];
for (const [difficulty, count] of Object.entries(TEST_CONFIG.plan)) {
  for (const topic of Object.keys(GENERAL_TOPIC_PLAN)) {
    for (let index = 0; index < count + 3; index += 1) {
      id += 1;
      questions.push({ id, difficulty: difficulty as BalancedQuestion['difficulty'], topic, dedupe_key: `q:${id}` });
    }
  }
}

const exposures = new Map<number, QuestionExposure>(questions.map((question) => [
  question.id,
  { presentationCount: question.id % 5, lastPresentedAt: Date.UTC(2026, 7, 1) },
]));

let state = 42;
const random = () => {
  state = (state * 1_664_525 + 1_013_904_223) >>> 0;
  return state / 2 ** 32;
};

const result = selectBalancedQuestionPlan(questions, TEST_CONFIG.plan, exposures, {
  iterations: 200,
  nowMs: Date.UTC(2026, 7, 28),
  random,
});
assert(result);
assert.equal(result.strategy, BALANCED_SELECTION_STRATEGY);
assert.equal(result.questions.length, 20);
assert.equal(new Set(result.questions.map((question) => question.dedupe_key)).size, 20);
for (const [difficulty, expected] of Object.entries(TEST_CONFIG.plan)) {
  assert.equal(result.questions.filter((question) => question.difficulty === difficulty).length, expected);
}
for (const [topic, expected] of Object.entries(GENERAL_TOPIC_PLAN)) {
  assert.equal(result.questions.filter((question) => question.topic === topic).length, expected);
}

const freshIds = new Set(questions.slice(0, 20).map((question) => question.id));
const skewedExposure = new Map<number, QuestionExposure>(questions.map((question) => [
  question.id,
  freshIds.has(question.id)
    ? { presentationCount: 0, lastPresentedAt: null }
    : { presentationCount: 50, lastPresentedAt: Date.UTC(2026, 7, 27) },
]));
assert(
  calculateCoverageScore(result.questions, skewedExposure, Date.UTC(2026, 7, 28)) >= 0,
  'Coverage score stays bounded for skewed exposure data.',
);

const oneSlotPlan = { easy: 1, medium: 0, hard: 0, expert: 0 } as const;
const lowExposure = selectBalancedQuestionPlan(
  [
    { id: 10_001, difficulty: 'easy', topic: 'Сети', dedupe_key: 'fresh' },
    { id: 10_002, difficulty: 'easy', topic: 'Сети', dedupe_key: 'stale' },
  ],
  oneSlotPlan,
  new Map([
    [10_001, { presentationCount: 0, lastPresentedAt: null }],
    [10_002, { presentationCount: 100, lastPresentedAt: Date.UTC(2026, 7, 27) }],
  ]),
  { iterations: 20, random: () => 0.5, nowMs: Date.UTC(2026, 7, 28) },
);
assert(lowExposure?.usedFallback, 'A profile that cannot satisfy all topic quotas falls back safely.');

const impossible = selectBalancedQuestionPlan([], TEST_CONFIG.plan, new Map(), { iterations: 2 });
assert.equal(impossible, null);

console.log('Balanced selection tests passed.');
