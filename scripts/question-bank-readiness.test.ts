import assert from 'node:assert/strict';
import {
  evaluateQuestionBankReadiness,
  type ReadinessQuestion,
} from '../lib/question-bank-readiness.ts';
import { DIFFICULTIES, GENERAL_TOPIC_PLAN, TEST_CONFIG, type Difficulty } from '../lib/test-config.ts';

const topics = Object.keys(GENERAL_TOPIC_PLAN);
let nextId = 1;

function entry(
  topic: string,
  difficulty: Difficulty,
  dedupeKey = `concept:${nextId}`,
): ReadinessQuestion {
  return { id: nextId++, topic, difficulty, dedupeKey, active: true };
}

function readyBank() {
  nextId = 1;
  return topics.flatMap((topic) => DIFFICULTIES.flatMap((difficulty) => (
    Array.from({ length: 8 }, () => entry(topic, difficulty))
  )));
}

const ready = evaluateQuestionBankReadiness(readyBank());
assert.equal(ready.legacy.status, 'READY');
assert.equal(ready.balanced.status, 'READY');
assert(ready.balanced.baseFeasible);

const linuxLimitedSource = readyBank();
let retainedLinux = 0;
const linuxLimited = linuxLimitedSource.filter((question) => {
  if (question.topic !== 'Linux') return true;
  retainedLinux += 1;
  return retainedLinux <= 4;
});
const notReadyTopic = evaluateQuestionBankReadiness(linuxLimited);
assert.equal(notReadyTopic.legacy.status, 'READY', 'topic quota must not affect the legacy selector');
assert.equal(notReadyTopic.balanced.status, 'NOT READY');
assert.deepEqual(notReadyTopic.balanced.reasonCodes, ['topic_difficulty_dedupe_plan_infeasible']);

let retainedHard = 0;
const hardLimited = readyBank().filter((question) => {
  if (question.difficulty !== 'hard') return true;
  retainedHard += 1;
  return retainedHard <= 6;
});
const notReadyDifficulty = evaluateQuestionBankReadiness(hardLimited);
assert.equal(notReadyDifficulty.legacy.status, 'NOT READY');
assert.equal(notReadyDifficulty.balanced.status, 'NOT READY');

// Each topic has five concepts and each difficulty has enough candidates in
// isolation. Medium and hard nevertheless share the same seven dedupe groups,
// so their combined quota of fourteen cannot be satisfied.
nextId = 1;
const dedupeCollision: ReadinessQuestion[] = [];
for (let groupIndex = 0; groupIndex < 20; groupIndex += 1) {
  const topic = topics[Math.floor(groupIndex / 5)];
  const key = `collision:${groupIndex}`;
  const capabilities: Difficulty[] = groupIndex < 7
    ? ['medium', 'hard']
    : groupIndex < 12
      ? ['easy']
      : groupIndex === 12
        ? ['expert']
        : ['easy', 'expert'];
  for (const difficulty of capabilities) dedupeCollision.push(entry(topic, difficulty, key));
}
const collisionReport = evaluateQuestionBankReadiness(dedupeCollision);
for (const difficulty of DIFFICULTIES) {
  assert(
    collisionReport.difficulty[difficulty].unique >= TEST_CONFIG.plan[difficulty],
    `independent ${difficulty} count should look sufficient`,
  );
}
for (const topic of topics) assert((collisionReport.topics[topic]?.unique ?? 0) >= 5);
assert.equal(collisionReport.balanced.status, 'NOT READY', 'global dedupe must be solved simultaneously');

nextId = 1;
const exactBase: ReadinessQuestion[] = [];
const difficultySlots = DIFFICULTIES.flatMap((difficulty) => (
  Array.from({ length: TEST_CONFIG.plan[difficulty] }, () => difficulty)
));
difficultySlots.forEach((difficulty, index) => {
  exactBase.push(entry(topics[index % topics.length], difficulty));
});
const lowReserve = evaluateQuestionBankReadiness(exactBase);
assert.equal(lowReserve.balanced.status, 'WARNING');
assert(lowReserve.warnings.some((warning) => warning.startsWith('balanced_low_remedial_reserve:')));

const withUnexpectedTopic = readyBank();
withUnexpectedTopic.push(entry('Наблюдаемость', 'hard'));
const unexpected = evaluateQuestionBankReadiness(withUnexpectedTopic);
assert.equal(unexpected.legacy.status, 'READY');
assert.equal(unexpected.balanced.status, 'READY');
assert.deepEqual(unexpected.unexpectedTopics, ['Наблюдаемость']);

console.log('question bank readiness tests: PASS');
