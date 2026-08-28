import assert from 'node:assert/strict';
import { buildCandidateInsights, type CandidateInsightFact } from '../lib/candidate-insights.ts';

function fact(overrides: Partial<CandidateInsightFact> = {}): CandidateInsightFact {
  return {
    questionId: 1,
    questionKind: 'base',
    topic: 'Linux',
    dedupeKey: 'linux-permissions',
    scoreValue: 4,
    assigned: true,
    presented: true,
    resolved: true,
    correct: true,
    timedOut: false,
    answerOrigin: 'submitted',
    awardedScore: 4,
    elapsedSeconds: 8,
    ...overrides,
  };
}

const result = buildCandidateInsights([
  fact({ questionId: 1 }),
  fact({ questionId: 2 }),
  fact({ questionId: 3, correct: false, awardedScore: 0 }),
  fact({ questionId: 4, topic: 'Сети', dedupeKey: 'dns', correct: false, awardedScore: 0 }),
  fact({ questionId: 5, topic: 'Сети', dedupeKey: 'routing', correct: false, timedOut: true, answerOrigin: 'question_timeout', awardedScore: 0, elapsedSeconds: 30 }),
  fact({ questionId: 6, topic: 'Сети', dedupeKey: 'routing', correct: true }),
  fact({ questionId: 7, questionKind: 'additional', topic: 'Сети', dedupeKey: 'routing', scoreValue: 2, correct: true, awardedScore: 2 }),
]);

const linux = result.topics.find((topic) => topic.topic === 'Linux');
assert(linux);
assert.equal(linux.classification, 'normal');
assert.equal(linux.base.accuracy, 66.7);
assert.equal(linux.additional.resolvedCount, 0);
const network = result.topics.find((topic) => topic.topic === 'Сети');
assert(network);
assert.equal(network.classification, 'review');
assert.equal(network.additional.correctCount, 1);
assert.equal(result.checkAreas.length, 3);
assert.equal(result.checkAreas[0].lostBaseScore, 4);
assert.deepEqual(result.telegramProfile.strongTopics, []);
assert.deepEqual(new Set(result.telegramProfile.checkAreas), new Set(['Linux', 'Сети']));

const strong = buildCandidateInsights([
  fact({ questionId: 10, topic: 'ИБ' }),
  fact({ questionId: 11, topic: 'ИБ' }),
  fact({ questionId: 12, topic: 'ИБ' }),
]);
assert.equal(strong.topics[0].classification, 'strong');
assert.deepEqual(strong.telegramProfile.strongTopics, ['ИБ']);

console.log('Candidate insight tests passed.');
